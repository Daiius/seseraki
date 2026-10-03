import { describe, expect, it } from 'vitest';
import {
  authSettings,
  initialDisplayName,
  isLocalOrigin,
  ownerGate,
} from './auth-config.js';

const PROD_ENV = {
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  BETTER_AUTH_URL: 'https://seseraki.example.test',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

describe('authSettings: 開発用の機能は development のときだけ（prd/07 §6）', () => {
  it('development は必須の値が無くても固定値で起動でき、登録も常に許す', () => {
    const s = authSettings({ NODE_ENV: 'development' });
    expect(s.isDev).toBe(true);
    expect(s.secret.length).toBeGreaterThanOrEqual(32);
    expect(s.baseURL).toBe('http://localhost:5173');
    expect(s.google).toBeNull();
    expect(s.allowSignup).toBe(true);
  });

  // 🔒 fail-closed: development 以外（production・未設定・test・その他）はすべて閉じる
  for (const nodeEnv of [
    'production',
    undefined,
    'test',
    'staging',
    'Development',
  ]) {
    describe(`NODE_ENV=${nodeEnv ?? '未設定'}`, () => {
      it('開発用の機能を開かない', () => {
        const s = authSettings({ ...PROD_ENV, NODE_ENV: nodeEnv });
        expect(s.isDev).toBe(false);
        expect(s.allowSignup).toBe(false);
      });

      for (const name of Object.keys(PROD_ENV)) {
        it(`${name} が無ければ起動を失敗させる（固定値へ逃がさない）`, () => {
          const env: Record<string, string | undefined> = {
            ...PROD_ENV,
            NODE_ENV: nodeEnv,
          };
          delete env[name];
          expect(() => authSettings(env)).toThrow(name);
        });
      }
    });
  }

  // 🔒 remote dev は development でも公開オリジンなので閉じる（prd/07 §6.1）
  describe('NODE_ENV=development・公開オリジン（remote dev）', () => {
    const remote = { ...PROD_ENV, NODE_ENV: 'development' };

    it('開発用の機能を開かない', () => {
      const s = authSettings(remote);
      expect(s.isDev).toBe(false);
      expect(s.allowSignup).toBe(false);
    });

    for (const name of ['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID']) {
      it(`${name} が無ければ起動を失敗させる（固定値へ逃がさない）`, () => {
        const env: Record<string, string | undefined> = { ...remote };
        delete env[name];
        expect(() => authSettings(env)).toThrow(name);
      });
    }
  });

  it('公開ホスト（DEV_ALLOWED_HOST）があれば、BETTER_AUTH_URL が localhost のままでも閉じる', () => {
    expect(
      authSettings({ NODE_ENV: 'development', DEV_ALLOWED_HOST: 'localhost' })
        .isDev,
    ).toBe(true);
    const env = {
      ...PROD_ENV,
      BETTER_AUTH_URL: 'http://localhost:5173',
      NODE_ENV: 'development',
      DEV_ALLOWED_HOST: 'dev.example.test',
    };
    const s = authSettings(env);
    expect(s.isDev).toBe(false);
    expect(s.allowSignup).toBe(false);
    const { BETTER_AUTH_SECRET: _, ...noSecret } = env;
    expect(() => authSettings(noSecret)).toThrow('BETTER_AUTH_SECRET');
  });

  it('isLocalOrigin: http の localhost だけを手元とみなす', () => {
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:8101')).toBe(true);
    expect(isLocalOrigin('http://[::1]:5173')).toBe(true);
    expect(isLocalOrigin('https://localhost:5173')).toBe(false);
    expect(isLocalOrigin('http://localhost.example.test')).toBe(false);
    expect(isLocalOrigin('https://dev.example.test')).toBe(false);
  });

  it('AUTH_ALLOW_SIGNUP=true の間だけ登録を許す（移行の窓。prd/07 §5.2）', () => {
    expect(
      authSettings({
        ...PROD_ENV,
        NODE_ENV: 'production',
        AUTH_ALLOW_SIGNUP: 'true',
      }).allowSignup,
    ).toBe(true);
    expect(
      authSettings({
        ...PROD_ENV,
        NODE_ENV: 'production',
        AUTH_ALLOW_SIGNUP: '1',
      }).allowSignup,
    ).toBe(false);
  });

  it('trustedOrigins は BETTER_AUTH_URL のオリジンと CORS_ORIGINS', () => {
    const s = authSettings({
      ...PROD_ENV,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://a.example.test, https://b.example.test',
    });
    expect(s.trustedOrigins).toEqual([
      'https://seseraki.example.test',
      'https://a.example.test',
      'https://b.example.test',
    ]);
  });
});

describe('initialDisplayName（prd/07 §3.1）', () => {
  it('作成時の name をそのまま使う（前後の空白は落とす）', () => {
    expect(initialDisplayName('  山田 太郎 ')).toBe('山田 太郎');
  });

  it('空なら (未設定)', () => {
    expect(initialDisplayName('')).toBe('(未設定)');
    expect(initialDisplayName('   ')).toBe('(未設定)');
    expect(initialDisplayName(null)).toBe('(未設定)');
    expect(initialDisplayName(undefined)).toBe('(未設定)');
  });

  it('先頭 100 コードポイントに切り詰める', () => {
    expect(initialDisplayName('あ'.repeat(150))).toBe('あ'.repeat(100));
  });

  it('🔴 サロゲートペアを割らない（UTF-16 単位で切らない）', () => {
    const name = 'a' + '𠮷'.repeat(120);
    const result = initialDisplayName(name);
    expect(Array.from(result)).toHaveLength(100);
    expect(result).toBe('a' + '𠮷'.repeat(99));
    // .slice(0, 100) だと 199 文字目の上位サロゲートだけが残る
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('ownerGate（所有者ゲート。prd/07 §5.1）', () => {
  it('未ログインは 401', () => {
    expect(ownerGate(null)).toBe(401);
    expect(ownerGate(undefined)).toBe(401);
    expect(ownerGate('')).toBe(401);
  });

  it('所有者 "1" だけ通す', () => {
    expect(ownerGate('1')).toBe(200);
  });

  it('所有者以外のセッションは 403', () => {
    expect(ownerGate('0b7c7f55-1f7b-4f0e-9d6a-3c2b1a000000')).toBe(403);
    expect(ownerGate('10')).toBe(403);
  });
});
