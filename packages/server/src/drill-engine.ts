/**
 * 出題時の候補手に無い手を、エンジンに採点させる（prd/13 §5.1 / §5.2 / §5.3）。
 *
 * 読む場所は解答した利用者の**解析の担当**（prd/14 §5.7）で決まる:
 * - **`worker`**: 手元 worker の名指し評価（prd/12 §2.4）にジョブを積む（`pending`）。server / worker に
 *   新しい経路を足さない——待ち時間の性質も、キャッシュも、キューの上限も共有される。
 * - **`browser`**: ジョブを積まず「この局面のこの手を名指しで読んでほしい」（`evaluate`）を返す。
 *   ブラウザが読み、結果を付けて同じ解答を送り直したら、その結果で判定する。
 *   🔒 **手元 worker にジョブを積むのは担当 `worker` の利用者だけ**（絞らないとログインした誰もが所有者の worker を使える）。
 *
 * 🔒 **判定は 1 本**（{@link judgeNamedEvaluation}）。手元 worker の結果も、棋譜解析の再利用も、ブラウザの結果も
 * 同じ関数を通す（正解 / 惜しい / 不正解・別解・詰み上がり・「候補なし」の扱い・別解の正解手順の記憶）。
 *
 * ⚠ **待ちが出るのはここだけ。** 出題時の候補手にある手と、詰みの正解手順をなぞっている間は
 * エンジンを呼ばない（prd/13 §5.1）。
 */
import { positionSfen, type BoardState, type Side } from 'shared';
import type { Tx } from './db/index.js';
import {
  BROWSER_ANALYSIS_MOVETIME_MS,
  browserAnalysisSettingsFor,
  type AnalysisAssignee,
  type BrowserStageSettings,
} from './analysis-report.js';
import {
  isMateAfter,
  scoreMove,
  type DrillAnswerKey,
  type DrillScoring,
  type DrillVerdict,
} from './drill-answer.js';
import { rememberLine } from './drill-lines.js';
import { recordAttempt } from './drill-query.js';
import {
  EvaluationQueueFullError,
  startEvaluation,
  type EvalCandidate,
} from './position-eval.js';
import { lookupKifuEvaluation } from './position-kifu-reuse.js';

/**
 * ブラウザの名指し評価の段（prd/13 §5.1）。🔒 **全局面解析の深い段（full）と同じ時間**で読む
 * （定数は `BROWSER_ANALYSIS_MOVETIME_MS` を共有する。値を 2 か所に持たない）
 */
export const DRILL_BROWSER_EVAL_PROFILE = 'full' as const;

/** ブラウザに名指しで読ませる設定（全局面解析の full の設定そのもの。思考時間 600ms） */
export function drillBrowserEvalSettings(): BrowserStageSettings {
  return browserAnalysisSettingsFor(DRILL_BROWSER_EVAL_PROFILE);
}

/** ブラウザの名指しの思考時間（ms）。テスト・文書の照合用 */
export const DRILL_BROWSER_EVAL_MOVETIME_MS = BROWSER_ANALYSIS_MOVETIME_MS[DRILL_BROWSER_EVAL_PROFILE];

export type EngineAnswer =
  /** まだ出ていない。要求側は `GET /positions/evaluate/:jobId` で取りに来て、同じ body を投げ直す */
  | { status: 'pending'; jobId: string }
  /**
   * ブラウザに読ませる（担当 `browser`）。🔒 **答えは何も含めない**——局面はいま利用者が見ている局面、
   * 手は利用者自身の手、設定は全局面解析の full と同じもの
   */
  | { status: 'evaluate'; sfen: string; move: string; settings: BrowserStageSettings }
  /**
   * 詰みが続いている。`reply` は**受方の応手**。
   * 🔒 **詰み上がりをここで返さない**（`done` で返す）——`continue` は「まだ続く」の意味に
   * 限る。混ぜると route が解答後の情報を付けられない（レビュー `OCL-0007A49D`）。
   */
  | { status: 'continue'; reply: string }
  | {
      status: 'done';
      verdict: DrillVerdict;
      lossCp: number | null;
      /** 不正解のときの咎め筋（相手の応手から始まる読み筋） */
      refutation?: string[];
    }
  | { status: 'failed'; error: string }
  /** キューが一杯（worker が止まっている疑い）。route は 503 で返す */
  | { status: 'busy' };

/** 名指し評価の結果（その手 1 本。`pv` の先頭が名指しした手）。どの経路の結果もこの形にそろえて判定する */
export type NamedCandidate = Pick<EvalCandidate, 'scoreType' | 'scoreValue' | 'pv'>;

export interface ResolveInput {
  /** ユーザーとして開いたトランザクション（解答の記録・棋譜解析の再利用に使う。`user-tx.ts`） */
  tx: Tx;
  /** 要求者（🔒 セッションから取った ID）。評価ジョブの持ち主・再利用する棋譜の所有者 */
  userId: string;
  /** 要求者の解析の担当（prd/14 §5.7）。読めなかった（null）ら `browser` と同じ扱い——手元 worker を使わせない */
  assignee: AnalysisAssignee | null;
  /**
   * ブラウザが読んで付けてきた名指し評価（担当 `browser` の送り直し）。`null` の中身は「候補なし」。
   * 🔒 **手は route が解答の手と照合済み**（別の手の評価で採点させない）
   */
  browserEvaluation?: { candidate: NamedCandidate | null };
  drill: DrillAnswerKey & { id: number; ownerId: string };
  /** ユーザーが手を指す**直前**の局面 */
  state: BoardState;
  move: string;
  /** 出題局面からの全手順（最後が `move`） */
  line: string[];
  scoring: DrillScoring;
  /**
   * 練習（解答後の「最初からやり直す」。prd/13 §5.3）。true なら判定は返すが **`drillAttempts` に書かない**
   * （別解の手順の記憶は通常どおり）
   */
  practice?: boolean;
}

/**
 * 評価を手元 worker / ブラウザのどちらで得るか（prd/13 §5.1・prd/14 §5.7）。
 * - `worker`: 手元 worker にジョブを積む（担当 `worker` の利用者だけ）
 * - `ask-browser`: ブラウザに名指しで読ませる（担当 `browser` で、まだ結果が付いていない）
 * - `use-browser`: ブラウザが付けてきた結果で判定する
 *
 * 🔒 担当 `worker` の利用者がブラウザの結果を付けてきても使わない（担当を切り替えた直後の送り直しなど）。
 * 担当が読めない（null）ときは手元 worker を使わせない
 */
export function evaluationSourceOf(
  assignee: AnalysisAssignee | null,
  hasBrowserEvaluation: boolean,
): 'worker' | 'ask-browser' | 'use-browser' {
  if (assignee === 'worker') return 'worker';
  return hasBrowserEvaluation ? 'use-browser' : 'ask-browser';
}

/** 判定の結果。副作用（解答の記録・別解の手順の記憶）は呼び出し側が行う */
export interface Judged {
  answer: Extract<EngineAnswer, { status: 'continue' | 'done' }>;
  /** 記録する判定（`continue` では null——まだ解き終わっていない） */
  attempt: { verdict: DrillVerdict; lossCp: number | null } | null;
  /** 以降の正解手順として覚える手順（別解に入ったとき。prd/13 §5.2） */
  remember: string[] | null;
}

/**
 * 名指し評価の結果から判定する（prd/13 §5.1・§5.2）。**純関数**——どの経路の結果もここを通す。
 *
 * @param best 名指しした手の評価。`undefined` は「候補なし」（その手で相手に指す手が無い・エンジンが評価を出さない）
 */
export function judgeNamedEvaluation(
  input: Pick<ResolveInput, 'drill' | 'state' | 'move' | 'line' | 'scoring'>,
  best: NamedCandidate | undefined,
): Judged {
  const { drill, state, move, line, scoring } = input;
  const attacker: Side = state.sideToMove;
  const done = (verdict: DrillVerdict, lossCp: number | null, refutation?: string[]): Judged => ({
    answer: { status: 'done', verdict, lossCp, ...(refutation ? { refutation } : {}) },
    attempt: { verdict, lossCp },
    remember: null,
  });

  // 🔴 **「候補なし」を「詰みません」と読まない**（prd/13 §5.2・レビュー `OCL-7ABC2973`）。
  // `searchmoves` 非対応の worker はフォールバックで手を適用した局面を評価するため、
  // **その手が即詰みなら相手に指す手が無く候補が空で返る**。次の一手の問いでも同じで、
  // **その手で詰んでいる**ことを意味するので詰みと同じ扱いで正解にする。
  // 🔴 **詰み上がりは `done`。** `continue` で返すと route が解答後の情報を付けられず、
  // **同じ解答を投げ直しても永久に `continue` が返る**（レビュー `OCL-0007A49D`）。
  // 🔒 **不正解も記録する。** 記録を落とすと `wrongBefore`・解答済み件数・復習順の
  // どれにも表れない（レビュー `OCL-2652C1DA`）
  if (!best) {
    return done(isMateAfter(state, move, attacker) ? 'correct' : 'wrong', null);
  }

  if (drill.kind === 'mate') {
    if (best.scoreType === 'mate' && best.scoreValue > 0) {
      // 別解として正解。**返ってきた pv を以降の正解手順として引き継ぐ**（prd/13 §5.2）。
      // pv の先頭は名指しした手なので、手順は「ここまでの line + pv の残り」になる
      const reply = best.pv[1] ?? null;
      // 読み筋がこの手で終わっている ＝ 詰み上がり。**`done` で返す**（上と同じ理由）
      if (reply === null) return done('correct', null);
      return {
        answer: { status: 'continue', reply },
        attempt: null,
        remember: [...line, ...best.pv.slice(1)],
      };
    }
    // 詰まない。咎め筋（受けの手）を見せる
    return done('wrong', null, best.pv.slice(1));
  }

  const scored = scoreMove(drill, best, scoring);
  return done(scored.verdict, scored.lossCp, scored.verdict === 'wrong' ? best.pv.slice(1) : undefined);
}

/** 判定を反映する（解答の記録・別解の手順の記憶）。副作用はここに寄せる */
async function settle(input: ResolveInput, best: NamedCandidate | undefined): Promise<EngineAnswer> {
  const { tx, drill, move, line } = input;
  const judged = judgeNamedEvaluation(input, best);
  if (judged.attempt && !input.practice) {
    await recordAttempt(tx, { drillId: drill.id, ownerId: drill.ownerId, move, line, ...judged.attempt });
  }
  if (judged.remember) rememberLine(drill.id, judged.remember);
  return judged.answer;
}

export async function resolveWithEngine(input: ResolveInput): Promise<EngineAnswer> {
  const { tx, userId, state, move } = input;
  const sfen = positionSfen(state);

  // 🔴 **エンジンに積む前に、既存の棋譜解析から引く**（prd/12 §2.6）。出題は棋譜の局面
  // そのものなので、**実戦で指した手を答えたときはここで即答できる**（担当によらない。読み直しを待たせない）
  // 🔴 再利用は**要求者の棋譜からだけ**（prd/14 §4）
  const reused = await lookupKifuEvaluation(tx, userId, { sfen, move });
  if (reused) return settle(input, reused.candidates[0]);

  switch (evaluationSourceOf(input.assignee, input.browserEvaluation !== undefined)) {
    case 'ask-browser':
      return { status: 'evaluate', sfen, move, settings: drillBrowserEvalSettings() };
    case 'use-browser':
      return settle(input, input.browserEvaluation?.candidate ?? undefined);
    case 'worker':
      break;
  }

  let started: ReturnType<typeof startEvaluation>;
  try {
    started = startEvaluation({ sfen, move }, userId);
  } catch (err) {
    if (err instanceof EvaluationQueueFullError) return { status: 'busy' };
    throw err;
  }
  if (started.state !== 'settled') return { status: 'pending', jobId: started.jobId };
  const outcome = started.outcome;
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error };
  return settle(input, outcome.candidates[0]);
}
