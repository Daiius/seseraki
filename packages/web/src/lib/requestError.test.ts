import { describe, expect, it } from 'vitest';
import { responseErrorMessage } from './requestError';

describe('responseErrorMessage', () => {
  it('本文の error が文ならそれを出す', () => {
    expect(responseErrorMessage(409, { error: 'この名前は既に登録されている' })).toBe(
      'この名前は既に登録されている',
    );
  });

  it('zod の検証失敗（error が文でない）は状態コードから決める', () => {
    expect(
      responseErrorMessage(400, { success: false, error: { issues: [], name: 'ZodError' } }),
    ).toMatch(/受け付けられません/);
  });

  it('413・401・403 は状態コードの文を優先する（内部の文を出さない）', () => {
    expect(responseErrorMessage(413, { error: 'body too large' })).toMatch(/大きすぎ/);
    expect(responseErrorMessage(401, null)).toMatch(/ログイン/);
    expect(responseErrorMessage(403, { error: 'origin not allowed' })).toMatch(/許可されていません/);
  });

  it('本文が読めなければ状態コードを添える', () => {
    expect(responseErrorMessage(500, null)).toBe('失敗しました（500）。');
    expect(responseErrorMessage(422, 'text')).toBe('失敗しました（422）。');
  });
});
