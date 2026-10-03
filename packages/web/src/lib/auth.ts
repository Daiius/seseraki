/**
 * ログイン（Google。server 側は Better Auth。prd/07 §5.3）。
 *
 * - ログイン状態は `GET /api/me` で見る（401 = 未ログイン / 403 = 所有者以外 / 200 = 所有者）
 * - サインイン・サインアウトは Better Auth のエンドポイント（`/api/auth/*`）を直接叩く。
 *   cookie は `HttpOnly`・`Path=/api` で、web からは読まない
 */
import { baseUrl, client } from './honoClient';

export type MeStatus =
  | { kind: 'owner'; userId: string }
  /** 未ログイン → ログイン画面へ */
  | { kind: 'unauthenticated' }
  /** ログインしているが、このアカウントでは利用できない（所有者ゲート。prd/07 §5.1） */
  | { kind: 'forbidden' };

/** `GET /api/me` の HTTP ステータスを状態にする。**401 / 403 以外の失敗は投げる**（未ログイン扱いにしない） */
export function meStatusOf(
  status: number,
  body?: { userId: string },
): MeStatus {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 403) return { kind: 'forbidden' };
  if (status >= 200 && status < 300 && body)
    return { kind: 'owner', userId: body.userId };
  throw new Error(`GET /api/me が ${status} を返した`);
}

let mePromise: Promise<MeStatus> | null = null;

/** ログイン状態（ページ遷移のたびに叩かないよう、確定するまで 1 本にまとめて覚えておく） */
export function fetchMe(): Promise<MeStatus> {
  if (!mePromise) {
    mePromise = (async () => {
      const res = await client.api.me.$get();
      return meStatusOf(res.status, res.ok ? await res.json() : undefined);
    })().catch((e: unknown) => {
      // サーバーに届かないなどの失敗は覚えない（次の遷移でやり直す）
      mePromise = null;
      throw e;
    });
  }
  return mePromise;
}

function forgetMe(): void {
  mePromise = null;
}

async function postJson(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Google でログインする（リダイレクト型。prd/07 §1）。返った URL（Google）へ遷移し、
 * Google → `/api/auth/callback/google` → `callbackURL` へ戻ってくる。
 * 失敗したときは `/login?error=<code>` へ戻る。
 *
 * @param callbackURL ログイン後に戻る先（同一オリジンの相対パス）
 */
export async function signInWithGoogle(callbackURL: string): Promise<void> {
  const res = await postJson('/api/auth/sign-in/social', {
    provider: 'google',
    callbackURL,
    errorCallbackURL: '/login',
  });
  if (!res.ok)
    throw new Error(`Google ログインを始められない（${res.status}）`);
  const { url } = (await res.json()) as { url?: string };
  if (!url) throw new Error('Google ログインの URL が返らない');
  forgetMe();
  window.location.assign(url);
}

/**
 * dev ログイン（development の server にだけある。prd/07 §6.1）。
 * @param as 省略すると所有者。名前を渡すと所有者ではない別の dev ユーザー
 */
export async function devLogin(as?: string): Promise<void> {
  const path = as
    ? `/api/dev/login?as=${encodeURIComponent(as)}`
    : '/api/dev/login';
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
  });
  forgetMe();
  if (!res.ok) throw new Error(`dev ログインに失敗した（${res.status}）`);
}

/** ログアウト。**セッションの行が消える**＝その場で失効する（prd/07 §5.3） */
export async function logout(): Promise<void> {
  try {
    await postJson('/api/auth/sign-out');
  } finally {
    forgetMe();
  }
}

/** Better Auth が `/login?error=<code>` に付けてくる値を、画面に出す文にする */
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'signup_disabled':
      return 'このアカウントでは利用できません（新規登録は受け付けていません）';
    case 'account_not_linked':
      return 'このメールアドレスは別の方法で登録されています';
    case 'access_denied':
      return 'Google でのログインがキャンセルされました';
    default:
      return `ログインできませんでした（${code}）`;
  }
}
