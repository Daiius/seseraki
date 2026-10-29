/**
 * API のエラー応答の形をそろえる（`{ error: 文, code: 種類 }`）。
 *
 * - `error`: 人が読む文。web はこれを画面にそのまま出す（`requestError.ts` / `drillAnswer.ts`）ので、
 *   **既存の文を変えない**（変えると画面の文が変わる）
 * - `code`: 機械が見る種類。状態コードより細かく分けたいときに使う
 * - zod の検証失敗は互換のため `{ success: false, error: { issues, name } }` のまま（`zod-validator.ts`）
 * - 想定外の例外は `app.onError`（`route.ts`）が 500 の `internal` にする。🔒 例外の文言を本文に載せない
 *   （DB のエラー文などに内部の名前が出る）
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'body_too_large'
  | 'unprocessable'
  | 'bad_gateway'
  | 'unavailable'
  | 'internal';

/** `message` を省いたときの文 */
const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  bad_request: '入力を受け付けられません',
  forbidden: 'この操作は許可されていません',
  not_found: 'not found',
  conflict: '今の状態では受け付けられません',
  body_too_large: 'body too large',
  unprocessable: '内容を処理できません',
  bad_gateway: '評価に失敗しました',
  unavailable: '一時的に使えません',
  internal: 'サーバーで問題が起きました',
};

/**
 * 404 の文（何が見つからないか）。🔒 他人のものも「無い」と同じ文にする（存在を明かさない。prd/14 §4）。
 * 文は分ける前の各口の文のまま（棋譜・名前候補・局面は英語の `not found`）
 */
export const NOT_FOUND = {
  kifu: 'not found',
  alias: 'not found',
  user: 'not found',
  position: 'not found',
  drill: '出題が見つかりません',
  evaluationJob: '評価ジョブが見つかりません',
} as const;

/**
 * エラー応答の本文（`{ error, code }`）。`extra` は本文に足す欄（`violations` など、web が読む既存の欄）。
 * Context を持たない処理（`drill-answer-flow.ts` のように本文とステータスの組を返すもの）が使う
 */
export function errorBody<C extends ApiErrorCode, E extends object = object>(
  code: C,
  message?: string,
  extra?: E,
): { error: string; code: C } & E {
  return { ...(extra as E), error: message ?? DEFAULT_MESSAGES[code], code };
}

/** エラー応答（`{ error, code }`）を返す */
export function apiError<S extends ContentfulStatusCode, C extends ApiErrorCode, E extends object = object>(
  c: Context,
  status: S,
  code: C,
  message?: string,
  extra?: E,
) {
  return c.json(errorBody(code, message, extra), status);
}

/** 状態コードから種類を決める（`HTTPException` など、種類を持たない例外を写すとき） */
export function errorCodeOf(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'body_too_large';
    case 422:
      return 'unprocessable';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'unavailable';
    default:
      return status >= 500 ? 'internal' : 'bad_request';
  }
}
