/**
 * 出題時の候補手に無い手を、エンジンに採点させる（prd/13 §5.1 / §5.2）。
 *
 * 🔒 **評価の口は既存の名指し評価をそのまま使う**（prd/12 §2.4）。server / worker に
 * 新しい経路を足さない——待ち時間の性質も、キャッシュも、キューの上限も共有される。
 *
 * ⚠ **待ちが出るのはここだけ。** 出題時の候補手にある手と、詰みの正解手順をなぞっている間は
 * エンジンを呼ばない（prd/13 §5.1）。
 */
import { positionSfen, type BoardState, type Side } from 'shared';
import { db } from './db';
import { isMateAfter, scoreMove, type DrillAnswerKey, type DrillScoring } from './drill-answer';
import { rememberLine } from './drill-lines';
import { recordAttempt } from './drill-query';
import {
  EvaluationQueueFullError,
  startEvaluation,
  type EvalCandidate,
} from './position-eval';
import { lookupKifuEvaluation } from './position-kifu-reuse';

export type EngineAnswer =
  /** まだ出ていない。要求側は `GET /positions/evaluate/:jobId` で取りに来て、同じ body を投げ直す */
  | { status: 'pending'; jobId: string }
  /** 詰みが続いている。受方の応手（`null` なら詰み上がり） */
  | { status: 'continue'; reply: string | null }
  | {
      status: 'done';
      verdict: 'correct' | 'close' | 'wrong';
      lossCp: number | null;
      /** 不正解のときの咎め筋（相手の応手から始まる読み筋） */
      refutation?: string[];
    }
  | { status: 'failed'; error: string }
  /** キューが一杯（worker が止まっている疑い）。route は 503 で返す */
  | { status: 'busy' };

export interface ResolveInput {
  drill: DrillAnswerKey & { id: number };
  /** ユーザーが手を指す**直前**の局面 */
  state: BoardState;
  move: string;
  /** 出題局面からの全手順（最後が `move`） */
  line: string[];
  scoring: DrillScoring;
}

export async function resolveWithEngine(input: ResolveInput): Promise<EngineAnswer> {
  const { drill, state, move, line, scoring } = input;
  const sfen = positionSfen(state);

  // 🔴 **エンジンに積む前に、既存の棋譜解析から引く**（prd/12 §2.6）。出題は棋譜の局面
  // そのものなので、**実戦で指した手を答えたときはここで即答できる**
  const reused = await lookupKifuEvaluation({ sfen, move });
  const outcome =
    reused ??
    (() => {
      try {
        const started = startEvaluation({ sfen, move });
        return started.state === 'settled' ? started.outcome : started;
      } catch (err) {
        if (err instanceof EvaluationQueueFullError) return { state: 'busy' as const };
        throw err;
      }
    })();

  if ('state' in outcome) {
    return outcome.state === 'busy'
      ? { status: 'busy' }
      : { status: 'pending', jobId: outcome.jobId };
  }
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error };

  const [best] = outcome.candidates;
  if (drill.kind === 'mate') return mateAnswer(input, sfen, best);

  if (!best) {
    // 名指し評価が候補なし ＝ その手で相手に指す手が無い。次の一手の問いでは
    // **その手で詰んでいる**ことを意味するので、詰みと同じ扱いで正解にする（prd/13 §5.2）
    const solved = isMateAfter(state, move, state.sideToMove);
    const scored = { verdict: solved ? ('correct' as const) : ('wrong' as const), lossCp: null };
    await recordAttempt(db, { drillId: drill.id, move, ...scored });
    return { status: 'done', ...scored };
  }

  const scored = scoreMove(drill, best, scoring);
  await recordAttempt(db, { drillId: drill.id, move, ...scored });
  return {
    status: 'done',
    ...scored,
    ...(scored.verdict === 'wrong' ? { refutation: best.pv.slice(1) } : {}),
  };
}

/** 詰みの別解を判定する（prd/13 §5.2） */
async function mateAnswer(
  input: ResolveInput,
  _sfen: string,
  best: EvalCandidate | undefined,
): Promise<EngineAnswer> {
  const { drill, state, move, line } = input;
  const attacker: Side = state.sideToMove;

  // 🔴 **「候補なし」を「詰みません」と読まない**（prd/13 §5.2・レビュー `OCL-7ABC2973`）。
  // `searchmoves` 非対応の worker はフォールバックで手を適用した局面を評価するため、
  // **その手が即詰みなら相手に指す手が無く候補が空で返る**
  if (!best) {
    if (isMateAfter(state, move, attacker)) {
      await recordAttempt(db, { drillId: drill.id, move, verdict: 'correct', lossCp: null });
      return { status: 'continue', reply: null };
    }
    return { status: 'done', verdict: 'wrong', lossCp: null };
  }

  if (best.scoreType === 'mate' && best.scoreValue > 0) {
    // 別解として正解。**返ってきた pv を以降の正解手順として引き継ぐ**（prd/13 §5.2）。
    // pv の先頭は名指しした手なので、手順は「ここまでの line + pv の残り」になる
    rememberLine(drill.id, [...line, ...best.pv.slice(1)]);
    const reply = best.pv[1] ?? null;
    if (reply === null) {
      await recordAttempt(db, { drillId: drill.id, move, verdict: 'correct', lossCp: null });
    }
    return { status: 'continue', reply };
  }
  // 詰まない。咎め筋（受けの手）を見せる
  await recordAttempt(db, { drillId: drill.id, move, verdict: 'wrong', lossCp: null });
  return { status: 'done', verdict: 'wrong', lossCp: null, refutation: best.pv.slice(1) };
}
