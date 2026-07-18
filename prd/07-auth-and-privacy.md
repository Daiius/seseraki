# 07. 認証とプライバシー

本アプリは**個人用・シングルユーザー**である。認証は「自分以外に触られないため」の最小限であり、
マルチユーザー・owner 分離は持たない（[03](./03-data-model.md)）。

---

## 1. Web の認証（cookie セッション）

- ログインフォーム（`/login`）→ `POST /api/auth/login` → **署名付き cookie**（`seseraki_session`）を発行。
- 認証情報は `AUTH_USERNAME` + `AUTH_PASSWORD`（平文。他の API_KEY / DB 資格情報と同様、`.env.server` を
  秘密として運用）。照合は `crypto.timingSafeEqual` で**定数時間比較**。
- cookie は **HMAC 署名 + 発行時刻埋め込みで stateless**。**30 日固定有効期限**（スライディングなし）。
  署名鍵は `SESSION_SECRET`。
- cookie 属性: `HttpOnly; SameSite=Lax`、本番は `Secure`、**`Path=/` 固定**（`COOKIE_SECURE` / `COOKIE_PATH`
  env で切替）。現在の配信契約（web は origin 直下、API は origin 直下の `/api`）では `/` 以外にすると web か
  `/api` の一方に cookie が届かずログイン直後から 401 になる。サブパス配信を正式支援するには、web と API を
  同一プレフィックス下（例 `/seseraki` と `/seseraki/api`）へ置く URL・proxy 契約と client base URL の対応が
  別途必要（現状は未対応）。

### 認証 API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/auth/me` | ログイン状態確認。未ログインは 401 |
| POST | `/api/auth/login` | body: `{ username, password }`。成功で署名付き cookie 発行 |
| POST | `/api/auth/logout` | cookie を破棄 |

- `/login` 以外は web の `__root.tsx` の `beforeLoad` で `/api/auth/me` を叩いてガードし、未ログインなら
  `/login?redirect=<元の URL>` へリダイレクト（[05](./05-analysis.md)）。

## 2. ルート保護

| 系統 | 対象 | 認証 |
|---|---|---|
| セッション | 棋譜 CRUD・一括取り込み系エンドポイント | `sessionRequired`（web のログイン cookie） |
| API_KEY | `/api/worker/*` | `Authorization: Bearer <API_KEY>`（別系統） |

- **worker 認証はユーザー認証と別系統**。worker は inbound の口を持たず、API_KEY で server を polling する
  （[02](./02-architecture.md) / [05](./05-analysis.md)）。
- 全リクエストに `hono/logger` でアクセスログを出力。**web と API は同一オリジン配信なので通常 CORS は不要**
  （`CORS_ORIGINS` 未設定なら CORS ミドルウェア自体が無効）。別オリジンの web から叩く特殊構成のときだけ
  `CORS_ORIGINS`（カンマ区切り）を設定する（`credentials: true`）。

## 3. プライバシーと公開配置の前提

- **シングルユーザー・private データのみ**。自分の棋譜を自分だけが見る。マルチユーザー対応は不要。
- 公開配置の前提: HTTPS / シークレット管理（`.env*` はコミットしない）/ 同一オリジン配信（`/api` を
  書き換えず server へ転送）。同一オリジンのため CORS は原則不要。
- **本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ・シークレット）は公開リポに含めない。**
  PRD は姿勢のみ記述し、具体はローカルの `.claude-personal/` に置く（[02](./02-architecture.md) §5 / [README](./README.md)）。
