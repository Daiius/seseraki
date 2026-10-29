/**
 * API のルート（Hono RPC。`AppType` が web / worker の型の出所）。
 *
 * ここはミドルウェア・認証（Better Auth・dev ログイン）の登録と、`routes/*.ts` の連結だけを持つ。
 * 口の本体は `routes/` に分けてあり、`.route('/', …)` で 1 本の鎖につなぐ（RPC の型はこの鎖から出る）。
 *
 * 🔒 **ログインの経路（`sessionRequired`）は、ユーザーとして開いたトランザクション（`c.get('tx')`）だけを使う**
 * （prd/14 §4「RLS の形」）。グローバルの `db` を import しない（`db-import-boundary.test.ts` が `route.ts` と
 * `routes/` を検査する）。棋譜系の表に触れる処理は、所有者（`c.get('userId')`。🔒 セッションから取る）と tx を
 * 引数に取るクエリ関数（`kifu-queries.ts` / `position-queries.ts` / `drill-query.ts` / `users.ts` など）に置く。
 * 他人の棋譜・問題・名前候補・評価ジョブは 404（存在を明かさない）。
 *
 * 🔒 **棋譜はパスでも応答でも番号（`kifus.displayNo`。所有者ごとの連番）で扱う**（prd/14 §4.4）。
 * 内部の主キーは通しの連番でサービス全体の棋譜数が分かるので、ログインの経路の応答に載せない
 * （`display-no.db.test.ts` が全エンドポイントの応答を検査する）。出題は棋譜の番号・手数・種類の組で指す。
 * worker の経路（API_KEY。`worker-routes.ts`）は内部経路なので内部 ID のまま。
 *
 * 🔒 **GET 以外の口には Origin の検査を一括で掛ける**（`originRequiredForWrites`。prd/14 §5.8）。
 * ブラウザ解析の受け口・担当の切り替え・出題の解答（prd/14 §5.7・§5.8・prd/13 §5.3）・メモには本文の大きさの上限を付ける
 * （`routes/common.ts` の `smallBody`。取り込みは `kifuCreateBody`）。ブラウザから届く解析結果は信用できない入力なので、
 * 検証と上限は `shared` の `analysis-limits.ts` の zod で掛ける。書き込みは他の口と同じく RLS の下の tx で行う。
 *
 * 全員ぶんを扱う経路（worker の報告・動画解析の取り込み。API_KEY）は `worker-routes.ts`。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth, settings as authSettings } from './auth.js';
import { devLoginRoutes } from './dev-login.js';
import { originRequiredForWrites } from './middlewares.js';
import { buildVersionFromEnv } from './build-version.js';
import { browserAnalysisRoutes } from './routes/browser-analysis.js';
import { drillRoutes } from './routes/drills.js';
import { kifuRoutes } from './routes/kifus.js';
import { positionRoutes } from './routes/positions.js';
import { userRoutes } from './routes/users.js';
import { workerRoutes } from './worker-routes.js';

export type { SourceTzChoice } from './kifu-queries.js';

export const app = new Hono().basePath('/api');

/**
 * Origin の検査（`originRequiredForWrites`）から外すパスの接頭辞。
 * - `/api/auth/`: Better Auth。自分で `Origin` を `trustedOrigins` と照合する
 * - `/api/dev/`: dev ログイン（development だけに登録される。prd/07 §6.1）
 * - `/api/worker/`・`/api/video-analysis/`: API_KEY の経路（`worker-routes.ts`）。cookie を使わない
 */
export const ORIGIN_EXEMPT_PREFIXES = [
  '/api/auth/',
  '/api/dev/',
  '/api/worker/',
  '/api/video-analysis/',
] as const;

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', logger());
if (corsOrigins.length > 0) {
  app.use('*', cors({ origin: corsOrigins, credentials: true }));
}

/**
 * 🔒 **GET 以外のすべての口に Origin の検査を掛ける**（prd/14 §5.8・2026-10-30）。一覧は Better Auth の
 * `trustedOrigins` と同じもの（`BETTER_AUTH_URL` のオリジンと `CORS_ORIGINS`。二重管理にしない）。
 * セッションは cookie なので、別のサイトのページからも cookie 付きの書き込みは飛ばせる（CSRF）。
 *
 * 外すのは cookie を使わない口・自前で検査する口だけ（`ORIGIN_EXEMPT_PREFIXES`）:
 * API_KEY の経路（worker・動画解析の取り込み）・Better Auth（自分で `Origin` を検査する）・dev ログイン。
 * ⚠ ルートより前に登録する（後に登録すると、先に応答したハンドラの後に回って掛からない）
 */
app.use('*', originRequiredForWrites(authSettings.trustedOrigins, ORIGIN_EXEMPT_PREFIXES));

// 人のログイン（Better Auth。prd/07 §2.1）。サインイン・コールバック・サインアウト・セッション取得を
// 丸ごと受ける。⚠ **アプリの API を /auth/* の下に置かない**（このハンドラが先に受ける）
app.on(['POST', 'GET'], '/auth/*', (c) => auth.handler(c.req.raw));

// 🔒 dev ログインの抜け道は **NODE_ENV=development のときだけ登録する**（prd/07 §6）。
// それ以外ではルート自体が無く 404（auth-routes.test.ts で固定）。RPC の型にも載せない
if (authSettings.isDev) {
  app.route('/dev', devLoginRoutes(auth));
}

/** この server のビルドの版（prd/02 §5）。イメージの ENV は起動後に変わらないので、読み込み時に 1 回だけ読む */
const buildVersion = buildVersionFromEnv(process.env);

const route = app
  // --- 版（prd/02 §5「版の確かめ方」）---
  // 本番の server がどのコミットから作られたかを外から確かめる口。認証は要らない（SHA とビルド日時だけ・DB に触れない）
  .get('/version', (c) => c.json(buildVersion))
  // --- Web 向け（セッション認証 + ユーザーとして開いたトランザクション） ---
  .route('/', userRoutes)
  .route('/', kifuRoutes)
  .route('/', positionRoutes)
  .route('/', drillRoutes)
  .route('/', browserAnalysisRoutes)
  // --- 全員ぶんを扱う経路（API_KEY）: worker の報告・動画解析の取り込み ---
  .route('/', workerRoutes);

export type AppType = typeof route;
