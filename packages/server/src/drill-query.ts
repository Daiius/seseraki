/**
 * 出題の取り出し（prd/13 §6.4 / §7）。
 *
 * 🔴 **答えを含む列（`answerMove` / `candidates` / `playedMove`）は出題時に返さない。**
 * クライアントへ渡した時点で答えが見えているのと同じで、`/drills` を専用ページにした
 * 意味（prd/13 §7）が消える。返すのは**盤面と問いだけ**。
 *
 * 🔒 **読み書きは所有者（要求者）の問題だけ**（prd/14 §4）。各関数は tx（ユーザーとして開いた
 * トランザクション。`user-tx.ts`）と所有者を引数に取る。他人の問題は「無い」（null → 404）。
 *
 * 🔒 **出題は「棋譜の番号・手数・種類」の組（{@link DrillRef}）で指す**（prd/14 §4.4）。`drills` の一意制約
 * （`drills_kifu_id_move_number_kind_uq`）と同じ組で、棋譜の内部 ID を所有者ごとの番号に置き換えたもの。
 * 出題の行の ID（`drills.id`）は応答に載せない——一括生成の upsert で作り直されることがあり、
 * 行の ID で指すと作り直しで URL が切れるうえ、通しの連番なので総数が分かる。
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { positionSfen, usiToJapaneseWithPiece } from 'shared';
import type { Db, Tx } from './db/index.js';
import { drillAttempts, drills, kifus } from './db/schema';
import {
  ANSWER_COUNT,
  ATTEMPT_NO,
  DRILL_PAGE_SIZE,
  EXCLUDED_COUNT,
  IS_RECENT_WRONG,
  IS_UNANSWERED,
  IS_WRONG,
  LAST_ANSWERED_AT,
  LAST_VERDICT,
  drillAttemptOrderBy,
  drillListHaving,
  drillListOrderBy,
  drillNextPlan,
  drillStatusOf,
  isoOf,
  type DrillListQuery,
  type DrillNextQuery,
} from './drill-list-query';
import { stateOfAnswer } from './drill-answer';
import { drillPosition } from './drill-answer-flow.js';

/**
 * 出題を指す組（prd/14 §4.4）。「42 番の棋譜の 37 手目の次の一手」。
 * `moveNumber` は出題局面（その手を指す前の局面。棋譜詳細の `?ply=` と同じ数え方）
 */
export interface DrillRef {
  kifuNo: number;
  moveNumber: number;
  kind: 'mate' | 'best';
}

/** `DrillRef` で 1 問を引く条件（所有者の棋譜の番号で引く） */
function byRef(ownerId: string, ref: DrillRef) {
  return and(
    eq(kifus.ownerId, ownerId),
    eq(kifus.displayNo, ref.kifuNo),
    eq(drills.moveNumber, ref.moveNumber),
    eq(drills.kind, ref.kind),
  );
}

/**
 * 出題 1 問（クライアントに返す形。**答えは含まない**）。
 * 問題は `kifuNo` / `moveNumber` / `kind` の組で指す（{@link DrillRef}）
 */
export interface DrillQuestion extends DrillRef {
  /** 出題局面（正規化 SFEN）。盤面はこれだけから描ける */
  sfen: string;
  /** engine の詰み距離（plies）。`kind='mate'` のときだけ。⚠ 詰将棋の「N手詰」ではない */
  matePlies: number | null;
  /** 過去に間違えた問題か（「以前間違えた」のラベルを出す。prd/13 §6.4） */
  wrongBefore: boolean;
}

/** 一度でも間違えた（惜しいを含む）回数。「以前間違えた」のラベル（prd/13 §6.4 で維持） */
const WRONG_BEFORE = sql<number>`sum(case when ${drillAttempts.verdict} in ('wrong', 'close') then 1 else 0 end)`;

/**
 * 次の 1 問を選ぶ（prd/13 §6.4）。入口（`mode`）ごとの在庫と順序は {@link drillNextPlan}。
 *
 * 🔒 **「自明だった」で除外された問題は出さない**（prd/13 §7）。除外は履歴側の列なので、
 * 出題を作り直しても残る。
 * 🔒 **この回（`since` 以降）に記録した問題は出さない**（prd/13 §7.6）。在庫が尽きたら null
 */
export async function pickNextDrill(
  tx: Tx,
  ownerId: string,
  query: DrillNextQuery = { mode: 'recommend' },
): Promise<DrillQuestion | null> {
  const plan = drillNextPlan(query);
  const [row] = await tx
    .select({
      kifuNo: kifus.displayNo,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      usiMoves: kifus.usiMoves,
      wrongBefore: WRONG_BEFORE.mapWith(Number),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(and(eq(kifus.ownerId, ownerId), plan.where))
    // 主キーで束ねる（`kifus` の列は `kifus.id` に従属するので選べる）
    .groupBy(drills.id, kifus.id)
    .having(plan.having)
    .orderBy(...plan.orderBy)
    .limit(1);

  if (!row) return null;
  const sfen = drillSfen(row.usiMoves, row.moveNumber);
  if (!sfen) return null;
  return {
    kifuNo: row.kifuNo,
    moveNumber: row.moveNumber,
    kind: row.kind,
    sfen,
    matePlies: row.matePlies,
    wrongBefore: row.wrongBefore > 0,
  };
}

/**
 * 出題局面の正規化 SFEN を作る。指し手列が足りなければ `null`
 * （`usiMoves` を作り直した直後などに起こりうる。数字を捏造しない）。
 */
export function drillSfen(usiMoves: string[] | null, moveNumber: number): string | null {
  const state = drillPosition(usiMoves, moveNumber);
  return state ? positionSfen(state) : null;
}

/**
 * 採点に要る 1 問ぶん（**答えを含む**。server 内でしか使わない）。
 * `id`（行の ID）は解答の記録・手順の記憶に使う内部の値で、応答には載せない
 */
export async function loadDrill(tx: Tx, ownerId: string, ref: DrillRef) {
  const [row] = await tx
    .select({
      id: drills.id,
      kifuNo: kifus.displayNo,
      ownerId: drills.ownerId,
      kind: drills.kind,
      reason: drills.reason,
      moveNumber: drills.moveNumber,
      answerMove: drills.answerMove,
      answerScoreType: drills.answerScoreType,
      answerScoreValue: drills.answerScoreValue,
      answerPv: drills.answerPv,
      candidates: drills.candidates,
      matePlies: drills.matePlies,
      playedMove: drills.playedMove,
      playedLossCp: drills.playedLossCp,
      usiMoves: kifus.usiMoves,
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .where(byRef(ownerId, ref));
  return row ?? null;
}

/** 解答を 1 件記録する（prd/13 §6.2） */
export async function recordAttempt(
  tx: Tx | Db,
  attempt: {
    drillId: number;
    /** 出題（`drills.ownerId`）の所有者。食い違えば複合 FK が落とす（prd/14 §4.1） */
    ownerId: string;
    move: string | null;
    /** 解答の手順（出題局面から・最後が `move`）。表記を作る盤面がこれで決まる（prd/13 §6.2） */
    line?: string[] | null;
    verdict: 'correct' | 'close' | 'wrong' | null;
    lossCp: number | null;
    excluded?: boolean;
  },
): Promise<void> {
  await tx.insert(drillAttempts).values({
    drillId: attempt.drillId,
    ownerId: attempt.ownerId,
    move: attempt.move,
    line: attempt.line ?? null,
    verdict: attempt.verdict,
    lossCp: attempt.lossCp,
    excluded: attempt.excluded ?? false,
  });
}

/**
 * ホーム（prd/13 §7.5）の数。入口ごとの在庫（この回の除外は掛けない——ホームに戻った時点で回は終わる）。
 * 🔒 **正答率などの成績は返さない**（§10。棋力の向上に繋がらないため）。
 * - `total`: 問題の総数（除外を含む）。0 なら「まだ問題が無い」
 * - `recommend`: おすすめの在庫（除外と、間違えて 1 日経っていない問題を除く。§6.4）
 * - `mate` / `best`: その種類の未解答
 * - `wrong`: 間違えた問題（最後の判定が正解でない）
 */
export async function drillCounts(tx: Tx, ownerId: string) {
  // 1 問 1 行に束ねてから数える（状態は履歴の集計から出る）
  const perDrill = tx
    .select({
      kind: drills.kind,
      excluded: sql<boolean>`${EXCLUDED_COUNT} > 0`.as('excluded'),
      unanswered: sql<boolean>`${IS_UNANSWERED}`.as('unanswered'),
      wrong: sql<boolean>`${IS_WRONG}`.as('wrong'),
      recentWrong: sql<boolean>`${IS_RECENT_WRONG}`.as('recent_wrong'),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(eq(kifus.ownerId, ownerId))
    .groupBy(drills.id)
    .as('per_drill');
  const counted = (condition: ReturnType<typeof sql>) =>
    sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  const [row] = await tx
    .select({
      total: count(),
      recommend: counted(sql`not ${perDrill.excluded} and not ${perDrill.recentWrong}`),
      mate: counted(sql`not ${perDrill.excluded} and ${perDrill.unanswered} and ${perDrill.kind} = 'mate'`),
      best: counted(sql`not ${perDrill.excluded} and ${perDrill.unanswered} and ${perDrill.kind} = 'best'`),
      wrong: counted(sql`not ${perDrill.excluded} and ${perDrill.wrong}`),
    })
    .from(perDrill);
  return row ?? { total: 0, recommend: 0, mate: 0, best: 0, wrong: 0 };
}

/**
 * 一覧から名指しで開いた 1 問（prd/13 §5.4）。**返す形は `/drills/next` と同じ**で、
 * 答えは含まない。🔒 **除外した問題も返す**——出題順（prd/13 §6.3）の除外とは別の話で、
 * 一覧から明示的に開いた問題を「無い」と言うのは筋が通らない。
 */
export async function loadDrillQuestion(
  tx: Tx,
  ownerId: string,
  ref: DrillRef,
): Promise<DrillQuestion | null> {
  const [row] = await tx
    .select({
      kifuNo: kifus.displayNo,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      usiMoves: kifus.usiMoves,
      wrongBefore: WRONG_BEFORE.mapWith(Number),
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(byRef(ownerId, ref))
    .groupBy(drills.id, kifus.displayNo, drills.kind, drills.moveNumber, drills.matePlies, kifus.usiMoves);

  if (!row) return null;
  const sfen = drillSfen(row.usiMoves, row.moveNumber);
  if (!sfen) return null;
  return {
    kifuNo: row.kifuNo,
    moveNumber: row.moveNumber,
    kind: row.kind,
    sfen,
    matePlies: row.matePlies,
    wrongBefore: row.wrongBefore > 0,
  };
}

/**
 * 問題の一覧（prd/13 §7.7）。**1 問 1 行**（カード 1 枚）にまとめ、状態は履歴側の集計から出す。
 *
 * 🔴 **答えを含む列は返さない**（`answerMove` / `answerPv` / `candidates` / `playedMove`）。
 * 行に**出題局面の SFEN** を載せる（カードの盤の縮図。解く画面でも最初に見せる局面で、答えではない）。
 * ⚠ 棋譜名は載せない（カードに出さない。対局へは解いた後の「元の対局」で辿る。§7.7）
 */
export async function listDrills(tx: Tx, ownerId: string, query: DrillListQuery) {
  const where = and(
    eq(kifus.ownerId, ownerId),
    query.kind ? eq(drills.kind, query.kind) : undefined,
  );
  const having = drillListHaving(query);

  // 件数は**同じ条件で数える**（prd/04 §6.1 と同じ姿勢）。集計に対する条件なので、
  // 絞り込み済みの行を副問い合わせにしてから数える
  const grouped = tx
    .select({ id: drills.id })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(where)
    .groupBy(drills.id)
    .having(having)
    .as('grouped');
  const [totals] = await tx.select({ total: count() }).from(grouped);
  const total = totals?.total ?? 0;

  const rows = await tx
    .select({
      // 問題は（棋譜の番号・手数・種類）で指す（prd/14 §4.4。行の ID は載せない）
      kifuNo: kifus.displayNo,
      kind: drills.kind,
      moveNumber: drills.moveNumber,
      matePlies: drills.matePlies,
      usiMoves: kifus.usiMoves,
      playedAt: kifus.playedAt,
      kifuCreatedAt: kifus.createdAt,
      answers: ANSWER_COUNT.mapWith(Number),
      lastVerdict: LAST_VERDICT,
      excludedCount: EXCLUDED_COUNT.mapWith(Number),
      lastAnsweredAt: LAST_ANSWERED_AT,
    })
    .from(drills)
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
    .where(where)
    // 主キーで束ねる（`kifus` の列は `kifus.id` に従属するので選べる）
    .groupBy(drills.id, kifus.id)
    .having(having)
    .orderBy(...drillListOrderBy())
    .limit(DRILL_PAGE_SIZE)
    .offset((query.page - 1) * DRILL_PAGE_SIZE);

  return {
    drills: rows.map(({ excludedCount, lastAnsweredAt, lastVerdict, usiMoves, ...row }) => ({
      ...row,
      // 盤面を作れない行（`usiMoves` を作り直した直後など）は null（数字を捏造しない）
      sfen: drillSfen(usiMoves, row.moveNumber),
      excluded: excludedCount > 0,
      lastAnsweredAt: isoOf(lastAnsweredAt),
      // 状態は最後の記録の判定で読む（prd/13 §6.4。除外は `excluded` で別に持つ）
      status: drillStatusOf(row.answers, lastVerdict),
    })),
    pagination: {
      page: query.page,
      totalPages: Math.ceil(total / DRILL_PAGE_SIZE),
      total,
    },
  };
}

/**
 * その問題の解答履歴（prd/13 §7.7）。**1 行 1 解答**で新しい順・最大 {@link DRILL_PAGE_SIZE} 件。
 * web は**解いた後にだけ**呼ぶ（正解の記録の「指した手」は答えそのもの。§7.7）。
 *
 * 🔒 **同じ問題の複数回はまとめない**——間違えた後に正解した経過が読めなくなる。
 * ⚠ **「自明だった」の行（`move` / `verdict` が null）も出す**（prd/13 §6.2）。
 * 「諦めて答えを見る」の行は `verdict='wrong'`・`move` が null（web は手の欄に「（諦めた）」と出す）。
 * 🔒 所有者の問題だけ（`byRef`）。呼び出し側は先に問題があるかを確かめる（無ければ 404）
 */
export async function listDrillAttemptsOf(tx: Tx, ownerId: string, ref: DrillRef) {
  const rows = await tx
    .select({
      // 🔒 解答履歴の行の ID・出題の行の ID・棋譜の内部 ID は載せない（prd/14 §4.4）
      move: drillAttempts.move,
      verdict: drillAttempts.verdict,
      lossCp: drillAttempts.lossCp,
      excluded: drillAttempts.excluded,
      line: drillAttempts.line,
      createdAt: drillAttempts.createdAt,
      usiMoves: kifus.usiMoves,
      // その問題の何回目の解答か（除外だけの行は数えない。prd/13 §6.2）
      attemptNo: ATTEMPT_NO.mapWith(Number),
    })
    .from(drillAttempts)
    .innerJoin(drills, eq(drills.id, drillAttempts.drillId))
    .innerJoin(kifus, eq(kifus.id, drills.kifuId))
    .where(byRef(ownerId, ref))
    .orderBy(...drillAttemptOrderBy())
    .limit(DRILL_PAGE_SIZE);

  // 日本語表記は**盤面が要る**（`shared` の `board.ts`）。1 問ぶんなので出題局面は 1 度だけ作る
  const base = drillPosition(rows[0]?.usiMoves ?? null, ref.moveNumber);

  return {
    attempts: rows.map(({ usiMoves: _usiMoves, move, line, ...row }) => {
      // 🔴 **表記を作る盤面は「その手を指した局面」**（prd/13 §5.4・レビュー `OCL-A1E622FE`）。
      // 詰将棋は指し継ぎなので、出題局面から読むと**駒名が欠ける・別の駒として表示される**
      const state = base && move ? stateOfAnswer(base, line, move, ref.kind) : null;
      return {
        ...row,
        move,
        // 盤面を作れない行（`line` を持たない既存の詰将棋・作り直した `usiMoves`）は
        // **USI のまま出す**——復元できない表記を作らない
        moveText: state && move ? usiToJapaneseWithPiece(state, move) : move,
        // 何回目かは判定を持つ行だけ（諦めは数える・除外だけの行は null）
        attemptNo: row.verdict ? row.attemptNo : null,
      };
    }),
  };
}

/**
 * 「自明だった」の取り消し（prd/13 §7.2）。
 *
 * 🔒 **除外の行そのものを消す**——印を取り消す操作なので、印を残さない。
 * 解答の行（判定を持つ行・諦めを含む）は触らないので、**解答履歴は消えない**。
 * 🔒 **所有者の行だけ**（prd/14 §4）。呼び出し側は先に `loadDrill` で問題が本人のものか確かめる。
 */
export async function unexcludeDrill(tx: Tx, ownerId: string, drillId: number): Promise<void> {
  await tx
    .delete(drillAttempts)
    .where(
      and(
        eq(drillAttempts.drillId, drillId),
        eq(drillAttempts.ownerId, ownerId),
        eq(drillAttempts.excluded, true),
      ),
    );
}
