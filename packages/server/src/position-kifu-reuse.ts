/**
 * 既に分かっている評価値を先に引く（prd/12 §2.6）。
 *
 * 検討の起点は閲覧中の棋譜の局面で、数手動かすまでは**解析済みの局面をなぞっているだけ**の
 * ことが多い。同じ答えを待って計算し直す理由がないので、**エンジンにジョブを積む前に**
 * `moveAnalyses` / `candidateMoves`（prd/03 §3・§4）から答えを組み立てる。
 * 正規化 SFEN → 棋譜局面は局面索引 `kifuPositions`（prd/10 §3.2）が引ける。
 *
 * 🔒 **判定はここ 1 か所に置く**（prd/12 §2.6）。web も MCP（prd/12 §4）も
 * `POST /api/positions/evaluate` を通るので、そこから呼べば双方に効く。
 * **web 側に同じ判定を持たせない。**
 *
 * 🔒 **局面評価（`move` なし）は候補手が 3 本揃っているときだけ再利用する。**
 * 棋譜解析の候補手数は運用つまみ `ENGINE_MULTIPV` で変わりうるが、**局面評価の 3 本は
 * web / MCP が前提にする API の契約**（prd/12 §2.2）。再利用の都合で契約を崩さない。
 * 名指し評価は返すのがその手 1 本なので、この制約はかからない。
 *
 * ⚠ **どこから来た値かを隠さない。** 解析時のエンジン設定（depth / movetime）は今と
 * 違いうるので、応答は `source: 'kifu' | 'engine'` を持ち、`evaluatedAt` には
 * **そのときの解析時刻**（`moveAnalyses.createdAt`）を入れる。
 *
 * ⚠ DB のスコアは**手番側から見た値**（エンジンが返す生の値）で入っているので、
 * 検討盤の表示視点（prd/12 §2.3）とそのまま噛み合う。符号を触るのは
 * 「実手を次の局面の評価から引く」経路だけ（手番が入れ替わるため）。
 */
import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from './db/index.js';
import { candidateMoves, kifuPositions, moveAnalyses } from './db/schema.js';
import type { EvalCandidate, EvalRequest, EvalOutcome } from './position-eval.js';

type DoneOutcome = Extract<EvalOutcome, { status: 'done' }>;

/**
 * 値の出所（prd/12 §2.6）。応答に必ず載せる。
 * - `kifu`: 既存の棋譜解析から引いた（解析時のエンジン設定は今と違いうる）
 * - `engine`: 今のエンジンに評価させた
 */
export type EvalSource = 'kifu' | 'engine';

/** `POST /api/positions/evaluate` が返す評価結果。**必ず出所が付く** */
export type SourcedEvalOutcome = EvalOutcome & { source: EvalSource };

/** 棋譜から引けた結果。出所は必ず `kifu` */
export type ReusedEvalOutcome = DoneOutcome & { source: 'kifu' };

/**
 * 一致した棋譜局面 1 件ぶんの材料。
 *
 * `next*` は名指し評価で**実手を次の局面の評価から引く**ために使う（prd/12 §2.6）。
 * 局面評価では引かないので空のまま。
 */
export interface KifuPositionMatch {
  kifuId: number;
  /** 局面番号（0 = 初期局面。N = N 手適用後）。`moveAnalyses` と同じ意味 */
  moveNumber: number;
  /** この局面の候補手（rank 昇順）。未解析なら空 */
  candidates: EvalCandidate[];
  /** この局面の解析時刻。未解析なら null */
  analyzedAt: Date | null;
  /** この局面から実際に指された手（次局面に至った手）。最終局面なら null */
  playedMove: string | null;
  /** 実手を指した後の局面の候補手（rank 昇順）。未解析なら空 */
  nextCandidates: EvalCandidate[];
  /** 次局面の解析時刻。未解析なら null */
  nextAnalyzedAt: Date | null;
}

/**
 * 読み出す件数の上限。初期局面のように**全局が通る**局面があるため、無制限にすると
 * 1 リクエストで全棋譜ぶんの解析を引いてしまう。
 *
 * 🔴 **これは「再利用できる候補」の中での上限**（レビュー指摘 `OCL-74319F91`）。
 * 一致局面をまず 20 件に切ってから解析を引くと、**切り落とした側に新しい解析や
 * 唯一の再利用可能な解析があっても見つけられない**。SQL の側で
 * 「再利用条件を満たす行」まで絞り、**解析日時の降順に並べてから**上限をかける。
 */
const MATCH_LIMIT = 20;

/**
 * 複数の棋譜が同じ局面を持つときの採用順（🔴 **どれを採るかの理由**）。
 *
 * **解析が新しい順**に見る。同じ局面ならどの棋譜から引いても評価値の意味は同じで、
 * 違うのは**いつ・どのエンジン設定で解析したか**だけ。今のエンジン構成に最も近いのは
 * 最後に解析したものなので、それを優先する。
 * 同時刻で並んだら `kifuId` の大きい順（= 後から取り込んだ棋譜）で決め、
 * **返す値がリクエストのたびに揺れない**ようにする。
 */
function byFreshness(a: KifuPositionMatch, b: KifuPositionMatch): number {
  const at = a.analyzedAt?.getTime() ?? 0;
  const bt = b.analyzedAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return b.kifuId - a.kifuId;
}

/** 名指し評価で「実手 → 次局面」を引くときの並び。次局面の解析時刻で見る */
function byNextFreshness(a: KifuPositionMatch, b: KifuPositionMatch): number {
  const at = a.nextAnalyzedAt?.getTime() ?? 0;
  const bt = b.nextAnalyzedAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return b.kifuId - a.kifuId;
}

function isoOr(now: Date | null): string {
  return (now ?? new Date()).toISOString();
}

/**
 * 引いてきた材料から答えを組み立てる（**純関数**。DB に触らない）。
 *
 * @returns 再利用できるなら評価結果。できなければ `null`（= エンジンへ回す）
 */
export function reuseFromKifu(
  request: EvalRequest,
  matches: KifuPositionMatch[],
): ReusedEvalOutcome | null {
  if (request.move === null) {
    // 局面評価: 候補手が 3 本揃っている解析だけを使う。
    // 揃っていれば先頭 3 本を返す（`ENGINE_MULTIPV` が 3 より大きい構成でも、
    // 返す本数は API の契約どおり 3 本に揃える）
    for (const match of [...matches].sort(byFreshness)) {
      if (match.candidates.length < 3) continue;
      return {
        status: 'done',
        source: 'kifu',
        candidates: match.candidates.slice(0, 3),
        fallback: false,
        evaluatedAt: isoOr(match.analyzedAt),
      };
    }
    return null;
  }

  const move = request.move;

  // 名指し評価 ①: その手が候補手に入っていれば、そのスコアと読み筋をそのまま返す。
  // **3 本揃っている必要はない**——返すのは名指しした 1 本だけだから。
  // ②（次局面からの符号反転）より先に見るのは、こちらが**その局面をその手で直接
  // 評価した値**であり、深さも読み筋も名指し評価の形そのままだから。
  for (const match of [...matches].sort(byFreshness)) {
    const found = match.candidates.find((c) => c.move === move);
    if (!found) continue;
    return {
      status: 'done',
      source: 'kifu',
      // 名指し評価は 1 本だけを返す（worker の `searchmoves` 経路と同じ形）
      candidates: [{ ...found, rank: 1 }],
      fallback: false,
      evaluatedAt: isoOr(match.analyzedAt),
    };
  }

  // 名指し評価 ②: 実手なら**次の局面の評価**から引ける。次局面は相手番なので
  // 符号を反転して自分視点に戻し、読み筋の先頭にその手を足す
  // （worker のフォールバック経路と同じ組み立て方。prd/12 §2.2）。
  // 🔒 **`fallback: true` を立てる。** 「手を適用した局面を評価して符号反転した値」で
  // あることは、エンジン経由でもここでも同じ意味を持つ。
  for (const match of [...matches].sort(byNextFreshness)) {
    if (match.playedMove !== move) continue;
    const best = match.nextCandidates[0];
    if (!best) continue;
    return {
      status: 'done',
      source: 'kifu',
      candidates: [
        {
          rank: 1,
          move,
          scoreType: best.scoreType,
          scoreValue: -best.scoreValue,
          pv: [move, ...best.pv],
          depth: best.depth,
        },
      ],
      fallback: true,
      evaluatedAt: isoOr(match.nextAnalyzedAt),
    };
  }

  // 候補手にも実手にも無い手・棋譜から離れた派生局面はエンジンへ
  return null;
}

function toCandidate(row: {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
  pv: string[] | null;
  depth: number;
}): EvalCandidate {
  return {
    rank: row.rank,
    move: row.move,
    // DB の列は varchar だが入るのは USI の 2 値だけ（prd/03 §4）
    scoreType: row.scoreType === 'mate' ? 'mate' : 'cp',
    scoreValue: row.scoreValue,
    pv: row.pv ?? [],
    depth: row.depth,
  };
}

/** 解析 1 件ぶんの識別と時刻。候補手は後でまとめて引く */
interface AnalysisRow {
  id: number;
  kifuId: number;
  moveNumber: number;
  createdAt: Date;
}

/**
 * その解析が `rank` の候補手を持っているか。
 *
 * 候補手の rank は 1 から連番で入る（worker が MultiPV の結果をそのまま並べる）ので、
 * **`rank = 3` の行があること = 3 本揃っていること**。件数を数える集計より軽く、
 * `UNIQUE(moveAnalysisId, rank)` の索引がそのまま効く。
 * ⚠ それでも `reuseFromKifu` 側で `candidates.length` を見る——DB が想定外の形でも
 * **3 本の契約は最後の砦で守る**。
 */
function hasCandidateRank(rank: number) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(candidateMoves)
      .where(
        and(
          eq(candidateMoves.moveAnalysisId, moveAnalyses.id),
          eq(candidateMoves.rank, rank),
        ),
      ),
  );
}

/**
 * 🔴 **再利用するのは `profile='full'` の行だけ**（決定・2026-09-05。prd/12 §2.6）。
 * `quick` の行は**エンジン評価へ回す**（`source: 'engine'`）——局面評価の品質は
 * `ENGINE_MOVETIME` が **API の契約**（prd/12 §2.2）であって、**再利用の都合で契約を崩さない**。
 * 候補手が 3 本揃っていることを要求するのと同じ立場。
 */
const isFullAnalysis = () => eq(moveAnalyses.profile, 'full');

/** 解析行の select 句（3 つのクエリで共通） */
function analysisSelection() {
  return {
    id: moveAnalyses.id,
    kifuId: moveAnalyses.kifuId,
    moveNumber: moveAnalyses.moveNumber,
    createdAt: moveAnalyses.createdAt,
  };
}

/**
 * 局面評価に使える解析（**候補手が 3 本揃っているものだけ**）を、解析が新しい順に引く。
 *
 * ⚠ クエリ**ビルダ**を返す（await すれば実行される）。DB 接続なしで `.toSQL()` を
 * 見られる形にして、上限が絞り込みより後にかかることをテストで固定するため。
 * 同時刻は `kifuId` の降順（応答が揺れないように順序を決め切る）。
 */
export function positionEvalAnalysesQuery(sfen: string) {
  return db
    .select(analysisSelection())
    .from(kifuPositions)
    .innerJoin(
      moveAnalyses,
      and(
        eq(moveAnalyses.kifuId, kifuPositions.kifuId),
        eq(moveAnalyses.moveNumber, kifuPositions.moveNumber),
      ),
    )
    .where(
      and(eq(kifuPositions.sfen, sfen), isFullAnalysis(), hasCandidateRank(3)),
    )
    .orderBy(desc(moveAnalyses.createdAt), desc(moveAnalyses.kifuId))
    .limit(MATCH_LIMIT);
}

/**
 * 名指しした手を**候補手に持っている**解析を、解析が新しい順に引く。
 * 本数は問わない（返すのはその手 1 本だから。prd/12 §2.6）。
 */
export function namedMoveAnalysesQuery(sfen: string, move: string) {
  return db
    .select(analysisSelection())
    .from(kifuPositions)
    .innerJoin(
      moveAnalyses,
      and(
        eq(moveAnalyses.kifuId, kifuPositions.kifuId),
        eq(moveAnalyses.moveNumber, kifuPositions.moveNumber),
      ),
    )
    .innerJoin(
      candidateMoves,
      and(
        eq(candidateMoves.moveAnalysisId, moveAnalyses.id),
        eq(candidateMoves.move, move),
      ),
    )
    .where(and(eq(kifuPositions.sfen, sfen), isFullAnalysis()))
    .orderBy(desc(moveAnalyses.createdAt), desc(moveAnalyses.kifuId))
    .limit(MATCH_LIMIT);
}

/**
 * 名指しした手が**その局面の実手**である棋譜を探し、**次の局面の解析**を新しい順に引く。
 *
 * 実手（次局面に至った手）は局面索引が持っている（prd/10 §3.2）ので、
 * `kifus.usiMoves` を丸ごと読まずに自己結合で辿れる。
 * 候補手が 1 本も無い解析は符号反転の材料にならないので、SQL の側で落とす。
 */
export function playedMoveAnalysesQuery(sfen: string, move: string) {
  const nextPositions = alias(kifuPositions, 'next_positions');
  return db
    .select({ ...analysisSelection(), fromMoveNumber: kifuPositions.moveNumber })
    .from(kifuPositions)
    .innerJoin(
      nextPositions,
      and(
        eq(nextPositions.kifuId, kifuPositions.kifuId),
        eq(nextPositions.moveNumber, sql`${kifuPositions.moveNumber} + 1`),
        eq(nextPositions.move, move),
      ),
    )
    .innerJoin(
      moveAnalyses,
      and(
        eq(moveAnalyses.kifuId, nextPositions.kifuId),
        eq(moveAnalyses.moveNumber, nextPositions.moveNumber),
      ),
    )
    .where(
      and(eq(kifuPositions.sfen, sfen), isFullAnalysis(), hasCandidateRank(1)),
    )
    .orderBy(desc(moveAnalyses.createdAt), desc(moveAnalyses.kifuId))
    .limit(MATCH_LIMIT);
}

/** 解析 id → 候補手（rank 昇順）。1 クエリでまとめて引く */
async function loadCandidates(
  ids: number[],
): Promise<Map<number, EvalCandidate[]>> {
  const byAnalysis = new Map<number, EvalCandidate[]>();
  if (ids.length === 0) return byAnalysis;
  const rows = await db
    .select({
      moveAnalysisId: candidateMoves.moveAnalysisId,
      rank: candidateMoves.rank,
      move: candidateMoves.move,
      scoreType: candidateMoves.scoreType,
      scoreValue: candidateMoves.scoreValue,
      pv: candidateMoves.pv,
      depth: candidateMoves.depth,
    })
    .from(candidateMoves)
    .where(inArray(candidateMoves.moveAnalysisId, ids))
    .orderBy(asc(candidateMoves.moveAnalysisId), asc(candidateMoves.rank));
  for (const row of rows) {
    const list = byAnalysis.get(row.moveAnalysisId) ?? [];
    list.push(toCandidate(row));
    byAnalysis.set(row.moveAnalysisId, list);
  }
  return byAnalysis;
}

/** 材料の入っていない 1 件（`KifuPositionMatch` を埋めるための素） */
function emptyMatch(kifuId: number, moveNumber: number): KifuPositionMatch {
  return {
    kifuId,
    moveNumber,
    candidates: [],
    analyzedAt: null,
    playedMove: null,
    nextCandidates: [],
    nextAnalyzedAt: null,
  };
}

/**
 * 正規化 SFEN に一致する棋譜局面のうち、**再利用の材料になるものだけ**を引く。
 *
 * 🔴 **用途ごとにクエリを分ける**（レビュー指摘 `OCL-74319F91`）。必要な結合も順位の
 * 基準も違うため、1 本のクエリで「一致局面を取ってから絞る」形にすると、**上限が
 * 再利用条件より先に効いてしまう**（初期局面のように一致棋譜が多いと、未解析の棋譜
 * ばかりを 20 件読んで、再利用できる解析を取り落とす）。
 *
 * - 局面評価: 候補手 3 本揃いの解析（`positionEvalAnalysesQuery`）
 * - 名指し評価 ①: その手を候補手に持つ解析（`namedMoveAnalysesQuery`）
 * - 名指し評価 ②: その手が実手で、次局面が解析済み（`playedMoveAnalysesQuery`）
 *
 * ①②は**両方引く**。どちらを採るかは `reuseFromKifu` が決める（①が優先）。
 */
export async function findKifuPositionMatches(
  request: EvalRequest,
): Promise<KifuPositionMatch[]> {
  const { sfen, move } = request;

  if (move === null) {
    const analyses: AnalysisRow[] = await positionEvalAnalysesQuery(sfen);
    const candidates = await loadCandidates(analyses.map((a) => a.id));
    return analyses.map((a) => ({
      ...emptyMatch(a.kifuId, a.moveNumber),
      candidates: candidates.get(a.id) ?? [],
      analyzedAt: a.createdAt,
    }));
  }

  const [named, played]: [AnalysisRow[], (AnalysisRow & { fromMoveNumber: number })[]] =
    await Promise.all([
      namedMoveAnalysesQuery(sfen, move),
      playedMoveAnalysesQuery(sfen, move),
    ]);
  const candidates = await loadCandidates([
    ...named.map((a) => a.id),
    ...played.map((a) => a.id),
  ]);

  return [
    ...named.map((a) => ({
      ...emptyMatch(a.kifuId, a.moveNumber),
      candidates: candidates.get(a.id) ?? [],
      analyzedAt: a.createdAt,
    })),
    // 次局面の解析なので、`moveNumber` は**要求された局面の方**に戻して持つ
    ...played.map((a) => ({
      ...emptyMatch(a.kifuId, a.fromMoveNumber),
      playedMove: move,
      nextCandidates: candidates.get(a.id) ?? [],
      nextAnalyzedAt: a.createdAt,
    })),
  ];
}

/**
 * 既存の棋譜解析から答えを引く。引けなければ `null`（= エンジンへ）。
 *
 * ⚠ **エンジンのキュー / キャッシュ（`position-eval.ts`）には一切触らない。**
 * ここで答えられた要求はジョブを積まずに返る、というのがこの経路の目的。
 */
export async function lookupKifuEvaluation(
  request: EvalRequest,
): Promise<ReusedEvalOutcome | null> {
  const matches = await findKifuPositionMatches(request);
  if (matches.length === 0) return null;
  return reuseFromKifu(request, matches);
}
