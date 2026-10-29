/**
 * API の呼び出し（Hono RPC の 1 往復）を、成否で分けた結果にする。
 *
 * 画面ごとに「try → `!res.ok` なら『サーバーエラー (status)』→ catch なら『接続できません』」を
 * 手で書いていたのをここに集める。
 *
 * - 2xx: `{ ok: true, status, data }`（本文は JSON として読む）
 * - 2xx 以外: `{ ok: false, status, error, code?, violations? }`。`error` は server の本文の `error`
 *   （`api-error.ts` の `{ error, code }`）を優先し、使えなければ `fallback(status)`
 * - 通信そのものの失敗（届かない・本文が読めない）: `{ ok: false, error: network }`（`status` は無い）
 *
 * 役割の分担: ここは「応答を成否に分け、server の文を拾う」まで。書き込みの失敗を状態コードごとの
 * 言い回し（413・401・403 など）で出す決めごとは `requestError.ts` の `responseErrorMessage` にあり、
 * 使う側が `describe` に渡す。
 */
import type { ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';

/** 通信そのものの失敗の既定の文 */
export const CONNECTION_ERROR = 'サーバーに接続できません';

/** 2xx 以外で、server の文が使えないときの既定の文 */
export const serverErrorText = (status: number) => `サーバーエラー (${status})`;

export type ApiFailure = {
  ok: false;
  /** 応答の状態コード。通信そのものの失敗では無い */
  status?: number;
  /** 画面に出す文 */
  error: string;
  /** server の本文の種類（`api-error.ts` の `ApiErrorCode`） */
  code?: string;
  /** 指せない手・局面の理由（`positions` / 出題の解答の 400） */
  violations?: unknown;
};

export type ApiResult<T> = { ok: true; status: number; data: T } | ApiFailure;

/** 応答の型から、2xx の本文の型を取り出す（状態コードごとのユニオンを 2xx に絞る） */
export type SuccessData<R> =
  R extends ClientResponse<infer T, infer S, infer _F>
    ? [Extract<S, SuccessStatusCode>] extends [never]
      ? never
      : T
    : never;

/** エラーの本文（`{ error, code?, violations? }`）から読めた欄。形が違えば空 */
export interface ErrorBody {
  error?: string;
  code?: string;
  violations?: unknown;
}

/**
 * エラーの本文を読む。zod の検証失敗（`{ success: false, error: { issues } }`）の `error` は文ではないので拾わない
 */
export function readErrorBody(body: unknown): ErrorBody {
  if (typeof body !== 'object' || body === null) return {};
  const record = body as Record<string, unknown>;
  return {
    ...(typeof record.error === 'string' && record.error !== '' ? { error: record.error } : {}),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...('violations' in record ? { violations: record.violations } : {}),
  };
}

/**
 * server の文を画面に出してよいか。
 * - 🔒 **5xx は出さない**——`internal` の文は中身の無い定型文で、状態コードの方が手がかりになる
 * - `not_found` / `body_too_large` の文は英語の内部向け（`not found` / `body too large`）なので出さない
 */
function displayableServerError(status: number, body: ErrorBody): string | undefined {
  if (status >= 500) return undefined;
  if (body.code === 'not_found' || body.code === 'body_too_large') return undefined;
  return body.error;
}

export interface CallApiOptions {
  /** server の文が使えないときの文。既定は `サーバーエラー (status)` */
  fallback?: (status: number) => string;
  /**
   * 2xx 以外の文を状態コードと本文から自分で決める（`fallback` と server の文の優先より強い）。
   * 書き込みの失敗を `responseErrorMessage` の言い回しで出すときに使う
   */
  describe?: (status: number, body: unknown) => string;
  /** 通信そのものの失敗の文。既定は {@link CONNECTION_ERROR} */
  network?: string;
}

/**
 * 1 往復を結果にする。**例外を投げない**（呼び出し側は `ok` で分ける）。
 * 本文の読み取りは状態コードを見た後（前段が返す HTML で落ちても、2xx 以外なら状態コードの文になる）
 */
// 応答の型は口ごとに違う（状態コードごとのユニオン）ので any で受ける
export async function callApi<R extends ClientResponse<any, any, any>>(
  request: Promise<R>,
  options: CallApiOptions = {},
): Promise<ApiResult<SuccessData<R>>> {
  const network = options.network ?? CONNECTION_ERROR;
  let res: R;
  try {
    res = await request;
  } catch {
    return { ok: false, error: network };
  }
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => null);
    const body = readErrorBody(raw);
    const error =
      options.describe?.(res.status, raw) ??
      displayableServerError(res.status, body) ??
      (options.fallback ?? serverErrorText)(res.status);
    return {
      ok: false,
      status: res.status,
      error,
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.violations !== undefined ? { violations: body.violations } : {}),
    };
  }
  try {
    return { ok: true, status: res.status, data: (await res.json()) as SuccessData<R> };
  } catch {
    return { ok: false, error: network };
  }
}
