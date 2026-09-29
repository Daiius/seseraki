/**
 * Better Auth の設定（prd/07 §2.2）。**DB にも process.env にも触らない純粋な部分**をここに置き、
 * インスタンスの組み立て（`auth.ts`）と分ける——unit テストが env を差し替えて検査できるように。
 *
 * 🔒 **開発用の機能（email+password・dev ログイン・秘密のフォールバック・登録の常時許可）は
 * `NODE_ENV === 'development'` のときだけ有効にする**（明示の許可リスト。prd/07 §6）。
 * production・未設定・test などそれ以外はすべて閉じ、必須の値が無ければ**起動を失敗させる**。
 * `NODE_ENV` を付け忘れた本番で抜け道が開く事故（fail-open）を構造的に起こさないため。
 */
import type { BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { OWNER_USER_ID } from './users.js';

export type Env = Record<string, string | undefined>;

export interface AuthSettings {
  /** 開発用の機能を開くか。`NODE_ENV === 'development'` のときだけ true */
  isDev: boolean;
  secret: string;
  /** ブラウザから見えるオリジン（`/api` は付けない。Better Auth が `/api/auth` を足す） */
  baseURL: string;
  google: { clientId: string; clientSecret: string } | null;
  /** 新規 user の作成を許すか（prd/07 §5.2）。development は常に許す */
  allowSignup: boolean;
  trustedOrigins: string[];
}

/** development だけ固定値へ逃がす。それ以外で値が無ければ throw（起動を失敗させる） */
function required(
  env: Env,
  isDev: boolean,
  name: string,
  devFallback?: string,
): string {
  const value = env[name];
  if (value) return value;
  if (isDev && devFallback !== undefined) return devFallback;
  throw new Error(
    `${name} が設定されていない（NODE_ENV=${env.NODE_ENV ?? '未設定'}）`,
  );
}

export function authSettings(env: Env): AuthSettings {
  const isDev = env.NODE_ENV === 'development';
  const secret = required(
    env,
    isDev,
    'BETTER_AUTH_SECRET',
    'seseraki-dev-insecure-secret-do-not-use-in-production',
  );
  // dev は Vite の origin（`/api` は Vite の proxy が server へ渡す。prd/07 §6.2）
  const baseURL = required(
    env,
    isDev,
    'BETTER_AUTH_URL',
    'http://localhost:5173',
  );
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  let google: AuthSettings['google'] = null;
  if (clientId && clientSecret) {
    google = { clientId, clientSecret };
  } else if (!isDev) {
    // development 以外は Google が唯一のログイン手段なので、無ければ起動させない
    required(
      env,
      isDev,
      clientId ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID',
    );
  }
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    isDev,
    secret,
    baseURL,
    google,
    allowSignup: isDev || env.AUTH_ALLOW_SIGNUP === 'true',
    trustedOrigins: [new URL(baseURL).origin, ...corsOrigins],
  };
}

/** 表示名の上限（`users.displayName` の `varchar(100)`） */
export const DISPLAY_NAME_MAX = 100;

/**
 * 作成時の表示名（prd/07 §3.1）。Google の表示名（dev ログインでは固定名）から作る。
 *
 * 🔴 **列の長さに収める。** `name` は 255 文字まで入るが `displayName` は 100 文字。
 * MySQL の `varchar(n)` は文字（コードポイント）で数えるので `Array.from` で数え、
 * サロゲートペアを割らない（`.slice` は UTF-16 単位で割る）。
 */
export function initialDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '(未設定)';
  return Array.from(trimmed).slice(0, DISPLAY_NAME_MAX).join('');
}

/**
 * 所有者ゲート（prd/07 §5.1）。**所有者スコープ（prd/14 §4）が入るまでの安全網**。
 * 今のクエリは所有者で絞っていないので、セッションがあるだけで通すと
 * ログインできた人は誰でも所有者の棋譜を読み書きできてしまう。
 *
 * @returns 未ログインは 401、所有者以外は 403、所有者なら 200
 */
export function ownerGate(userId: string | null | undefined): 200 | 401 | 403 {
  if (!userId) return 401;
  return userId === OWNER_USER_ID ? 200 : 403;
}

const DAY_SEC = 60 * 60 * 24;

/**
 * Better Auth のオプション（prd/07 §2.2）。`database` は呼び出し側が渡す
 * （本番は既存の `db` の drizzle アダプタ、テストはメモリのアダプタ）。
 */
export function authOptions(
  settings: AuthSettings,
  database: NonNullable<BetterAuthOptions['database']>,
) {
  return {
    appName: 'seseraki',
    baseURL: settings.baseURL,
    secret: settings.secret,
    database,
    trustedOrigins: settings.trustedOrigins,
    telemetry: { enabled: false },
    user: {
      // 🔒 既存の users 表を Better Auth の user 表にする（物理名は users のまま。prd/07 §3.1）
      modelName: 'users',
      additionalFields: {
        // 画面に出す名前。登録時の入力からは書かせない（input: false）。
        // ⚠ required: false は Better Auth の入力検査を外すためで、DB は NOT NULL。
        //   値は下の databaseHooks.user.create.before が必ず補う
        displayName: { type: 'string', required: false, input: false },
      },
    },
    session: {
      // 仮置き（prd/07 §9）。今の 30 日を踏襲し、使っている間は 1 日ごとに延びる
      expiresIn: 30 * DAY_SEC,
      updateAge: DAY_SEC,
      // 🔒 cookie cache を使うと、失効してもキャッシュの期限まで通ってしまう
      cookieCache: { enabled: false },
    },
    account: {
      // 🔒 同じメールでの自動連携は乗っ取りの経路になりやすい（prd/07 §1）
      accountLinking: { enabled: false },
    },
    // 🔒 development のときだけ（dev ログインの土台。prd/07 §6）
    emailAndPassword: { enabled: settings.isDev },
    ...(settings.google && {
      socialProviders: {
        google: {
          clientId: settings.google.clientId,
          clientSecret: settings.google.clientSecret,
        },
      },
    }),
    // OAuth の失敗（登録を閉じている等）はログイン画面へ戻す。`?error=<code>` が付く
    onAPIError: { errorURL: `${new URL(settings.baseURL).origin}/login` },
    advanced: {
      // 他のアプリの cookie と取り違えない
      cookiePrefix: 'seseraki',
      // 🔒 同一オリジンの /api 配下でしか使わない（prd/07 §2.3）。state / PKCE の cookie も
      // コールバック（/api/auth/callback/google）で読まれるので同じ path でよい
      defaultCookieAttributes: { path: '/api' },
      // ID を varchar(36) に揃える（大文字小文字の混ざらない形。prd/07 §3.2）
      database: { generateId: 'uuid' as const },
      // 🔒 Origin / callbackURL の検査を明示で有効にする。Better Auth は NODE_ENV=test のとき
      // 既定でこれを外す——env の取り違えで検査が消えないように固定する
      disableOriginCheck: false,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // 🔒 他人の Google ログインで user を作らせない（prd/07 §5.2）。
            // 移行の間だけ AUTH_ALLOW_SIGNUP=true で開ける。development は常に許す
            if (!settings.allowSignup) {
              throw new APIError('FORBIDDEN', { message: 'signup disabled' });
            }
            // 🔴 displayName は NOT NULL。input: false の列には OAuth のプロフィールも
            // 登録の入力も渡らないので、補わないと新規 user の INSERT が落ちる（prd/07 §3.1）
            return {
              data: { ...user, displayName: initialDisplayName(user.name) },
            };
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}
