/**
 * Better Auth の設定を**本物の Better Auth に通して**確かめる（DB はメモリのアダプタ）。
 * 設定値を読むだけのテストでは、Better Auth 側の解釈（cookie の属性・フックの効き方）までは分からない。
 */
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';
import { authOptions, type AuthSettings } from './auth-config.js';

type Memory = Record<string, Record<string, unknown>[]>;

function makeAuth(overrides: Partial<AuthSettings> = {}) {
  const memory: Memory = {
    users: [],
    session: [],
    account: [],
    verification: [],
  };
  const settings: AuthSettings = {
    isDev: true,
    secret: 'test-secret-'.padEnd(40, 'x'),
    baseURL: 'http://localhost:5173',
    google: null,
    allowSignup: true,
    trustedOrigins: ['http://localhost:5173'],
    ...overrides,
  };
  const auth = betterAuth(authOptions(settings, memoryAdapter(memory)));
  return { auth, memory };
}

const ORIGIN = 'http://localhost:5173';

function post(
  auth: ReturnType<typeof makeAuth>['auth'],
  path: string,
  body: unknown,
  cookie?: string,
) {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** Set-Cookie から `name=value` だけを取り出して Cookie ヘッダにする */
function cookieHeader(res: Response): string {
  return setCookies(res)
    .map((c) => c.split(';')[0])
    .join('; ');
}

const credentials = {
  email: 'someone@example.invalid',
  password: 'password-1234',
  name: 'Someone',
};

describe('user の作成（prd/07 §3.1・§5.2）', () => {
  it('displayName を作成時の name から補う', async () => {
    const { auth, memory } = makeAuth();
    const res = await post(auth, '/sign-up/email', credentials);
    expect(res.status).toBe(200);
    expect(memory.users).toHaveLength(1);
    expect(memory.users[0]).toMatchObject({
      name: 'Someone',
      displayName: 'Someone',
    });
  });

  it('ID は UUID（varchar(36) に収まる）', async () => {
    const { auth, memory } = makeAuth();
    await post(auth, '/sign-up/email', credentials);
    expect(memory.users[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(memory.session[0]!.id).toHaveLength(36);
  });

  it('長い name は displayName に 100 文字で切り詰めて写す（name は元のまま）', async () => {
    const { auth, memory } = makeAuth();
    const long = '𠮷'.repeat(150);
    await post(auth, '/sign-up/email', { ...credentials, name: long });
    expect(memory.users[0]!.name).toBe(long);
    expect(Array.from(memory.users[0]!.displayName as string)).toHaveLength(
      100,
    );
  });

  it('displayName は登録の入力から書かせない（input: false）', async () => {
    const { auth, memory } = makeAuth();
    const res = await post(auth, '/sign-up/email', {
      ...credentials,
      displayName: '勝手な名前',
    });
    expect(res.status).toBe(400);
    expect(memory.users).toHaveLength(0);
  });

  it('🔒 登録を閉じている間は user を作らない', async () => {
    const { auth, memory } = makeAuth({ allowSignup: false });
    const res = await post(auth, '/sign-up/email', credentials);
    expect(res.status).toBe(403);
    expect(memory.users).toHaveLength(0);
  });
});

describe('email+password は development だけ（prd/07 §6）', () => {
  it('development 以外は sign-up / sign-in とも使えない', async () => {
    const { auth, memory } = makeAuth({ isDev: false });
    const up = await post(auth, '/sign-up/email', credentials);
    expect(up.ok).toBe(false);
    expect(memory.users).toHaveLength(0);
    const inRes = await post(auth, '/sign-in/email', {
      email: credentials.email,
      password: credentials.password,
    });
    expect(inRes.ok).toBe(false);
    expect(
      setCookies(inRes).filter(
        (c) => c.includes('session_token=') && !c.includes('Max-Age=0'),
      ),
    ).toEqual([]);
  });
});

describe('cookie（prd/07 §2.3・§9）', () => {
  it('セッション cookie は seseraki 接頭辞・Path=/api・HttpOnly', async () => {
    const { auth } = makeAuth();
    const res = await post(auth, '/sign-up/email', credentials);
    const session = setCookies(res).find((c) =>
      c.startsWith('seseraki.session_token='),
    );
    expect(session).toBeDefined();
    expect(session).toContain('Path=/api');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    // 30 日（prd/07 §2.2）
    expect(session).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it('サインアウトで同じ Path の cookie を消し、セッションの行も消える（その場で失効）', async () => {
    const { auth, memory } = makeAuth();
    const signed = await post(auth, '/sign-up/email', credentials);
    expect(memory.session).toHaveLength(1);
    const res = await post(auth, '/sign-out', {}, cookieHeader(signed));
    expect(res.status).toBe(200);
    const expired = setCookies(res).find((c) =>
      c.startsWith('seseraki.session_token='),
    );
    expect(expired).toContain('Max-Age=0');
    expect(expired).toContain('Path=/api');
    expect(memory.session).toHaveLength(0);
  });

  it('cookie cache を使わない（失効したセッションを通さない）', async () => {
    const { auth, memory } = makeAuth();
    const signed = await post(auth, '/sign-up/email', credentials);
    expect(
      setCookies(signed).some((c) => c.startsWith('seseraki.session_data=')),
    ).toBe(false);
    // 行を消すと、cookie が残っていても通らない
    const headers = new Headers({ cookie: cookieHeader(signed) });
    expect(await auth.api.getSession({ headers })).not.toBeNull();
    memory.session.length = 0;
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it('Google のサインインは state の cookie も Path=/api で出し、リダイレクト先に PKCE を付ける', async () => {
    const { auth } = makeAuth({
      google: { clientId: 'cid', clientSecret: 'secret' },
    });
    const res = await post(auth, '/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const google = new URL(url);
    expect(google.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/api/auth/callback/google`,
    );
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    const cookies = setCookies(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) expect(c).toContain('Path=/api');
  });

  it('信頼しないオリジンの callbackURL は拒む', async () => {
    const { auth } = makeAuth({
      google: { clientId: 'cid', clientSecret: 'secret' },
    });
    const res = await post(auth, '/sign-in/social', {
      provider: 'google',
      callbackURL: 'https://evil.example.test/',
    });
    expect(res.status).toBe(403);
  });
});
