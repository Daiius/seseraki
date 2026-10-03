import { describe, expect, it } from 'vitest';
import { loginErrorMessage, meStatusOf } from './auth';

describe('meStatusOf（GET /api/me。prd/07 §5.3）', () => {
  it('401 は未ログイン', () => {
    expect(meStatusOf(401)).toEqual({ kind: 'unauthenticated' });
  });

  it('403 は所有者以外（ログインしているが利用できない）', () => {
    expect(meStatusOf(403)).toEqual({ kind: 'forbidden' });
  });

  it('200 は所有者', () => {
    expect(meStatusOf(200, { userId: '1' })).toEqual({
      kind: 'owner',
      userId: '1',
    });
  });

  it('それ以外の失敗は未ログイン扱いにせず投げる', () => {
    expect(() => meStatusOf(500)).toThrow();
    expect(() => meStatusOf(502)).toThrow();
  });
});

describe('loginErrorMessage', () => {
  it('エラーが無ければ null', () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage('')).toBeNull();
  });

  it('新規登録を閉じているときは、利用できないことを伝える', () => {
    expect(loginErrorMessage('signup_disabled')).toContain('利用できません');
  });

  it('知らないコードもそのまま添えて出す', () => {
    expect(loginErrorMessage('state_mismatch')).toContain('state_mismatch');
  });
});
