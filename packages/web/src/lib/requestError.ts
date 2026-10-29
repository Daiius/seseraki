import { readErrorBody } from './callApi';

/**
 * 書き込みの失敗を画面に出す文（棋譜の登録・名前候補の編集など）。`callApi` の `describe` に渡して使う。
 *
 * server の 4xx の本文は形がまちまち: `{ error: '…' }`（文）と、zod の検証失敗の
 * `{ success: false, error: { issues, name } }`（文ではない）がある。文ならそのまま出し、そうでなければ状態コードから決める。
 * 本文の読み取りは `callApi.ts` の `readErrorBody`（読み出しの失敗の既定の文もそちら）。
 */
export function responseErrorMessage(status: number, body: unknown): string {
  const { error } = readErrorBody(body);
  if (status === 413) return '大きすぎて送れませんでした。';
  if (status === 401) return 'ログインが切れました。ログインし直してください。';
  if (status === 403) return 'この操作は許可されていません（ページを開き直してください）。';
  if (error !== undefined) return error;
  if (status === 400) return '入力の内容を受け付けられませんでした（長すぎる・形が違うなど）。';
  return `失敗しました（${status}）。`;
}

/** 通信そのものの失敗（server に届かない・応答が無い）の文 */
export const NETWORK_ERROR_MESSAGE = 'サーバーに接続できませんでした。通信の状態を確かめて、もう一度試してください。';
