/**
 * 検討局面の評価要求（prd/12 §2）。`POST /api/positions/evaluate` を叩く。
 *
 * 🔴 **結果が出るまで待つ long-poll**（既存解析にあれば数十 ms、エンジンなら数秒〜十数秒。
 * prd/12 §2.4）。押しっぱなしで待たせる以上、**中断できることが要件**なので
 * `AbortSignal` を必ず受ける。押し直したら前の要求を abort する（二重送信の抑止は
 * 呼び出し側の状態機械が持つ。前例は `routes/positions.tsx` の 4 状態）。
 *
 * 🔒 **既存解析の再利用判定（prd/12 §2.6）は server の 1 か所にある。**
 * ここに同じ判定を持たせない。web は応答の `source` を**そのまま出す**だけ
 * （どこから来た値かを黙って混ぜない）。
 */
import type { BoardState, PositionViolation } from 'shared';
import { validateMoveOnPosition, validatePositionForEngine } from 'shared';
import { client } from './honoClient';
import type { EvalTarget } from './study';

/** 候補手 1 本（server の `EvalCandidate`。スコアは**手番側から見た値**） */
export interface EvalCandidateView {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
  pv: string[];
  depth: number;
}

/** 値の出所（prd/12 §2.6）。UI に必ず出す */
export type EvalSource = 'kifu' | 'engine';

export type EvalResult =
  | {
      kind: 'done';
      candidates: EvalCandidateView[];
      source: EvalSource;
      /** 名指し評価を「手を適用した局面の符号反転」で求めたか（prd/12 §2.2） */
      fallback: boolean;
      evaluatedAt: string;
    }
  /** 局面・指し手が検証で弾かれた（クライアント検証 / server の 400 の両方が来る） */
  | { kind: 'invalid'; violations: PositionViolation[] }
  /** キューが一杯（503）。worker が止まっている疑い */
  | { kind: 'busy' }
  /** 呼び出し側が abort した。**画面には何も出さない**（押し直しの合図） */
  | { kind: 'aborted' }
  /** ジョブが失敗した / 通信できなかった */
  | { kind: 'failed'; message: string };

/**
 * 送る前にクライアント側で検証する（prd/12 §2.5 の検証は `shared` の 1 つ）。
 * **往復を減らすため**で、server 側の検証を省く話ではない（server も同じ関数を通す）。
 *
 * ⚠ 名指し評価の `state` は**その手を指す前の局面**（`namedEvalTarget` が返す SFEN の元）。
 */
export function validateEvalTarget(
  state: BoardState,
  move: string | null,
): PositionViolation[] {
  const position = validatePositionForEngine(state);
  const violations = position.ok ? [] : [...position.violations];
  if (move !== null) {
    const checked = validateMoveOnPosition(state, move);
    if (!checked.ok) violations.push(...checked.violations);
  }
  return violations;
}

/** 応答の形（Hono RPC の union をここで 1 度だけ受け止める） */
interface EvaluateResponse {
  status?: 'done' | 'failed';
  candidates?: EvalCandidateView[];
  source?: EvalSource;
  fallback?: boolean;
  evaluatedAt?: string;
  error?: string;
  violations?: PositionViolation[];
}

/** 評価を要求して結果を待つ。**例外は投げない**（すべて `EvalResult` に畳む） */
export async function requestPositionEval(
  target: EvalTarget,
  signal: AbortSignal,
): Promise<EvalResult> {
  try {
    const res = await client.api.positions.evaluate.$post(
      { json: { sfen: target.sfen, move: target.move } },
      { init: { signal } },
    );
    const body = (await res.json()) as unknown as EvaluateResponse;

    if (res.status === 400) {
      return { kind: 'invalid', violations: body.violations ?? [] };
    }
    if (res.status === 503) return { kind: 'busy' };
    if (!res.ok) {
      return { kind: 'failed', message: `サーバーエラー (${res.status})` };
    }
    if (body.status === 'failed') {
      return { kind: 'failed', message: body.error ?? '評価に失敗しました' };
    }
    return {
      kind: 'done',
      candidates: body.candidates ?? [],
      source: body.source ?? 'engine',
      fallback: body.fallback ?? false,
      evaluatedAt: body.evaluatedAt ?? '',
    };
  } catch (err) {
    // abort は呼び出し側が意図して止めた合図。**画面にエラーを出さない**ので、
    // 呼び出し側が捨てられるように専用の形で返す
    if (err instanceof Error && err.name === 'AbortError') {
      return { kind: 'aborted' };
    }
    return { kind: 'failed', message: 'サーバーに接続できません' };
  }
}
