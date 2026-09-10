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
| [prd/09-analytics.md](./prd/09-analytics.md) | 分析ページ（戦型別成績 / 取りこぼし / 一覧へのドリルダウン） |
| [prd/10-video-analysis.md](./prd/10-video-analysis.md) | 動画解析（録画から復元した棋譜の保存 / 局面索引 / ツリー検索） |
| [prd/11-users.md](./prd/11-users.md) | ユーザー（自分）を server 側に持つ / 名前候補と有効期間 / 主体側の導出 |
| [prd/12-position-lab.md](./prd/12-position-lab.md) | 検討モードと局面評価（検討盤のフル編集 / 局面・名指し評価 / LLM 向け MCP） |
| [prd/13-drills.md](./prd/13-drills.md) | 出題（次の一手・実戦詰将棋。抽出条件 / 採点 / 解答履歴） |

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
| [`packages/shared`](./packages/shared) | 将棋ドメインの純ロジック（[prd/02](./prd/02-architecture.md) §3.2）。**環境非依存**（`lib: esnext` / `types: []`・DOM も node も前提にしない） |

**理想構成の追加（未実装・gap。[prd/08](./prd/08-roadmap.md)）**:

| パッケージ | 役割 |
|---|---|
| `packages/commentator` | LLM 解説の自動生成（薄い監視スクリプト・独立 container。[prd/06](./prd/06-llm-commentary.md)） |
| `packages/mcp` | REST をツール定義に翻訳する薄い stdio MCP サーバ（[prd/12](./prd/12-position-lab.md) §4） |

> ※ `shared` は **`board.ts` まで移した**（盤面追跡 + 盤面を要する USI→日本語表記）。
> 詰み筋の分類（`mate-line.ts` の `classifyMateLine`。[prd/05](./prd/05-analysis.md) §2.2）と
> **悪手判定（`cpl.ts` の `computeMoveLosses` / `labelOf`）** も `shared` にある。
> `lib/usi.ts`（盤面を使わない USI 変換・評価値整形）・kifu-export・
> zod 検証スキーマはまだ `packages/web` にあり gap。server のプロンプト生成エンドポイント化も未着手。
> ⚠ **`shared` に環境依存を持ち込まない。** web（ブラウザ）と server / worker（node）の両方が使うため、
> `structuredClone` のような DOM / node の lib にしか型が無い API も避ける。

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
pnpm --filter shared test   # shared のユニットテスト（vitest・将棋ドメインの純ロジック）
pnpm tactics:redetect       # 戦型ラベルの一括再判定（既定 dry-run / REDETECT_APPLY=1 で実書込）
pnpm positions:rebuild      # 局面索引の一括再構築（既定 dry-run / REBUILD_POSITIONS_APPLY=1 で実書込）
pnpm subjects:rebuild       # 主体側の一括再導出（既定 dry-run / REBUILD_SUBJECTS_APPLY=1 で実書込）
pnpm drills:generate        # 出題の一括生成（既定 dry-run / GENERATE_DRILLS_APPLY=1 で実書込）
pnpm db:backfill-user       # ユーザーの表示名と名前候補を設定（移行時に 1 回・既定 dry-run / --apply で実書込）
pnpm db:rederive-played-at  # playedAt を出どころから作り直す（冪等・既定 dry-run / REDERIVE_PLAYED_AT_APPLY=1 で実書込）
```

> 🔴 **DB 接続のセッションは UTC に固定する**（`packages/server/src/db/index.ts`）。**外すと日時が
> 黙って 9h ずれる。** drizzle の mysql2 ドライバは自前の `typeCast` で `TIMESTAMP` / `DATETIME` /
> `DATE` を**文字列のまま**受け取り（mysql2 の日時変換を通さない）、その壁時計を
> `new Date(value + "+0000")` で読む——**「DB の壁時計 ＝ UTC」を前提にしている**。
> MySQL の `time_zone` が `SYSTEM`（＝ JST）だと `now()` 由来の `createdAt` / `updatedAt` が
> **+9h 未来に見える**（保存されている instant は正しい）。実際に踏んだ。
> ⚠ **`mysql.createPool({ timezone })` を足しても直らない**——その経路を drizzle が潰している。
> ⚠ **既存行を「一律 +9h」で直そうとしない。** JS が `Date` を書く `playedAt` のずれ方は
> 行ごとに違いうる（実測で**正しい行があった**）。出どころから作り直すこと
> （`db:rederive-played-at`）。詳細は [prd/03](./prd/03-data-model.md) §1.1。

> **マイグレーション方式**: dev は `db:push`（強制同期・使い捨て）、本番は **generate/migrate 方式**（`packages/server/drizzle/`
> にバージョン管理、`db:generate` で生成し `db:migrate` で未適用分だけ適用）。既存 DB を初めて管理下に載せる時は一度だけ
> `db:baseline` で 0000 を適用済み登録する（対象 DB に 0000 のテーブル・カラムが実在するかを検証し、空/取り違え/drift なら中止）。
> **`db:migrate`/`db:baseline`/`db:generate` は接続先を呼び出し環境の `DB_HOST`/`DB_PORT`/`MYSQL_*` から取る**（本番は prod 資格情報を
> export して実行）。dev DB に対して試すときは `.env.database` を読む **`db:migrate:dev` / `db:baseline:dev`** を使う。
> 本番接続の具体（cloudflared tunnel・prod 資格情報）は `.claude-personal/`。
>
> 🔴 **大文字小文字を区別したい列は照合順序を明示する。** MySQL の既定は
> `utf8mb4_0900_ai_ci` で、**`daiius` と `Daiius` を同じ値として扱う**。UNIQUE を張ると
> 片方しか登録できず、**JS 側（`Set` などで区別する）と食い違う**。実際に踏んだ
> （`user_aliases.name`）。drizzle は照合順序を扱えないので、**マイグレーション SQL に
> `COLLATE utf8mb4_bin` を手で書く**。⚠ `db:push` で作り直すと既定へ戻る。
>
> 🔴 **新しいテーブルを足したら、DB の FK を `show create table` で確認する。**
> drizzle-kit 1.0.0-beta.23 は **新規テーブルの FK から `ON DELETE CASCADE` を落とす**
> （`snapshot.json` には `"onDelete": "CASCADE"` が正しく入るのに、**`db:generate` の SQL にも
> `db:push` の適用結果にも出ない**）。実際に踏んだ（`video_kifu_sources`）。
> `.references(..., { onDelete: 'cascade' })` でも `foreignKey().onDelete('cascade')` でも同じ。
> **既存テーブルの FK は正しい**（過去の drizzle-kit で生成されたもの）ので、差分を見ても気づけない。
> ⚠ **CASCADE が無いと親行を消せなくなる**（棋譜の削除が FK 制約で落ちる）。**発現は削除時で、
> 作った直後には何も起きない。**
> - `db:generate`: 出力された `migration.sql` を手で直す（snapshot は正しいので次回生成の差分にならない）
> - `db:push`（dev）: 適用後に `ALTER TABLE … DROP FOREIGN KEY` → `ADD CONSTRAINT … ON DELETE CASCADE`
>
> ⚠ **本番のマイグレーションはホストから流さず、イメージ同梱のエントリを使う**（下記）。
> **生成は drizzle-kit（dev 専用）、適用は drizzle-orm の migrator**（本番の実行時依存）なので、
> 本番イメージに drizzle-kit を入れずに適用でき、**dev と本番で適用経路が 1 本になる**。
> **順序**: スキーマ変更（`sourceTz` 追加等）は `db:migrate` で列を足してから `db:backfill-tz` を流す（列が無いと backfill は
> 失敗する）。backfill は `sourceTz` 未設定の既存行だけを対象に `kifText` から再導出する冪等処理。**既定は dry-run**（変更案の
> 表示のみ）、`BACKFILL_APPLY=1` で実書込。dev DB に試すときは `db:backfill-tz:dev`。
> ⚠️ **`:dev` は `DB_HOST=localhost` に繋ぐ。cloudflared tunnel を上げていると localhost が本番を指しうる**（127.0.0.1:3306 の
> 取り合い）。`:dev` 実行前に `lsof -nP -iTCP:3306 -sTCP:LISTEN` で localhost の実体を確認し、tunnel は落としておく。

### 本番イメージ同梱のエントリ

server の本番イメージ（`packages/server/Dockerfile.prod`）には、常駐プロセス（`server.js`）のほかに
**使い捨てコンテナとして明示的に実行する**エントリを同梱している。distroless は `ENTRYPOINT=node` なので
**command はパスだけでよい**。

| エントリ | 何をするか | 既定 | 実書込 |
|---|---|---|---|
| `/app/migrate.js` | 未適用のマイグレーションを適用（[prd/03](./prd/03-data-model.md)） | 適用する | — |
| `/app/generate-drills.js` | 出題の一括生成（[prd/13](./prd/13-drills.md) §8） | dry-run | `GENERATE_DRILLS_APPLY=1` |
| `/app/rebuild-positions.js` | 局面索引の一括再構築（[prd/10](./prd/10-video-analysis.md) §3.2） | dry-run | `REBUILD_POSITIONS_APPLY=1` |
| `/app/redetect-tactics.js` | 戦型ラベルの一括再判定（[prd/01](./prd/01-domain.md) §6.4） | dry-run | `REDETECT_APPLY=1` |
| `/app/rebuild-subjects.js` | 主体側の一括再導出（[prd/11](./prd/11-users.md) §4.2） | dry-run | `REBUILD_SUBJECTS_APPLY=1` |
| `/app/backfill-user.js` | 表示名と名前候補の設定（移行時に 1 回。[prd/11](./prd/11-users.md) §6.2） | dry-run | `--apply`（引数を取る） |
| `/app/rederive-played-at.js` | `playedAt` を出どころから作り直す（冪等。[prd/03](./prd/03-data-model.md) §1.1） | dry-run | `REDERIVE_PLAYED_AT_APPLY=1` |

```bash
docker compose run --rm --no-deps <server サービス> /app/<entry>.js
docker compose run --rm --no-deps -e GENERATE_DRILLS_APPLY=1 <server サービス> /app/generate-drills.js
docker compose run --rm --no-deps <server サービス> /app/backfill-user.js --display "..." --names "..." --apply
```

- 🔒 **起動時の自動適用にはしない。** 失敗時の挙動と、将来インスタンスを増やしたときの競合が読めなくなる。
- 🔴 **`migrate.js` は server の入れ替えより先に流す。** 新しい server は列やテーブルが無いと動かない
  （`analysisProfile` が無いと poll が落ちる／`drills` が無いと解析報告・reanalyze・名前候補の編集が落ちる）。
  **DDL 権限の管理ユーザで流す**——常駐 server の DB ユーザには権限が無い。
- 🔴 **新しいテーブルを作るマイグレーションの後は、対応する一括生成を一度流す**（`generate-drills.js` /
  `rebuild-positions.js`）。**マイグレーションは空のテーブルを作るだけ**なので、流さないと
  **既存棋譜ぶんが 1 行も入らない**（局面検索なら 404、出題なら 1 問も出ない）。**発現するのは画面を見たとき。**
- ⚠ **`Dockerfile.prod` は `dist` を丸ごとではなく 1 本ずつ COPY する。** エントリを足したら COPY も足す
  ——書き忘れると**本番でだけファイルが無い**。実際に踏んだので、`esbuild.config.ts` が
  **Dockerfile.prod と照合してビルドを落とす**ようにしてある。
- ⚠ `baseline.js` は**同梱していない**（下記）。

> **本番のマイグレーションはイメージに同梱したエントリで流す**（`dist/migrate.js`）:
> ```bash
> docker compose run --rm --no-deps <server サービス> /app/migrate.js
> ```
> **同梱する理由はポートを開けずに済むことではなく、適用する SQL とコードのバージョンが
> 構造的に一致すること。** ホストから `pnpm db:migrate` を流す方式は「手元にある SQL を、本番で
> 動いているイメージへ流す」ことになり、**両者がずれても何も警告されない**。同じイメージの中身なら
> ずれが原理的に起きない。副次的に、接続先の取り違え（`:dev` が tunnel 越しに本番を指す等）も
> 起きなくなる。`pnpm db:migrate` は dev / 手元検証用として残す。
> ⚠ **生成した SQL はバンドルに入らない**（migrator が実行時に fs で読む）。`Dockerfile.prod` が
> `drizzle/` を別途 COPY している。`migrationsFolder` は **cwd 相対ではなくファイル相対**
> （`import.meta.url`）で解くので、dev では `packages/server/drizzle`、イメージ内では `/app/drizzle`
> を指す。**`migrate.ts` をパッケージルート直下から動かすとこの対応が壊れる。**
> ⚠ `baseline` は同梱していない。既存 DB を初めて管理下へ載せる一度きりの操作で、**中身を確かめずに
> 「適用済み」と記録してしまう**性質があるため、使い捨てコンテナから気軽に叩けるべきではない。

> **`playedAt` の作り直し**（`prd/03` §1.1）: 接続のセッションを UTC に固定した回に流し、
> 既存行が正しい絶対時刻を持っているかを確かめる。**既定は dry-run**（ずれ幅の内訳を表示）、
> `REDERIVE_PLAYED_AT_APPLY=1` で実書込。
> ```bash
> docker compose run --rm --no-deps -e REDERIVE_PLAYED_AT_APPLY=1 <server サービス> /app/rederive-played-at.js
> ```
> 🔴 **「一律 +9h」のような是正はしない。** ずれ幅は行がいつ・どの経路で書かれたかに依存し、
> 外から一律には決められない（実測で**正しい行があった**）。`playedAt` は出どころ
> （`swarsGameKey` / `kifText` + `sourceTz`）から絶対値を計算し直せるので、そちらを使う。
> **絶対値の再計算なので何度流しても同じ**（冪等）。**dry-run の出力がそのまま答え合わせになる。**

> **戦型ラベルの一括再判定**（`prd/01` §6.4「判定ロジックを更新したら一括再判定する」）:
> 判定を更新したら流す。**既定は dry-run**（変更の要約のみ）、`REDETECT_APPLY=1` で実書込。
> **ホストにポートを開けずに済む compose 網内からの実行を推奨する**:
> ```bash
> docker compose run --rm --no-deps -e REDETECT_APPLY=1 server pnpm --filter server exec tsx redetect-tactics.ts
> ```
> 本番は同じスクリプトが**イメージに同梱**されている（`dist/redetect-tactics.js`）。
> 使い捨てコンテナとして明示的に実行する（起動時の自動適用にはしない——失敗時の挙動と、
> 将来インスタンスを増やしたときの競合が読めなくなるため）。distroless は ENTRYPOINT=node
> なので command はパスだけでよい: `docker compose run --rm <service>` /
> `command: ["/app/redetect-tactics.js"]`。
> ⚠ ホストから叩く `pnpm tactics:redetect` も残してあるが、接続先は呼び出し環境の
> `DB_HOST`/`DB_PORT`/`MYSQL_*` 次第なので、**取り違えの余地がある方**であることを承知して使う。

> **局面索引の一括再構築**（`prd/10` §3.2）: 局面キーの作り方を変えたら流す。
> **既定は dry-run**、`REBUILD_POSITIONS_APPLY=1` で実書込。
> ```bash
> docker compose run --rm --no-deps -e REBUILD_POSITIONS_APPLY=1 server pnpm --filter server exec tsx rebuild-positions.ts
> ```
> 🔴 **`kifu_positions` を作るマイグレーションの直後に、本番でも一度流す**（`dist/rebuild-positions.js`）。
> マイグレーションは**空のテーブルを作るだけ**で、既存棋譜の行は 1 つも入らない。流し忘れると
> **局面検索に既存棋譜が 1 件も出ず、初期局面すら 404 になる**（新規取り込みぶんだけが現れる）。
> ```bash
> docker compose run --rm --no-deps -e REBUILD_POSITIONS_APPLY=1 <server サービス> /app/rebuild-positions.js
> ```

> **出題の一括生成**（`prd/13` §8）: 抽出規則や閾値（`DRILL_BLUNDER_CP` / `DRILL_MATE_MAX_PLIES`）を
> 変えたら流す。**既定は dry-run**（種類ごとの件数を表示）、`GENERATE_DRILLS_APPLY=1` で実書込。
> ```bash
> docker compose run --rm --no-deps -e GENERATE_DRILLS_APPLY=1 server pnpm --filter server exec tsx generate-drills.ts
> ```
> 🔴 **`drills` を作るマイグレーションの直後に、本番でも一度流す**（`dist/generate-drills.js`）。
> マイグレーションは**空のテーブルを作るだけ**で、既存棋譜ぶんの問題は 1 問も入らない。
> 流し忘れると**出題が 1 問も出ない**（`kifu_positions` と同じ罠）。
> ```bash
> docker compose run --rm --no-deps -e GENERATE_DRILLS_APPLY=1 <server サービス> /app/generate-drills.js
> ```
> 🔒 **作り直しは upsert なので解答履歴は消えない**（条件から外れた問題だけが履歴ごと消える）。

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
