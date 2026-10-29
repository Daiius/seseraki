/**
 * 出題の解答の流れ（prd/13 §5）。`POST /drills/:kifuNo/:moveNumber/:kind/answer` の本体。
 *
 * 検証（手順の照合 → 出題局面 → 評価の手との一致 → 指せる手か）・候補手での採点・詰将棋の指し継ぎ・
 * エンジンへの回し方を決め、**応答の本文と HTTP ステータスの組**を返す。DB・メモリ上の手順の記憶・
 * エンジンは `deps` から受ける（ここは import しない）ので、流れそのものを単体で確かめられる。
 *
 * 🔒 **答えを載せるのは解き終えたときだけ**（`done`。prd/13 §7）。`continue` / `miss` / `evaluate` には載せない。
 */
import {
  applyMove,
  buildPositions,
  validateMoveOnPosition,
  type BoardState,
  type DrillNamedEvaluation,
} from 'shared';
import type { AnalysisAssignee } from './analysis-report.js';
import {
  DEFAULT_SCORING,
  givesCheck,
  isReachableMove,
  matchMateLine,
  scoreFromCandidates,
  type DrillScoring,
  type DrillVerdict,
} from './drill-answer.js';
import type { EngineAnswer, ResolveInput } from './drill-engine.js';
import type { loadDrill } from './drill-query.js';

/** 採点に要る 1 問ぶん（`loadDrill` の戻り。**答えを含む**） */
export type AnswerDrill = NonNullable<Awaited<ReturnType<typeof loadDrill>>>;

/**
 * 出題局面（`moveNumber` 手を指す直前の局面）。指し手列が足りなければ null
 * （`usiMoves` を作り直した直後などに起こりうる。数字を捏造しない）。
 * 🔒 出題の局面はここ 1 か所で作る（出題の SFEN・解答履歴の表記・解答の採点が同じ局面を見る）
 */
export function drillPosition(usiMoves: string[] | null, moveNumber: number): BoardState | null {
  if (!usiMoves || moveNumber > usiMoves.length) return null;
  return buildPositions(usiMoves)[moveNumber] ?? null;
}

/** 出題局面に手順を積む。読めない手が混ざったら null（数字を捏造しない） */
export function applyLine(base: BoardState, moves: string[]): BoardState | null {
  let state = base;
  for (const move of moves) {
    try {
      state = applyMove(state, move);
    } catch {
      return null;
    }
  }
  return state;
}

/**
 * 解答後にだけ返す情報（ネタバレ回避。prd/13 §7）。棋譜は番号で返す（prd/14 §4.4）。
 * `plies` はユーザーの手順の手数、`answerPlies` は当初の正解手順の手数（詰将棋の結果に出す。prd/13 §7.1）
 */
export function drillReveal(drill: AnswerDrill, line: string[]) {
  return {
    kifuNo: drill.kifuNo,
    moveNumber: drill.moveNumber,
    reason: drill.reason,
    answerMove: drill.answerMove,
    answerPv: drill.answerPv,
    playedMove: drill.playedMove,
    playedLossCp: drill.playedLossCp,
    plies: line.length,
    answerPlies: drill.answerPv?.length ?? null,
  };
}

/** エンジンに回すときの入力（tx・要求者は `deps.resolveWithEngine` の側が足す） */
export type EngineRequest = Omit<ResolveInput, 'tx' | 'userId'>;

/**
 * エンジンの採点結果を HTTP へ写す。**待ちは 202、キュー満杯は 503**（prd/12 §2.4 と同じ流儀）。
 * ブラウザに読ませる（`evaluate`。担当 `browser`）は 200——ブラウザが読んで同じ解答を送り直す
 */
export function engineAnswerResponse(answer: EngineAnswer, reveal: ReturnType<typeof drillReveal>) {
  switch (answer.status) {
    case 'pending':
      return { body: { status: 'pending' as const, jobId: answer.jobId }, status: 202 as const };
    case 'busy':
      return { body: { error: '評価キューが一杯です' }, status: 503 as const };
    case 'failed':
      return { body: { error: answer.error }, status: 502 as const };
    case 'evaluate':
      // 🔒 **答えは載せない**（`reveal` を付けない）。局面・利用者の手・読む設定だけ
      return {
        body: { status: 'evaluate' as const, sfen: answer.sfen, move: answer.move, settings: answer.settings },
        status: 200 as const,
      };
    case 'continue':
      return { body: { status: 'continue' as const, reply: answer.reply }, status: 200 as const };
    case 'miss':
      // 🔒 **答えは載せない**（`reveal` を付けない）。利用者は取り消して続ける（prd/13 §5.2）
      return { body: answer, status: 200 as const };
    case 'done':
      return { body: { ...answer, ...reveal }, status: 200 as const };
  }
}

/** 解答の本文（route の zod で検証済み） */
export interface AnswerRequest {
  /** 出題局面からの全手順（受方の応手を含み、最後がユーザーの手） */
  line: string[];
  /** 採点の線引き（閲覧者の設定。prd/13 §5.1）。届かなければ既定 */
  correctMargin?: number;
  closeMargin?: number;
  /** ブラウザの名指し評価（`evaluate` を受けたブラウザが付けて送り直す。prd/13 §5.3） */
  evaluation?: DrillNamedEvaluation;
  /** 「この端末では読めない」の申告（詰将棋。prd/13 §5.5） */
  browserUnavailable?: boolean;
  /** 練習（解答後の「最初からやり直す」）。判定は返すが記録しない（prd/13 §5.3） */
  practice?: boolean;
}

/** 解答の流れが外に頼むこと（DB・メモリ・エンジン） */
export interface AnswerDeps {
  /** 覚えた別解の手順（無ければ null。`drill-lines.ts`） */
  recallLine(drillId: number): string[] | null;
  /** 解き終えた問題の手順を忘れる。🔒 **コミットの後**に回す（呼び出し側の責務） */
  forgetLine(drillId: number): void;
  /** 解答を 1 件記録する（`drill-query.ts` の `recordAttempt`）。練習のときは呼ばない */
  recordAttempt(attempt: {
    drillId: number;
    ownerId: string;
    move: string;
    line: string[];
    verdict: DrillVerdict;
    lossCp: number | null;
  }): Promise<void>;
  /** 解析の担当（prd/14 §5.7）。エンジンに回すときにだけ読む */
  analysisAssignee(): Promise<AnalysisAssignee | null>;
  /** エンジンでの採点（`drill-engine.ts` の `resolveWithEngine`） */
  resolveWithEngine(input: EngineRequest): Promise<EngineAnswer>;
}

/**
 * 解答を採点する（prd/13 §5）。応答の本文とステータスの組を返す。
 *
 * - 🔴 **手順が問いに対応していることを、局面を作る前に確かめる**（レビュー `OCL-41F41851`）。任意の派生局面を
 *   作らせると、**別の局面で採点して出題局面の最善値と比べる**ことになる。詰将棋は元の正解手順と覚えた別解の
 *   どちらかの先頭と一致すれば受ける（2026-10-19 決定。prd/13 §5.2）
 * - 🔒 **評価の手が解答の手と違えば受けない**（別の手の評価で採点させない。prd/14 §5.8）
 * - 🔴 **駒の動き方も見る**（レビュー `OCL-1A2B07B9`）。`validateMoveOnPosition` は合法性を問わない（検討盤と共用）
 * - 次の一手は**出題時の候補手にあれば往復ゼロで採点する**（prd/13 §5.1）。外の手はエンジンに回す
 * - 詰将棋は**王手でない手は間違い**（prd/13 §5.2）。手順どおりなら受方の応手を返し、外れたらエンジンに聞く
 */
export async function gradeAnswer(drill: AnswerDrill, request: AnswerRequest, deps: AnswerDeps) {
  const { line, evaluation, practice, browserUnavailable } = request;
  const { id } = drill;
  const scoring: DrillScoring = {
    correctMargin: request.correctMargin ?? DEFAULT_SCORING.correctMargin,
    closeMargin: request.closeMargin ?? DEFAULT_SCORING.closeMargin,
  };

  // 1. 手順の照合（局面を作る前）。覚えた別解だけで照らすと、「最初からやり直す」で元の手順を指したときに 400 になる
  const mateMatch = drill.kind === 'mate' ? matchMateLine([deps.recallLine(id), drill.answerPv], line) : null;
  if (drill.kind === 'best' ? line.length !== 1 : mateMatch?.state === 'mismatch') {
    return { body: { error: '手順が出題と噛み合いません' }, status: 400 as const };
  }

  // 2. 出題局面 → `line` の 1 手前まで進めた局面。ここがユーザーの手を指す局面
  const base = drillPosition(drill.usiMoves, drill.moveNumber);
  if (!base) return { body: { error: '出題局面を再現できません' }, status: 409 as const };
  const move = line[line.length - 1];
  // 3. 評価の手との一致
  if (evaluation && evaluation.move !== move) {
    return { body: { error: '評価の手が解答と噛み合いません' }, status: 400 as const };
  }
  const state = applyLine(base, line.slice(0, -1));
  if (!state) return { body: { error: '手順を再現できません' }, status: 400 as const };

  // 4. 指せる手か。エンジンに渡す前の検証（prd/12 §2.5。クラッシュ・ハングさせうる手を落とす）と、駒の動き方
  const check = validateMoveOnPosition(state, move);
  if (!check.ok) {
    return { body: { error: 'その手は指せません', violations: check.violations }, status: 400 as const };
  }
  if (!isReachableMove(state, move)) {
    return { body: { error: 'その手は指せません' }, status: 400 as const };
  }

  // 解答後にだけ返す情報（ネタバレ回避。prd/13 §7）。棋譜は番号で返す（prd/14 §4.4）
  const reveal = drillReveal(drill, line);
  /** 解答の記録。🔒 練習（`practice`）は書かない */
  const record = async (verdict: DrillVerdict, lossCp: number | null) => {
    if (practice) return;
    await deps.recordAttempt({ drillId: id, ownerId: drill.ownerId, move, line, verdict, lossCp });
  };
  /** エンジンに回す（担当は回すときにだけ読む） */
  const withEngine = async (mateRemainingPlies?: number) =>
    engineAnswerResponse(
      await deps.resolveWithEngine({
        assignee: await deps.analysisAssignee(),
        ...(evaluation ? { browserEvaluation: { candidate: evaluation.candidate } } : {}),
        ...(browserUnavailable ? { browserUnavailable: true } : {}),
        ...(mateRemainingPlies !== undefined ? { mateRemainingPlies } : {}),
        drill,
        state,
        move,
        line,
        scoring,
        practice,
      }),
      reveal,
    );

  if (mateMatch) {
    // 🔴 **王手でない手は間違い**（prd/13 §5.2・2026-10-19 決定）。エンジンの mate は静かな手も
    // 詰みと数えるので、エンジン（棋譜解析の再利用・worker・ブラウザ）に回す前に盤面で見る。
    // 🔒 ブラウザに `evaluate` を返さない。手数の上限は設けない（王手の連続で詰むなら回り道でも別解）。
    // 終わりにはしない（`miss`。利用者は取り消して続ける）。🔒 **答えは載せない**。
    // 不正解は記録する（最初に間違えた時点。以降は web が `practice` で送る）
    if (!givesCheck(state, move, state.sideToMove)) {
      await record('wrong', null);
      return { body: { status: 'miss' as const, wrongReason: 'not_check' as const }, status: 200 as const };
    }
    if (mateMatch.state === 'match') {
      if (!mateMatch.solved) {
        // 途中。受方の応手だけ返す（**残りの手順は渡さない**）
        return { body: { status: 'continue' as const, reply: mateMatch.reply }, status: 200 as const };
      }
      await record('correct', null);
      deps.forgetLine(id);
      // ⚠ `lossCp` は必ず載せる（mate では常に null）。応答の形を分岐で変えない
      return {
        body: { status: 'done' as const, verdict: 'correct' as const, lossCp: null, ...reveal },
        status: 200 as const,
      };
    }
    // 手順から外れた。**別解かもしれない**のでエンジンに聞く（prd/13 §5.2）。
    // 詰将棋は担当によらずブラウザで読み、上限は残り手数で決める（prd/13 §5.5）
    return withEngine(mateMatch.state === 'deviated' ? mateMatch.remainingPlies : 0);
  }

  // 次の一手。**出題時の候補手にあれば往復ゼロで採点する**（prd/13 §5.1）
  const scored = scoreFromCandidates(drill, move, scoring);
  if (scored) {
    await record(scored.verdict, scored.lossCp);
    return { body: { status: 'done' as const, ...scored, ...reveal }, status: 200 as const };
  }
  return withEngine();
}
