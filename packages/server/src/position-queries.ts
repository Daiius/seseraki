/**
 * 局面検索（prd/10 §5・§6.2・prd/14 §6.3）の読み取り。ログインの経路。
 *
 * 🔒 **各関数は tx（ユーザーとして開いたトランザクション。`user-tx.ts`）と所有者を引数に取り、
 * 所有者の棋譜だけを探す**（prd/14 §4）。局面索引（`kifu_positions`）は `ownerId` を親の写しとして
 * 持ち、索引も `(ownerId, 局面ハッシュ)` なので、`kifus` を引く前に所有者で絞れる（prd/14 §6.3）。
 * 他人の局面しか無い局面は「無い」（null → 呼び出し側で 404）。
 * ⚠ グローバルの `db` を import しない（`db-import-boundary.test.ts` が検査する）。
 */
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, not, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  createInitialState,
  positionDiff,
  positionSfen,
  type PositionDiff,
  type PositionKey,
} from 'shared';
import type { Tx } from './db/index.js';
import { kifuPositions, kifus } from './db/schema.js';
import { playedOrCreatedAt } from './kifu-list-query.js';
import { hashOf, samePosition, sameSideLayout, sfenOfRow } from './positions.js';

/** 局面検索の起点。`pos` 未指定ならここから辿る（prd/10 §6.2） */
export const INITIAL_SFEN = positionSfen(createInitialState());

/**
 * 1 つの局面について返す到達行の上限。
 * ⚠ **切ったことは `total` / `hasMore` で必ず知らせる**（prd/10 §6.2）。初期局面は
 * 全棋譜が通るので、棋譜が増えれば必ずここに当たる。
 */
export const POSITION_GAMES_LIMIT = 200;

/**
 * 近い局面の探索で読み出す行の上限。手数帯で絞った後の行数なので、
 * 数百局なら普通は数千行で収まる。⚠ **当たったら `truncated` で知らせる**。
 */
export const SIMILAR_SCAN_LIMIT = 20000;

/**
 * 主体側の検索（`/positions/subject`）で読み出す行の上限（prd/14 §6.3）。
 *
 * 照合（片側の配置）をアプリ側でするため、SQL で `limit` をかけられず、一致した行を全部読む。
 * 序盤の配置は 1 人 3,000 局でもほぼ全局に一致し、しかも相手だけが指している間は同じ配置が
 * 続くので 1 局で数行に当たる——上限が無いと 1 リクエストで数万行を読んでメインスレッドで照合する。
 * 3,000 局 × 数行に余裕を持たせ、近い局面の探索（`SIMILAR_SCAN_LIMIT`）と同じ桁にそろえた。
 * ⚠ **当たったら `truncated` で知らせ、`total` はその中で数えた値になる**（黙って切らない）。
 */
export const SUBJECT_SCAN_LIMIT = 20000;

/** 1 局面を通った所有者の棋譜（完全一致）と、そこからの枝。無ければ null */
export async function findPositionGames(tx: Tx, ownerId: string, key: PositionKey) {
  const { sfen } = key;

  // この局面を通った棋譜。**同じ棋譜が同じ局面を 2 度通ることもある**（千日手模様）ので
  // kifuId では畳まず、到達した手数ごとに 1 行返す。
  //
  // 🔒 **打ち切ったことを黙らない。** 初期局面は全棋譜が通るので、棋譜が増えれば
  // 必ず上限に当たる。件数を返さないと、UI の「N 件」が実数と食い違ううえ、
  // 「この局面を通った棋譜はこれで全部」と誤読される。
  // ⚠ **総数は `count(*) over ()` で同じクエリから取る。** count を別クエリにすると
  // 2 つのスナップショットになり、その間に取り込み・削除・再構築が走ると
  // 「total 199 なのに games 200 件」のような食い違いが出る（0 件なら null を返すので、
  // 総数が取れない場合を扱う必要はない）
  const rows = await tx
    .select({
      kifuId: kifuPositions.kifuId,
      moveNumber: kifuPositions.moveNumber,
      board: kifuPositions.board,
      hands: kifuPositions.hands,
      sideToMove: kifuPositions.sideToMove,
      title: kifus.title,
      source: kifus.source,
      playedAt: kifus.playedAt,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(kifuPositions)
    .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
    // ⭐ 照合（盤・持ち駒・手番）まで SQL に入れているので、上限と総数は照合後の行にかかる
    .where(
      and(
        eq(kifuPositions.ownerId, ownerId),
        eq(kifus.ownerId, ownerId),
        samePosition(kifuPositions, key),
      ),
    )
    // ⚠ **並びは打ち切りとセットで意味を持つ。** 序盤の局面はどの棋譜も通るので
    // 必ず上限に当たる。そこで残るのが「古い棋譜」では使い物にならないので、
    // 到達が早い順 → **新しい対局順**に並べる（基準は一覧と同じ playedOrCreatedAt）
    .orderBy(
      asc(kifuPositions.moveNumber),
      desc(playedOrCreatedAt),
      desc(kifuPositions.kifuId),
    )
    .limit(POSITION_GAMES_LIMIT);
  if (rows.length === 0) return null;

  // 枝の列挙。**次の局面が持つ `move` で集計する**——局面キーだけでは
  // 「同じ局面から指された別の手」を区別できない（prd/10 §5.3）。
  // 次の局面の SFEN は保存していないので、盤・持ち駒・手番で束ねて後から組み立てる
  // （この局面は照合済みなので、同じ手なら次の局面も同じ。束ね方は文字列の頃と一致する）
  const next = alias(kifuPositions, 'next');
  const branchRows = await tx
    .select({
      move: next.move,
      board: next.board,
      hands: next.hands,
      sideToMove: next.sideToMove,
      games: sql<number>`count(*)`.mapWith(Number),
    })
    .from(kifuPositions)
    .innerJoin(
      next,
      and(
        eq(next.kifuId, kifuPositions.kifuId),
        eq(next.ownerId, ownerId),
        eq(next.moveNumber, sql`${kifuPositions.moveNumber} + 1`),
      ),
    )
    .where(and(eq(kifuPositions.ownerId, ownerId), samePosition(kifuPositions, key)))
    .groupBy(next.move, next.board, next.hands, next.sideToMove)
    .orderBy(desc(sql`count(*)`), asc(next.move));
  const branches = branchRows.map(({ board, hands, sideToMove, ...b }) => ({
    move: b.move,
    sfen: sfenOfRow({ board, hands, sideToMove }),
    games: Number(b.games),
  }));

  // 盤・持ち駒はこの局面のものなのでどの行でも同じ。web が盤を描くのに使う
  const [first] = rows;
  const total = Number(first.total);
  return {
    sfen,
    isInitial: sfen === INITIAL_SFEN,
    board: [...first.board],
    hands: [...first.hands],
    sideToMove: first.sideToMove,
    games: rows.map(({ board: _b, hands: _h, sideToMove: _s, total: _t, ...g }) => g),
    /** 到達の総数。`games` は上限で切れていることがある（`hasMore`） */
    total,
    hasMore: total > rows.length,
    branches,
  };
}

/**
 * 主体側モード（prd/10 §3.3）。**自分の駒の配置**が同じ所有者の棋譜を、先後をまたいで探す。
 * 基準局面を所有者の棋譜が 1 つも通っていなければ null。
 *
 * 🔒 `subjectSide` が NULL の棋譜は除外し、**その件数を返す**——黙って落とすと、
 * 結果が少ない理由が「似た形が無い」のか「主体が決まらない棋譜を外した」のか分からない
 */
export async function findSubjectGames(
  tx: Tx,
  ownerId: string,
  key: PositionKey,
  side: 'sente' | 'gote',
) {
  const [base] = await tx
    .select({ one: sql`1` })
    .from(kifuPositions)
    .where(and(eq(kifuPositions.ownerId, ownerId), samePosition(kifuPositions, key)))
    .limit(1);
  if (!base) return null;

  // 基準局面。⚠ `goteSfen` は 180 度回して書くので、先後をまたいでそのまま比べられる
  // （prd/10 §3.2）。片側の配置は保存していないので、読み直した局面から組み立てる
  const baseSideSfen = side === 'sente' ? key.senteSfen : key.goteSfen;
  // 🔴 引く・比べるのは**小文字にした**配置（先後をまたいで一致させる。`sideLayoutKey`）。
  // 応答の `sideSfen` は従来どおり `sideSfen` の文字列を返す
  const baseLayoutKey = baseSideSfen.toLowerCase();
  const baseSideHash = hashOf(baseLayoutKey);

  // 🔒 **ハッシュで引いて、片側の配置を組み立て直して照合する**（prd/14 §6.3）。
  // 片側の配置（相手の駒を空にし、後手なら 180 度回したもの）は SQL で素直に比べられない
  // ので、照合はアプリ側で行う。⚠ 照合で落とす行を `limit` の後に捨てると件数がずれるので、
  // 上限（`SUBJECT_SCAN_LIMIT`）は「読み出す行数」の安全弁で、当たったら `truncated` で知らせる。
  // 1 行多く読んで、当たったかを判定する
  const matched = await tx
    .select({
      kifuId: kifuPositions.kifuId,
      moveNumber: kifuPositions.moveNumber,
      board: kifuPositions.board,
      hands: kifuPositions.hands,
      sideToMove: kifuPositions.sideToMove,
      title: kifus.title,
      source: kifus.source,
      subjectSide: kifus.subjectSide,
      playedAt: kifus.playedAt,
    })
    .from(kifuPositions)
    .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
    .where(
      and(
        eq(kifuPositions.ownerId, ownerId),
        eq(kifus.ownerId, ownerId),
        isNotNull(kifus.subjectSide),
        or(
          and(eq(kifus.subjectSide, 'sente'), eq(kifuPositions.senteSfenHash, baseSideHash)),
          and(eq(kifus.subjectSide, 'gote'), eq(kifuPositions.goteSfenHash, baseSideHash)),
        ),
      ),
    )
    .orderBy(
      asc(kifuPositions.moveNumber),
      desc(playedOrCreatedAt),
      desc(kifuPositions.kifuId),
    )
    .limit(SUBJECT_SCAN_LIMIT + 1);
  const truncated = matched.length > SUBJECT_SCAN_LIMIT;
  const scanned = truncated ? matched.slice(0, SUBJECT_SCAN_LIMIT) : matched;

  const verified = scanned.filter(
    (row) => row.subjectSide !== null && sameSideLayout(row, row.subjectSide, baseLayoutKey),
  );
  const rows = verified.slice(0, POSITION_GAMES_LIMIT).map(({ board, hands, sideToMove, ...g }) => ({
    kifuId: g.kifuId,
    moveNumber: g.moveNumber,
    sfen: sfenOfRow({ board, hands, sideToMove }),
    title: g.title,
    source: g.source,
    subjectSide: g.subjectSide,
    playedAt: g.playedAt,
  }));

  // 主体側が決まらない所有者の棋譜の数（この検索の対象外になっているもの）
  const [unresolved] = await tx
    .select({ n: count() })
    .from(kifus)
    .where(and(eq(kifus.ownerId, ownerId), isNull(kifus.subjectSide)));

  const total = verified.length;
  return {
    base: { sfen: key.sfen, side, sideSfen: baseSideSfen },
    games: rows,
    /** 照合で一致した数。`truncated` なら読み出した範囲の中で数えた値（下限） */
    total,
    hasMore: total > rows.length,
    /** 🔒 読み出しを `SUBJECT_SCAN_LIMIT` 行で打ち切ったか（prd/14 §6.3。黙って切らない） */
    truncated,
    /** 🔒 主体側が決まらないので除外した棋譜の数（prd/10 §3.3） */
    unresolvedSubjects: unresolved?.n ?? 0,
  };
}

/**
 * 近い局面（prd/10 §5.2）。完全一致は `findPositionGames` が返すので、ここは**別枠**。
 * 距離の計算はアプリ側に置く——「近い」が何を意味するかは使ってみないと決まらないので、
 * 定義を SQL に焼き込まない。基準局面を所有者の棋譜が通っていなければ null。
 */
export async function findSimilarPositions(
  tx: Tx,
  ownerId: string,
  key: PositionKey,
  options: { window: number; limit: number },
) {
  const { window, limit } = options;
  // 基準の局面。**最初に到達した手数**を手数帯の中心にする
  // （同じ局面でも棋譜ごとに到達手数が違う）
  const [base] = await tx
    .select({
      moveNumber: kifuPositions.moveNumber,
      board: kifuPositions.board,
      hands: kifuPositions.hands,
    })
    .from(kifuPositions)
    .where(and(eq(kifuPositions.ownerId, ownerId), samePosition(kifuPositions, key)))
    .orderBy(asc(kifuPositions.moveNumber))
    .limit(1);
  if (!base) return null;

  // この局面を既に通った棋譜を外すためのエイリアス（下の NOT EXISTS で使う）
  const exact = alias(kifuPositions, 'exact');
  const from = Math.max(0, base.moveNumber - window);
  const to = base.moveNumber + window;

  // 粗く絞ってから全件に距離を掛ける。手数帯で絞れば 1 棋譜あたり高々
  // `2 * window + 1` 行なので、数百局でも数千行に収まる
  const candidates = await tx
    .select({
      kifuId: kifuPositions.kifuId,
      moveNumber: kifuPositions.moveNumber,
      board: kifuPositions.board,
      hands: kifuPositions.hands,
      sideToMove: kifuPositions.sideToMove,
      title: kifus.title,
      source: kifus.source,
      playedAt: kifus.playedAt,
    })
    .from(kifuPositions)
    .innerJoin(kifus, eq(kifus.id, kifuPositions.kifuId))
    .where(
      and(
        eq(kifuPositions.ownerId, ownerId),
        eq(kifus.ownerId, ownerId),
        gte(kifuPositions.moveNumber, from),
        lte(kifuPositions.moveNumber, to),
        // 完全一致は `/positions` の側で出ているので、ここでは除く
        // ⚠ ハッシュの不一致（`ne(sfenHash, …)`）で代えない。衝突した別の局面まで落ちる
        not(samePosition(kifuPositions, key)),
        // 🔒 **この局面を通った棋譜そのものを外す。** 外さないと、序盤では
        // 「1 手前の局面（距離 2）」が全棋譜ぶん並ぶだけになる——どの棋譜も
        // 通っているので**当たり前の結果しか出ない**。近さが意味を持つのは
        // 「完全一致はしないが似ている棋譜」で、それを探すのがこの機能の目的
        notExists(
          tx
            .select({ one: sql`1` })
            .from(exact)
            .where(
              and(
                eq(exact.kifuId, kifuPositions.kifuId),
                eq(exact.ownerId, ownerId),
                samePosition(exact, key),
              ),
            ),
        ),
      ),
    )
    .limit(SIMILAR_SCAN_LIMIT);

  // ⭐ **棋譜ごとに最も近い 1 局面へ畳む。** 隣接する局面は高々 2 マスしか違わないので、
  // 畳まないと**同じ棋譜の連続する局面が上位を埋め尽くす**（似た棋譜が 1 局しか出ない）
  const best = new Map<number, (typeof candidates)[number] & { diff: PositionDiff }>();
  for (const row of candidates) {
    const diff = positionDiff(base, row);
    const current = best.get(row.kifuId);
    if (!current || diff.total < current.diff.total) {
      best.set(row.kifuId, { ...row, diff });
    }
  }

  const similar = [...best.values()]
    .sort((a, b) => a.diff.total - b.diff.total || a.moveNumber - b.moveNumber)
    .slice(0, limit)
    .map(({ board, hands, diff, ...r }) => ({
      // 文字列は保存していないので、返す行（上位 `limit` 件）だけ盤から組み立てる
      sfen: sfenOfRow({ board, hands, sideToMove: r.sideToMove }),
      ...r,
      distance: diff.total,
      boardDiff: diff.board,
      handsDiff: diff.hands,
    }));

  return {
    base: { sfen: key.sfen, moveNumber: base.moveNumber, from, to },
    similar,
    /** 距離を掛けた行数と、読み出しを打ち切ったか（🔒 黙って切らない） */
    scanned: candidates.length,
    truncated: candidates.length === SIMILAR_SCAN_LIMIT,
    /** 畳む前に見つかった棋譜の数（`similar` は limit で切れている） */
    matchedGames: best.size,
  };
}
