/**
 * 出題の解答の口（`POST /api/drills/:kifuNo/:moveNumber/:kind/answer`。prd/13 §5.3）の応答を、次にすることで分ける。
 *
 * - `wait-job`（202 `pending`）: 手元 worker の名指し評価を待って、同じ本文を投げ直す（担当がサーバーのとき）
 * - `evaluate`（200 `evaluate`）: このブラウザのエンジンで名指しで読み、結果を付けて同じ解答を送り直す（担当がブラウザのとき）
 * - `continue` / `done`: 詰みが続く / 採点が確定した
 *
 * 🔒 **判定は server**。ここは応答の振り分けと、送り直しの本文の組み立てだけ。
 */
import type { BrowserAnalysisSettings, DrillNamedEvaluation } from 'shared';

/** 解答の本文（送り直しても `line` と線引きは変えない） */
export interface AnswerBody {
  line: string[];
  correctMargin?: number;
  closeMargin?: number;
  evaluation?: DrillNamedEvaluation;
}

/** ブラウザに読ませる局面と手（`status: 'evaluate'` の中身） */
export interface EvaluateRequest {
  sfen: string;
  move: string;
  settings: BrowserAnalysisSettings;
}

export type AnswerStep<Done> =
  | { kind: 'wait-job'; jobId: string }
  | { kind: 'evaluate'; request: EvaluateRequest }
  | { kind: 'continue'; reply: string }
  | { kind: 'done'; result: Done }
  | { kind: 'error'; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isSettings(value: unknown): value is BrowserAnalysisSettings {
  if (!isRecord(value)) return false;
  return ['movetimeMs', 'multiPv', 'hashMb', 'maxThreads', 'chunkIntervalMs', 'chunkMaxPositions', 'pvMaxPlies'].every(
    (key) => typeof value[key] === 'number',
  );
}

/**
 * 応答（HTTP ステータスと、読めた本文。読めなければ null）を次にすることにする。
 * ⚠ 本文を読めない（前段が返す HTML など）ときは、ステータスで文を作る（通信断と取り違えない。prd/12 §2.4）
 */
export function answerStepOf<Done>(status: number, body: unknown): AnswerStep<Done> {
  if (status === 202) {
    if (isRecord(body) && typeof body.jobId === 'string') return { kind: 'wait-job', jobId: body.jobId };
    return { kind: 'error', text: `サーバーエラー (${status})` };
  }
  if (status < 200 || status >= 300) {
    if (isRecord(body) && 'error' in body) return { kind: 'error', text: String(body.error) };
    return { kind: 'error', text: `サーバーエラー (${status})` };
  }
  if (!isRecord(body)) return { kind: 'error', text: `サーバーエラー (${status})` };
  switch (body.status) {
    case 'evaluate':
      if (typeof body.sfen === 'string' && typeof body.move === 'string' && isSettings(body.settings)) {
        return { kind: 'evaluate', request: { sfen: body.sfen, move: body.move, settings: body.settings } };
      }
      break;
    case 'continue':
      if (typeof body.reply === 'string') return { kind: 'continue', reply: body.reply };
      break;
    case 'done':
      return { kind: 'done', result: body as Done };
  }
  return { kind: 'error', text: `サーバーエラー (${status})` };
}

/**
 * ブラウザで読んだ結果を付けた、送り直しの本文。🔒 **`line` と線引きは最初の解答のまま**（server は同じ解答として判定する）
 */
export function answerBodyWithEvaluation(body: AnswerBody, evaluation: DrillNamedEvaluation): AnswerBody {
  return { ...body, evaluation };
}
