import { describe, expect, it } from 'vitest';
import type { ClientResponse } from 'hono/client';
import { callApi, readErrorBody } from './callApi';
import { responseErrorMessage } from './requestError';

/** 状態コードと本文だけを持つ応答（`callApi` が読むのは ok / status / json だけ） */
function reply(status: number, body: unknown): Promise<ClientResponse<unknown, number, 'json'>> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () =>
      body instanceof Error ? Promise.reject(body) : Promise.resolve(body),
  } as unknown as ClientResponse<unknown, number, 'json'>);
}

describe('callApi', () => {
  it('2xx は本文を data にする', async () => {
    expect(await callApi(reply(200, { a: 1 }))).toEqual({ ok: true, status: 200, data: { a: 1 } });
  });

  it('2xx 以外で本文に文が無ければ「サーバーエラー (status)」', async () => {
    expect(await callApi(reply(500, null))).toEqual({
      ok: false,
      status: 500,
      error: 'サーバーエラー (500)',
    });
  });

  it('4xx は server の本文の error を優先し、code と violations も返す', async () => {
    const result = await callApi(
      reply(400, { error: 'その手は指せません', code: 'bad_request', violations: ['nifu'] }),
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'その手は指せません',
      code: 'bad_request',
      violations: ['nifu'],
    });
  });

  it('5xx・not_found・body_too_large の文は出さず状態コードの文にする（定型文・英語の内部向けの文）', async () => {
    expect(await callApi(reply(500, { error: 'サーバーで問題が起きました', code: 'internal' }))).toMatchObject({
      error: 'サーバーエラー (500)',
      code: 'internal',
    });
    expect(await callApi(reply(404, { error: 'not found', code: 'not_found' }))).toMatchObject({
      error: 'サーバーエラー (404)',
    });
    expect(await callApi(reply(413, { error: 'body too large', code: 'body_too_large' }))).toMatchObject({
      error: 'サーバーエラー (413)',
    });
  });

  it('zod の検証失敗（error が文でない）は状態コードの文にする', async () => {
    const result = await callApi(reply(400, { success: false, error: { issues: [], name: 'ZodError' } }));
    expect(result).toMatchObject({ ok: false, status: 400, error: 'サーバーエラー (400)' });
  });

  it('エラーの本文が JSON でなくても状態コードの文になる（前段が返す HTML など）', async () => {
    expect(await callApi(reply(502, new SyntaxError('html')))).toEqual({
      ok: false,
      status: 502,
      error: 'サーバーエラー (502)',
    });
  });

  it('fallback で状態コードの文を差し替える（server の文があればそちらが先）', async () => {
    const fallback = (s: number) => `保存失敗 (${s})`;
    expect(await callApi(reply(500, null), { fallback })).toMatchObject({ error: '保存失敗 (500)' });
    expect(await callApi(reply(409, { error: '重複' }), { fallback })).toMatchObject({ error: '重複' });
  });

  it('describe は server の文より強い（書き込みの言い回し）', async () => {
    const result = await callApi(reply(413, { error: 'body too large' }), {
      describe: responseErrorMessage,
    });
    expect(result).toMatchObject({ ok: false, status: 413, error: '大きすぎて送れませんでした。' });
  });

  it('通信の失敗は status 無しで「接続できません」（network で差し替えられる）', async () => {
    expect(await callApi(Promise.reject(new TypeError('Failed to fetch')))).toEqual({
      ok: false,
      error: 'サーバーに接続できません',
    });
    expect(
      await callApi(Promise.reject(new TypeError('x')), { network: '届きません' }),
    ).toEqual({ ok: false, error: '届きません' });
  });

  it('2xx の本文が読めなければ通信の失敗と同じ扱い', async () => {
    expect(await callApi(reply(200, new SyntaxError('html')))).toEqual({
      ok: false,
      error: 'サーバーに接続できません',
    });
  });
});

describe('readErrorBody', () => {
  it('形が違えば空', () => {
    expect(readErrorBody(null)).toEqual({});
    expect(readErrorBody('text')).toEqual({});
    expect(readErrorBody({ error: '' })).toEqual({});
  });

  it('文の error と code・violations を拾う', () => {
    expect(readErrorBody({ error: 'x', code: 'conflict', violations: [] })).toEqual({
      error: 'x',
      code: 'conflict',
      violations: [],
    });
  });
});
