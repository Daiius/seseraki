# 02. アーキテクチャ

本章はアプリ全体の技術構成・パッケージ分割・型共有・開発環境・デプロイ姿勢を定める。
データモデルは [03](./03-data-model.md)、認証は [07](./07-auth-and-privacy.md) に委ねる。

---

## 1. 全体像

- **フルスタック TypeScript** の **pnpm monorepo**。パッケージは `packages/{web,server,worker}`。
- **個人用・シングルユーザー**前提（[07](./07-auth-and-privacy.md)）。マルチユーザー化は想定しない。
- **web + server + DB は常時稼働の小さなホスト**に、**worker は解析用の別ホスト**に置く（§5）。
  worker は inbound の口を持たず、server を **API_KEY で polling** する（[05](./05-analysis.md)）。

```
   web (React/Vite) ──fetch /api──> server (Hono/Drizzle) ──> MySQL 8.4
                                        ▲    │
                                        │    │ 履歴からの一括取り込み（手動トリガー・非同期ジョブ）
                                        │    ▼
                          API_KEY polling（未解析棋譜取得 / 解析結果登録）
                                        │
                                     worker (Node.js/USI) ── やねうら王 + 評価関数
```

## 2. 技術スタック

| パッケージ | 役割 | 主要技術 |
|---|---|---|
| `web` | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI, clsx |
| `server` | API + DB + KIF パース + 一括取り込み + プロンプト生成 | Hono, Drizzle ORM (1.0.0-beta.22), MySQL, zod |
| `worker` | 棋譜解析 | USI プロトコル, やねうら王 |
| `shared` | 将棋ドメインの純ロジック + zod 検証スキーマ（§3） | TypeScript（React/node 非依存の純 TS）, zod |
| `commentator`（将来） | LLM 解説の自動生成（薄い監視スクリプト・独立 container） | [06](./06-llm-commentary.md) |

- **DB は MySQL 8.4**（開発経験が多いため選択。named volume で永続。`docker compose down -v` で初期化）。
- **Drizzle ORM 1.0.0-beta.22**: 1.0 正式リリースが近く、早めにキャッチアップする目的で beta を採用。
- スタイルは Tailwind v4 + daisyUI。棋譜詳細はモバイルファーストで組む（[05](./05-analysis.md)）。

## 3. 型共有（Hono RPC）と `shared` パッケージ

責務を 2 系統に分ける。**API 型は Hono RPC、ドメインの実体（ロジック + 検証）は `shared`**。

### 3.1 API 型共有 — Hono RPC

- **Hono RPC**（`AppType` を server が export し、web/worker が `hc<AppType>` で参照）で
  server → web/worker 間の API 型を共有する。**API 型は `shared` に重複させない**。
- 利点: Drizzle ORM の型情報が Hono RPC 経由でフロントエンドまで一気通貫で伝わる。
- server の `package.json` の `exports` で `route.ts` の型を公開し、web/worker は `"server": "workspace:*"` を
  devDependencies として参照する。
- **既知の落とし穴（TS2742）**: エンドポイントが server 内部ファイルの型を返すと `hc<AppType>(...)` の
  推論結果が遠い相対パスを参照して TS2742 が出ることがある。
  `type Client = ReturnType<typeof hc<AppType>>` で一旦型を抜き出し、
  `export const client: Client = hc<AppType>(...)` と付け直すと回避できる。

### 3.2 ドメインロジック + 検証 — `shared`

- **`shared` は将棋ドメインの純ロジックと zod 検証スキーマを持つ**（React/node 非依存の純 TS）。責務を凝集させ、
  何でも置く junk drawer にはしない。中身:
  1. **盤面追跡・USI 変換・USI→日本語表記・悪手判定**（[05](./05-analysis.md)）。
  2. **kifu-export プロンプト生成**（[06](./06-llm-commentary.md)。純関数）。
  3. **zod 検証スキーマ**（runtime バリデーション。[03](./03-data-model.md)）。
- **なぜ持つか**（旧「shared を作らない」の改定）: 元の判断は「Hono RPC の型共有を使わず zod 定義を
  shared に溜め込む」傾向への予防だった。しかし (1) 対話盤面ロジックを **web（対話表示）と server（プロンプト
  生成エンドポイント）で共有**する必要が生じ、(2) **型共有だけでは動作時に不正データを弾けず、runtime 検証には
  zod の実体が要る**（型は compile 時まで。実行時に無茶なデータを受け入れてしまう）。
- **消費者**: web（対話盤面）/ server（プロンプト生成・投入検証）/ 将来の commentator は server 経由で薄く保つ。
- KIF/CSA パーサーは消費者が server のみのため `shared` に移さない（第 2 の消費者が出たら再検討。[04](./04-ingestion.md)）。

## 4. データフローの原則

- **KIF→USI 変換は server が棋譜登録時に一度だけ行う**（[04](./04-ingestion.md)）。変換済み `usiMoves` を DB に保持し、
  worker と Web 盤面はこれを消費する。worker は KIF パーサーを持たない（[05](./05-analysis.md)）。
- **解析結果の登録はトランザクション**で行い、既存データは DELETE → 再投入で冪等に上書きする（[03](./03-data-model.md) / [04](./04-ingestion.md)）。
- web は Vite dev server が `/api` プレフィックスを除去しつつ server にプロキシする（開発時）。

## 5. デプロイ姿勢

- **web + server + db** は常時稼働の小さなホストに、**worker** は解析用の高メモリホストに分離配置する。
  - worker を web/server と同居させる案も検討したが、**評価関数のメモリ消費が大きく分離が現実的**。
  - VPS 上での worker 動作はメモリ的に厳しいため、解析は高スペックなデスクトップ PC に寄せる。
- **本番イメージ**:
  - server: esbuild でバンドル → distroless で実行（コンテナレジストリへ発行。レジストリ/namespace の具体は `.claude-personal/`）。
  - worker: `packages/worker/Dockerfile.prod` で本番ホスト上でビルド。やねうら王 NNUE + 評価関数 +
    定跡を同梱し、esbuild バンドルで実行（[05](./05-analysis.md) §エンジン構成）。
- 認証は server 側のログインフォーム（[07](./07-auth-and-privacy.md)）。worker は API_KEY で別系統。
- **本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ・シークレット）は公開リポに含めない。**
  ローカル限定の運用メモは gitignore 対象の `.claude-personal/` に置き、「存在すれば参照」する
  （[README](./README.md) §公開リポジトリでの秘匿方針）。

## 6. 開発環境（docker compose watch）

`pnpm dev`（`docker compose up --build --watch`）で全サービスを起動する。

| サービス | ポート | 備考 |
|---|---|---|
| db | 3306 | MySQL 8.4, named volume で永続 |
| server | 4000 | `.env.database` + `.env.server` |
| web | 5173 | Vite dev server, `.env.web` |
| worker | - | MATERIAL エンジン（開発用・軽量）, cpus: 1, `.env.worker` |

- ファイル変更は docker watch の `sync+restart` で自動同期・再起動。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。
- **主要コマンド**:

| コマンド | 内容 |
|---|---|
| `pnpm dev` | docker compose up --build --watch で db + server + web + worker を起動 |
| `pnpm typecheck` | 全パッケージ `tsc --noEmit` |
| `pnpm build` | 全パッケージのビルド |
| `pnpm db:push` | dev: スキーマを DB に強制同期（使い捨て DB 向け・`drizzle-kit push --force`） |
| `pnpm db:generate` | schema 差分から `packages/server/drizzle/` にマイグレーション SQL を生成 |
| `pnpm db:migrate` | バージョン管理マイグレーションを適用（未適用分のみ・接続先は呼び出し環境の env） |
| `pnpm db:baseline` | 既存 DB を drizzle 管理下に載せる初回登録（0000 を適用済み記録・スキーマ実在を検証） |
| `pnpm db:migrate:dev` / `db:baseline:dev` | 上記を dev DB（`.env.database` + `DB_HOST=localhost`）に対して実行 |
| `pnpm db:seed` | サンプルデータ投入（初回のみ。既存データがあればスキップ） |
| `pnpm --filter server test` / `--filter worker test` | ユニットテスト（vitest） |

- **マイグレーション方式**: **dev は `db:push`**（強制同期・履歴なし・使い捨て DB 向け）、**本番は generate/migrate 方式**
  （`packages/server/drizzle/` にバージョン管理、`db:generate` で生成 → `db:migrate` で未適用分だけ適用）。既存の本番 DB を
  初めて管理下に載せる時は一度だけ `db:baseline` で 0000 を適用済み登録する（`baseline` は対象 DB に 0000 のテーブル・カラムが
  実在するかを information_schema で検証し、空 DB / 接続先取り違え / drift なら記録せず中止する）。
- **接続先の env は上書きしない**: `db:migrate` / `db:baseline` / `db:generate` は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*` を
  そのまま使う（本番は cloudflared tunnel で localhost に向け prod 資格情報を export して実行。具体は `.claude-personal/`）。
  dev DB に対して versioned migration を試すときは `.env.database` を読む `db:migrate:dev` / `db:baseline:dev` を使う。
- 初回セットアップ（dev）: `pnpm dev` 起動後に `pnpm db:push && pnpm db:seed`。dev のスキーマ変更は `pnpm db:push`。
- **環境変数は `.env.*` ファイルで管理**（gitignore 対象。雛形は `.env.*.example`）。
  - `.env.database`（MySQL 接続）/ `.env.server`（認証・API_KEY・`SWARS_*` 等）/ `.env.worker`（エンジン・server 接続）/ `.env.web`（API URL・`VITE_SWARS_USER_ID`）。
  - ⚠️ Docker の `--env-file` は**インラインコメント非対応**。値の後ろに `# コメント` を書くと値の一部になるため避ける（行頭 `#` のみ可）。
- **Docker 外で worker を動かす**場合は `packages/worker/.env.example` を `.env` にコピー。`USE_MOCK=true` で
  エンジンなしのモック動作が可能（[05](./05-analysis.md)）。
