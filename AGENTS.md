# AGENTS.md

> このファイルがリポジトリの**正典**です（使用する各コーディングエージェント共通）。簡潔・リンク中心に保つこと。
> 詳細仕様は [`prd/`](./prd/) を参照。

## プロジェクト目的

将棋の棋譜を取り込み・エンジン解析し、疑問手 / 分岐 / 評価値推移を閲覧できる**個人用**の棋譜解析サービス。
主眼は「棋譜を溜め込んで自動解析」「疑問手・分岐の可視化」「LLM 解説の下準備」の 3 つ。
→ 詳細は [`prd/README.md`](./prd/README.md)。

## ドキュメント（PRD）

| 文書 | 内容 |
|---|---|
| [prd/README.md](./prd/README.md) | 目的 / スコープ / アーキ概観 / 索引 / 公開リポ方針 |
| [prd/01-domain.md](./prd/01-domain.md) | 将棋棋譜ドメインとプロダクト動機（KIF/USI・対局メタ・解析の意味） |
| [prd/02-architecture.md](./prd/02-architecture.md) | 技術スタック / monorepo / 型・ロジック共有 / 開発環境 / デプロイ姿勢 |
| [prd/03-data-model.md](./prd/03-data-model.md) | DB スキーマ（kifus / moveAnalyses / candidateMoves / commentaries） |
| [prd/04-ingestion.md](./prd/04-ingestion.md) | 投入ルート / KIF・CSA→USI 変換 / メタ抽出 / 一括取り込み |
| [prd/05-analysis.md](./prd/05-analysis.md) | worker エンジン解析 / Web 可視化 |
| [prd/06-llm-commentary.md](./prd/06-llm-commentary.md) | LLM 解説用エクスポートと自動生成（commentator） |
| [prd/07-auth-and-privacy.md](./prd/07-auth-and-privacy.md) | 認証 / API_KEY / 公開配置 |
| [prd/08-roadmap.md](./prd/08-roadmap.md) | フェーズ分け / 未実装・計画中 / 確定事項 |

> 仕様策定の経緯（grill ログ）: [`prd/_grilling/decisions.md`](./prd/_grilling/decisions.md)

## 技術スタック / 構成

- フルスタック TypeScript の **pnpm monorepo**。
- **DB**: MySQL 8.4 / **API**: Hono(RPC) / **ORM**: Drizzle ORM 1.0（beta 追従）
- **Front**: React 19 + Vite + TanStack Router + TailwindCSS v4 + daisyUI
  - **メモ化は React Compiler に委ねる**。`useMemo` / `useCallback` / `React.memo` は原則書かない
    （`packages/web/vite.config.ts` で `reactCompilerPreset` を有効化済み）。
    手書きで足したくなったら、まず Rules of React 違反でコンパイラが諦めていないかを疑う。
- **worker**: USI + やねうら王。server とは分離した実行環境で **API_KEY polling**（inbound の口を持たない）。
- **共有方針**: **API 型は Hono RPC** に集約、**将棋ドメインの純ロジック + zod 検証スキーマは `shared`**（理想。現状は
  web に存在し `shared` 抽出は gap。[prd/02](./prd/02-architecture.md) §3）。

### パッケージ

**現在のパッケージ**:

| パッケージ | 役割 |
|---|---|
| [`packages/web`](./packages/web) | 棋譜管理 UI（React + Vite + TanStack Router + Tailwind） |
| [`packages/server`](./packages/server) | Hono(RPC) API・DB・KIF/CSA パース・一括取り込み |
| [`packages/worker`](./packages/worker) | 棋譜解析（USI / やねうら王）。分離実行環境で稼働 |

**理想構成の追加（未実装・gap。[prd/08](./prd/08-roadmap.md)）**:

| パッケージ | 役割 |
|---|---|
| `packages/shared` | 将棋ドメインの純ロジック（盤面追跡・USI 変換・悪手判定・kifu-export）+ zod 検証スキーマ（[prd/02](./prd/02-architecture.md) §3.2） |
| `packages/commentator` | LLM 解説の自動生成（薄い監視スクリプト・独立 container。[prd/06](./prd/06-llm-commentary.md)） |

> ※ `shared` へのドメインロジック抽出と server のプロンプト生成エンドポイントは gap（未実装）。現状は
> board/usi/kifu-export が `packages/web` にあり、プロンプトは web が自前生成している。

## 開発コマンド

```bash
pnpm dev          # docker compose up --build --watch で全サービス起動（db, server, web, worker）
pnpm typecheck    # 全パッケージ tsc --noEmit
pnpm build        # 全パッケージのビルド
pnpm db:push      # dev: スキーマを DB に強制同期（使い捨て DB 向け・drizzle-kit push --force）
pnpm db:generate  # schema 差分から drizzle/ にバージョン管理マイグレーションを生成
pnpm db:migrate   # マイグレーション適用（未適用分のみ・接続先は呼び出し環境の DB_HOST/DB_PORT/MYSQL_*）
pnpm db:baseline  # 既存 DB を drizzle 管理下に載せる初回登録（0000 を適用済み記録・スキーマ実在を検証）
pnpm db:backfill-tz  # 既存棋譜(sourceTz 未設定)の playedAt を TZ 判定で再導出（db:migrate 後に一度・既定 dry-run / BACKFILL_APPLY=1 で適用）
pnpm db:seed      # サンプルデータ投入（初回のみ）
pnpm --filter server test   # server のユニットテスト（vitest）
pnpm --filter worker test   # worker のユニットテスト（vitest）
pnpm --filter web test      # web のユニットテスト（vitest・純ロジックのみ）
```

> **マイグレーション方式**: dev は `db:push`（強制同期・使い捨て）、本番は **generate/migrate 方式**（`packages/server/drizzle/`
> にバージョン管理、`db:generate` で生成し `db:migrate` で未適用分だけ適用）。既存 DB を初めて管理下に載せる時は一度だけ
> `db:baseline` で 0000 を適用済み登録する（対象 DB に 0000 のテーブル・カラムが実在するかを検証し、空/取り違え/drift なら中止）。
> **`db:migrate`/`db:baseline`/`db:generate` は接続先を呼び出し環境の `DB_HOST`/`DB_PORT`/`MYSQL_*` から取る**（本番は prod 資格情報を
> export して実行）。dev DB に対して試すときは `.env.database` を読む **`db:migrate:dev` / `db:baseline:dev`** を使う。
> 本番接続の具体（cloudflared tunnel・prod 資格情報）は `.claude-personal/`。
> **順序**: スキーマ変更（`sourceTz` 追加等）は `db:migrate` で列を足してから `db:backfill-tz` を流す（列が無いと backfill は
> 失敗する）。backfill は `sourceTz` 未設定の既存行だけを対象に `kifText` から再導出する冪等処理。**既定は dry-run**（変更案の
> 表示のみ）、`BACKFILL_APPLY=1` で実書込。dev DB に試すときは `db:backfill-tz:dev`。
> ⚠️ **`:dev` は `DB_HOST=localhost` に繋ぐ。cloudflared tunnel を上げていると localhost が本番を指しうる**（127.0.0.1:3306 の
> 取り合い）。`:dev` 実行前に `lsof -nP -iTCP:3306 -sTCP:LISTEN` で localhost の実体を確認し、tunnel は落としておく。

> compose watch・環境変数（`.env.*`）・DB 初回セットアップ・Docker 外での worker 実行（`USE_MOCK=true`）の
> 詳細は [prd/02](./prd/02-architecture.md) §6。

## Git / PR 運用

- **レビュー中の PR は追加コミットを積む**。`git commit --amend` + `git push --force` はしない
  （レビュー bot はコミット単位で追随でき、対応履歴も追いやすい）。
- 最終的な履歴整形は **squash マージ**に任せる（PR タイトルが正典コミットになる）。

## 公開リポジトリ方針

本リポジトリは公開のため、コード・文書に以下を持ち込まない（詳細は [prd/README.md](./prd/README.md) §秘匿方針）:

- 秘密情報（`.env*`・API_KEY・DB 資格情報・cookie の値）。
- 本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ）。姿勢のみ記述する。
- **`swars`（コードネーム）は実装に合わせて文書でも用いる**（識別子・エンドポイント・環境変数名を消さない）。
  ただし swars の**正式名称・取得の詳細な仕組み・アクセス姿勢・資格情報**は書かず `.claude-personal/` に置く。

## ローカル専用メモ（存在すれば読む）

`.claude-personal/CLAUDE.md`（gitignore 対象）が**存在する場合は、セッション開始時に必ず読む**。
ローカル限定の作業メモ・運用情報はそこから辿る（個々のファイルは公開文書に列挙しない）。
