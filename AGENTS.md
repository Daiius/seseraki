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
| [prd/01-domain.md](./prd/01-domain.md) | 将棋棋譜ドメインとプロダクト動機（KIF/USI・対局メタ・解析の意味・戦型ラベル（3 層の判定・銀の戦法）） |
| [prd/02-architecture.md](./prd/02-architecture.md) | 技術スタック / monorepo / 型・ロジック共有 / 開発環境 / デプロイ姿勢 |
| [prd/03-data-model.md](./prd/03-data-model.md) | DB スキーマ（kifus / moveAnalyses / candidateMoves / commentaries） |
| [prd/04-ingestion.md](./prd/04-ingestion.md) | 投入ルート / KIF・CSA→USI 変換 / メタ抽出 / 一括取り込み |
| [prd/05-analysis.md](./prd/05-analysis.md) | worker エンジン解析 / Web 可視化 |
| [prd/06-llm-commentary.md](./prd/06-llm-commentary.md) | LLM 解説用エクスポートと自動生成（commentator） |
| [prd/07-auth-and-privacy.md](./prd/07-auth-and-privacy.md) | 認証 / API_KEY / 公開配置 |
| [prd/08-roadmap.md](./prd/08-roadmap.md) | フェーズ分け / 未実装・計画中 / 確定事項 |
| [prd/09-analytics.md](./prd/09-analytics.md) | 分析ページ（戦型別成績 / 取りこぼし / 一覧へのドリルダウン） |
| [prd/10-video-analysis.md](./prd/10-video-analysis.md) | 動画解析（録画から復元した棋譜の保存 / 局面索引 / ツリー検索）。所有者専用——取り込みは API_KEY の口だけ・web の一覧画面と一覧口は撤去済み（2026-10-17）。局面索引・局面検索は自分の対局にも使う |
| [prd/11-users.md](./prd/11-users.md) | ユーザー（自分）を server 側に持つ / 名前候補と有効期間 / 主体側の導出 |
| [prd/12-position-lab.md](./prd/12-position-lab.md) | 検討モードと局面評価（検討盤のフル編集 / 局面・名指し評価 / LLM 向け MCP） |
| [prd/13-drills.md](./prd/13-drills.md) | 出題（次の一手・実戦詰将棋。抽出条件 / 採点 / 解答履歴）。画面の整理（ホーム・入口・カードの一覧）と詰将棋の判定のブラウザ化（担当によらず・Threads 2・詰みで打ち切り）は実装済み（2026-10-25・本番は未反映） |
| [prd/14-multi-user.md](./prd/14-multi-user.md) | 複数ユーザーへの開放（SNS 認証 / 所有者スコープ / ブラウザ解析 / 保存と容量。段階 1（認証）・Postgres への移行・所有者スコープ（RLS）・所有者ごとの番号（displayNo）まで本番反映済み。ブラウザ解析は全局面解析まで 1 段で本番反映済み（2026-10-15）。2 段化と出題の採点は server・web とも実装済み（本番は未反映）。検討盤のブラウザ評価は実装済み（2026-10-29・本番は未反映）。詳細検討は未実装。評価関数を つようら王11mini / micro にしてブラウザで選べるようにするのと、手元 worker の mini への置き換えは実装済み（本番は未反映。2026-10-16 決定）。所有者ゲートの撤去と新規登録の開放は未実装） |
| [prd/15-postgres.md](./prd/15-postgres.md) | Postgres への移行（型・制約・トリガー / データ移行 / 切り替え / 実 DB テスト。本番切り替え済み（2026-10-06）・リポジトリ側の後片付けも済み） |
| [prd/16-analysis-storage.md](./prd/16-analysis-storage.md) | 解析結果の保存形式（1 棋譜の 1 回の解析を 1 行に詰める・検索に使う値だけ列に出す。本番反映済み） |

> 仕様策定の経緯（grill ログ）: [`prd/_grilling/decisions.md`](./prd/_grilling/decisions.md)
> 判断を覆したら、覆された側の節の見出し直下に「⚠ 改定済み →（新しい節）」を置く（書式はファイル冒頭）。

## 技術スタック / 構成

- フルスタック TypeScript の **pnpm monorepo**。
- **DB**: Postgres 18（[prd/15](./prd/15-postgres.md)。2026-10-06 に MySQL 8.4 から切り替え済み）/ **API**: Hono(RPC) / **ORM**: Drizzle ORM 1.0（beta 追従）
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
| [`packages/web`](./packages/web) | 棋譜管理 UI（React + Vite + TanStack Router + Tailwind）。ホーム画面に追加して standalone で使える（manifest・アイコン。service worker なし。[prd/02](./prd/02-architecture.md) §8）。ブラウザ解析の実行（`src/lib/browserAnalysis`）と、エンジンの配信物を配る Vite のプラグイン（`engine-plugin`）もここ |
| [`packages/server`](./packages/server) | Hono(RPC) API・DB・KIF/CSA パース・一括取り込み |
| [`packages/worker`](./packages/worker) | 棋譜解析（USI / やねうら王）。分離実行環境で稼働 |
| [`packages/shared`](./packages/shared) | 将棋ドメインの純ロジック（[prd/02](./prd/02-architecture.md) §3.2）。**環境非依存**（`lib: esnext` / `types: []`・DOM も node も前提にしない） |
| [`packages/kifu-vision`](./packages/kifu-vision) | 録画から棋譜を復元して取り込む手元の CLI（実験。取り込みは server の API_KEY の口へ送る。[prd/10](./prd/10-video-analysis.md)） |
| [`packages/deploy-static`](./packages/deploy-static) | web の静的ビルドのデプロイ（システムの ssh / rsync を呼ぶ。判断は純粋な関数でテスト。[prd/02](./prd/02-architecture.md) §5） |
| [`packages/engine-wasm`](./packages/engine-wasm) | ブラウザ解析のエンジン（やねうら王の WASM ビルド。評価関数の arch ごとに 1 本）と評価関数（つようら王11mini / micro・MIT。`nn.bin` + `progress.bin`）を配信物の形に揃える。**このパッケージだけ GPL-3.0**（評価関数は MIT・許諾文を同梱）・上流の SHA と配布物の sha256 は `UPSTREAM` で固定・**成果物はコミットしない**（[prd/14](./prd/14-multi-user.md) §5.5。web は `packages/web/engine-plugin` が `/engine/*` として配り、Worker から読み込む） |

**理想構成の追加（未実装・gap。[prd/08](./prd/08-roadmap.md)）**:

| パッケージ | 役割 |
|---|---|
| `packages/commentator` | LLM 解説の自動生成（薄い監視スクリプト・独立 container。[prd/06](./prd/06-llm-commentary.md)） |
| `packages/mcp` | REST をツール定義に翻訳する薄い stdio MCP サーバ（[prd/12](./prd/12-position-lab.md) §4） |

> ※ `shared` は **`board.ts` まで移した**（盤面追跡 + 盤面を要する USI→日本語表記）。
> **駒の定義（駒種・成り・総数）は `pieces.ts`、USI の座標・指し手の書式と解釈は `usi-move.ts` の 1 か所**に置く
> （駒名の表記だけは KIF の `杏` と説明文の `成香` を意図的に分けている）。
> 詰み筋の分類（`mate-line.ts` の `classifyMateLine`。[prd/05](./prd/05-analysis.md) §2.2）と
> **悪手判定（`cpl.ts` の `computeMoveLosses` / `labelOf`）** も `shared` にある。
> **USI の解釈・セッション・解析のループ（`usi/`。`createUsiSession` / `analyzeKifu`）も `shared` にある**
> ——手元 worker とブラウザ（WASM のエンジン）が共用する（[prd/02](./prd/02-architecture.md) §3.2）。
> worker の `UsiEngine` はプロセスの起動と行の入出力（`UsiTransport`）だけを持つ。
> `lib/usi.ts`（盤面を使わない USI 変換・評価値整形）・kifu-export・
> zod 検証スキーマはまだ `packages/web` にあり gap。server のプロンプト生成エンドポイント化も未着手。
> ⚠ **`shared` に環境依存を持ち込まない。** web（ブラウザ）と server / worker（node）の両方が使うため、
> `structuredClone` のような DOM / node の lib にしか型が無い API も避ける。
> **`console` と `setTimeout` も型が無い**——ログとタイマーは使う側から注入する（`usi/session.ts` の `UsiLog` / `UsiTimers`）。

## 開発コマンド

```bash
pnpm dev          # docker compose up --build --watch で全サービス起動（db, server, web, worker）
pnpm typecheck    # 全パッケージ tsc --noEmit
pnpm build        # 全パッケージのビルド
pnpm db:generate  # schema 差分から drizzle/ にバージョン管理マイグレーションを生成（DB には繋がない）
pnpm db:migrate   # マイグレーション適用（未適用分のみ・管理ロール。接続先は呼び出し環境の DB_HOST/DB_PORT/DB_NAME/DB_ADMIN_*）
pnpm db:migrate:dev  # 上を dev の DB に（.env.database を読み DB_HOST=localhost。dev もスキーマ変更はこれで当てる）
pnpm db:seed      # サンプルデータ投入（初回のみ）
pnpm --filter server test   # server のユニットテスト（vitest・DB 無し）
pnpm --filter server test:db  # server の実 DB テスト（TEST_DATABASE_URL の Postgres に使い捨ての DATABASE を作って流す。prd/15 §8.2）
pnpm --filter worker test   # worker のユニットテスト（vitest）
pnpm --filter web test      # web のユニットテスト（vitest・純ロジックのみ）
pnpm --filter shared test   # shared のユニットテスト（vitest・将棋ドメインの純ロジック）
pnpm --filter engine-wasm test  # engine-wasm の統合テスト（成果物を node で動かす。成果物が無ければ skip）
pnpm tactics:redetect       # 戦型ラベルの一括再判定（既定 dry-run / REDETECT_APPLY=1 で実書込）
pnpm positions:rebuild      # 局面索引の一括再構築（既定 dry-run / REBUILD_POSITIONS_APPLY=1 で実書込）
pnpm subjects:rebuild       # 主体側の一括再導出（既定 dry-run / REBUILD_SUBJECTS_APPLY=1 で実書込）
pnpm drills:generate        # 出題の一括生成（既定 dry-run / GENERATE_DRILLS_APPLY=1 で実書込）
pnpm deploy:web             # web をビルドして配信ディレクトリへ置く（.env.deploy を読む・assets/ は今回と 1 つ前だけ残す・既定 dry-run / --apply で実書込。prd/02 §5）。⚠ エンジンの成果物が無いとビルドで落ちる（ENGINE_REQUIRED=1。先に pnpm engine:build）
pnpm engine:build           # ブラウザ解析のエンジン（WASM）をビルドし、評価関数を取得して packages/engine-wasm/dist/engine に揃える（Docker が要る・冪等。`pnpm build` からは走らない。個別・`--check` は packages/engine-wasm/README.md）
```

> **DB は Postgres 18**（[prd/15](./prd/15-postgres.md)）。日時は `timestamptz` で、接続の時刻帯に依存しない。
> **ロールを 3 つに分ける**: 管理ロール（DDL。`migrate.js` だけ。`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`）・
> server ロール（DML のみ・RLS が効く。常駐の server のログインの経路。`DB_USER` / `DB_PASSWORD`）・system ロール（下記）。dev は
> `scripts/postgres-init/10-server-role.sh` が空の volume の初回に server ロールを作る。
> 🔒 **本番は管理ロールの資格情報を常駐の server の env に入れない**（server が侵害されても DDL・RLS の解除まで届かないように）。
> `migrate.js` は**管理用のサービス**（server と同じイメージ・普段は起動しない profile・管理ロールの env だけを読む）で流す（[prd/15](./prd/15-postgres.md) §2）。
>
> 🔴 **ログインの経路はグローバルの `db` を使わない**（[prd/14](./prd/14-multi-user.md) §4）。ハンドラは `sessionRequired` が開いた
> `c.get('tx')`（`app.user_id` を設定済み）を使い、棋譜系のクエリ関数は tx と所有者（`c.get('userId')`。セッションから取る）を受け取って
> `owner_id` で絞る。他人の行は 404。`db` を import してよいモジュールは `db-import-boundary.test.ts` の許可リストだけ。
> 全員ぶんを扱う経路（worker の報告・動画解析の取り込み・一括処理）は RLS を迂回する **system ロールの別プール**（`db/system.ts`。
> `DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD`。🔒 未設定なら server は起動しない）。ログインの経路から import すると同じテストが落とす。
>
> 🔴 **`kifus` 配下・所有者を持つ表を足したら、RLS のポリシー（`schema.ts` の `ownerPolicy`）も付ける。** drizzle-kit が
> `ENABLE ROW LEVEL SECURITY` と `CREATE POLICY` を生成する。付け忘れると test:db（`rls.db.test.ts`）が落ちる——public の表は
> 「RLS あり」か「掛けない許可リスト（Better Auth の表）」のどちらかでないといけない。⚠ `FORCE ROW LEVEL SECURITY` は付けない
> （管理ロールのマイグレーションの埋め戻しが黙って 0 行になる。prd/15 §11）。
> ⚠ **system ロールはマイグレーションでは作らない**（superuser が要る）。dev は `scripts/postgres-init/20-system-role.sh`
> （既存の volume にも冪等に流せる。`--check` あり）、本番は [prd/15](./prd/15-postgres.md) §2.1 の順で。
>
> 🔴 **DB の列名は snake_case、TS は camelCase**（prd/15 §3.6）。変換は drizzle の casing で、**表を `schema.ts` の `table`（`snakeCase.table`）で定義すると付く**
> （drizzle 1.0 では `drizzle()` ではなく表の定義に付く）。**`pgTable` で足すとその表だけ camelCase の列になる**——`test:db` が全列の名前を検査する。手書きの SQL・`sql` 断片・トリガーは DB の名前（`updated_at`）で書く。
>
> 🔴 **`updatedAt` はトリガーで更新する。drizzle-kit はトリガーを生成しない。** `updatedAt` を持つ表を
> 足したら、生成された `migration.sql` に**トリガーを手で足す**（0000 の末尾の `set_updated_at` を参照）。
> 足し忘れても何もエラーにならず、`updatedAt` が作成時刻のまま止まる（`test:db` が表とトリガーの対応を照合する）。
> ⚠ **`drizzle-kit push` もトリガーを作らない**ので `db:push` は廃止した。dev も `db:migrate:dev` で当てる。
>
> 🔴 **`kifus` 配下に表を足したら `ownerId` と複合 FK を付ける**（`schema.ts` の `ownerRef` / `ownedBy`。prd/14 §4.1）。
> 子の表の `ownerId` は親の写しで、**書き込み側が親と同じ値を入れる**（`KifuRef` で ID と組で渡す）。RLS のポリシーがこの列を見る
> （`test:db` が「`kifu_id` / `drill_id` を持つ表はすべて `owner_id` NOT NULL」を検査する）。
>
> 🔴 **`kifus` を作る経路は番号の採番（`kifu-number.ts` の `insertKifu`）を通す**（prd/14 §4.4）。棋譜は所有者ごとの番号
> `displayNo` で URL・web 向けの API に出し、**内部の主キーは出さない**（ルートを足したら `display-no.db.test.ts` にも足す）。
> `insert(kifus)` を他所に書くと `kifu-number.test.ts` が落とす。
>
> 🔴 **解析の担当（`users.analysisAssignee`。`worker` / `browser`。prd/14 §5.7）で、誰がその棋譜を解析するかが決まる。**
> - **手元 worker にジョブ・棋譜を渡す口を足したら、担当 `worker` のユーザーに絞る**（取得・quick 待ちの判定・検討盤の評価の要求・
>   出題の解答の評価は絞ってある。絞らないと、ログインした誰もが所有者の worker を使える）。出題の解答で担当 `browser` の利用者には、
>   ジョブを積まず「この局面のこの手を名指しで読んで」（`evaluate`）を返し、ブラウザが読んだ結果を付けて送り直す（`drill-engine.ts`。prd/13 §5.3）
> - **解析の報告を受ける口は、棋譜の行ロックの下で今の担当を確かめる**（`analysis-report.ts` の `submitAnalysisChunk` /
>   `recordAnalysisFailure` を通す。手元 worker とブラウザ解析の受け口で共用）。担当違い・古い世代は 201 `applied: false`——
>   ⚠ **4xx にしない**（手元 worker は 4xx を恒久的な失敗として棋譜に記録する）
> - **列を直接 UPDATE しない。** 切り替えは `switchAnalysisAssignee` だけ（同じ tx で未完了の棋譜の世代を進め、途中の解析を消す）。
>   `worker` を選べるのは所有者だけ（CHECK でも守る）
> - 🔒 **ブラウザ解析の段（quick / full）は server が棋譜の状態から決める**（`browserStageOf`。prd/14 §5.8）。報告の本体には
>   `run.profile: 'by-state'` で渡す（本文の `profile` は申告で、違えば破棄）。来歴の照合は**進行中の段の行**とだけ（`runsOfStage`。§5.9）。
>   思考時間は段ごと（`BROWSER_ANALYSIS_MOVETIME_MS`。quick 100ms・full 600ms）
> - ブラウザから届く解析結果（出題の採点の名指し評価も）は**信用できない入力**。検証と上限は `shared` の `analysis-limits.ts`（prd/14 §5.8）。
>   ブラウザから叩く書き込み口を足したら、Origin の検査（`route.ts` の `trustedOrigin`）と本文の上限（`smallBody`）も付ける
>
> 🔴 **Better Auth の表の ID は DB の既定値（`gen_random_uuid()`）で振る。** pg 方言の Better Auth は
> `generateId: 'uuid'` の ID を JS 側で振らず DB に任せるので、既定値が無いと user の作成が NOT NULL で落ちる。
>
> ⚠ **node-postgres は bigint（`count(*)`・`sum(…)`）を文字列で返す。** `sql` 断片で集計を取るときは
> `.mapWith(Number)` を通す（drizzle の `count()` は通してある）。`sql` 断片が返す日時もオフセット付きの
> 文字列で、列の変換を通らない（`drill-list-query.ts` の `isoOf`）。
>
> ⚠ **自動採番は identity 列（`generated always`）。** アプリから ID を指定して挿入できない
> （データ移行だけが `OVERRIDING SYSTEM VALUE` を使う。prd/15 §6.3）。
>
> ⚠ **enum は `text` + CHECK**（`pgEnum` にしない）。`text({ enum })` は CHECK を作らないので、
> `schema.ts` の `textEnum` で列と CHECK を組で作る。**意味の制約**（prd/15 §4.2）も CHECK で入っている。
>
> **マイグレーション方式**: **generate/migrate 方式**（`packages/server/drizzle/` にバージョン管理、`db:generate` で生成し
> `db:migrate` で未適用分だけ適用）。Postgres は DDL もトランザクションに入るので、**途中で失敗したら丸ごと戻る**。
> **`db:migrate` は接続先を呼び出し環境の `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_ADMIN_*` から取る**。
> dev DB に対しては `.env.database` を読む **`db:migrate:dev`** を使う。本番接続の具体は `.claude-personal/`。
>
> ⚠ **本番のマイグレーションはホストから流さず、イメージ同梱のエントリを使う**（下記）。
> **生成は drizzle-kit（dev 専用）、適用は drizzle-orm の migrator**（本番の実行時依存）なので、
> 本番イメージに drizzle-kit を入れずに適用でき、**dev と本番で適用経路が 1 本になる**。
> ⚠️ **`:dev` は `scripts/db-forward.sh` が張る 127.0.0.1:55432（`DB_FORWARD_PORT` で変更可）に繋ぐ。** ポートは
> forward のスクリプトが 1 か所で決め、`:dev` の scripts は `.env.database` を読んだ後に `DB_PORT=$DB_FORWARD_PORT` で上書きする
> （`.env.database` の `DB_PORT` は compose 網内の値）。5432 を避けているのは、ホストの別の Postgres や tunnel に
> 繋いでしまう取り違えを防ぐため。**待受ポートに先客がいる・forward が張れないときは何もせずに止まる。**

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
| `/app/link-owner-account.js` | Google ログインへの移行で、初回ログインの account を所有者（`"1"`）へ付け替える（移行時に 1 回。`--provider` / `--email`。[prd/07](./prd/07-auth-and-privacy.md) §4.1） | dry-run | `LINK_OWNER_APPLY=1` |

```bash
docker compose run --rm --no-deps <server サービス> /app/<entry>.js
docker compose run --rm --no-deps -e GENERATE_DRILLS_APPLY=1 <server サービス> /app/generate-drills.js
```

- 🔒 **起動時の自動適用にはしない。** 失敗時の挙動と、将来インスタンスを増やしたときの競合が読めなくなる。
- 🔒 **一括処理のエントリは RLS を迂回する system ロールで繋ぐ**（`DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD` が要る。無ければ止まる）。
- 🔴 **`migrate.js` は server の入れ替えより先に流す。** ⚠ ただし RLS のマイグレーション（`owner_scope_rls`）だけは、流した瞬間から
  古い server が何も読み書きできなくなる——system ロールを先に作り、migrate の後**すぐ**入れ替える（[prd/15](./prd/15-postgres.md) §2.1）。 新しい server は列やテーブルが無いと動かない
  （`analysisProfile`・`users.analysisAssignee` が無いと poll が落ちる／`drills` が無いと解析報告・reanalyze・名前候補の編集が落ちる）。
  **管理ロール（`DB_ADMIN_USER`）で流す**——常駐 server のロールには DDL の権限が無い。本番は管理用のサービスで流す
  （`<管理用サービス>`。常駐の server の env に管理ロールは無い）。一括処理のエントリは system ロールが要るので `<server サービス>` のまま。
- 🔴 **新しいテーブルを作るマイグレーションの後は、対応する一括生成を一度流す**（`generate-drills.js` /
  `rebuild-positions.js`）。**マイグレーションは空のテーブルを作るだけ**なので、流さないと
  **既存棋譜ぶんが 1 行も入らない**（局面検索なら 404、出題なら 1 問も出ない）。**発現するのは画面を見たとき。**
- ⚠ **`Dockerfile.prod` は `dist` を丸ごとではなく 1 本ずつ COPY する。** エントリを足したら COPY も足す
  ——書き忘れると**本番でだけファイルが無い**。実際に踏んだので、`esbuild.config.ts` が
  **Dockerfile.prod と照合してビルドを落とす**ようにしてある。

> **本番のマイグレーションはイメージに同梱したエントリで流す**（`dist/migrate.js`）:
> ```bash
> docker compose run --rm --no-deps <管理用サービス> /app/migrate.js
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

> **MySQL からのデータ移行エントリ（`migrate-from-mysql.js`）は外した**（2026-10-08・[prd/16](./prd/16-analysis-storage.md) の実装で、移行先の解析の表が変わったため）。MySQL のドライバ（`mysql2`）と dev の `db-mysql` も後片付けで外したので、**今のコードに移行をやり直す経路は無い**。移行の設計と切り替えの手順は記録として [prd/15](./prd/15-postgres.md) §6・§7 に残してある。

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
> `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER` 次第なので、**取り違えの余地がある方**であることを承知して使う。

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
>
> 🔴 **MySQL からのデータ移行でも `kifu_positions` は運ばずに作り直した**（prd/15 §6.2・§7 の 5）。
> 索引は派生値で `usiMoves` から作り直せる（[prd/14](./prd/14-multi-user.md) §6.3）。
> **流すまで局面検索は空**（初期局面すら 404・検討盤の棋譜解析の再利用も効かない）。
> 🔴 **ハッシュ関数（`shared` の `position-hash.ts`）を変えたときも全件の作り直しが要る**——
> 保存済みの値と検索時の値が食い違い、局面検索が黙って空になる。

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

> **dev でブラウザ解析を使う**（[prd/14](./prd/14-multi-user.md) §5.5・§5.10）: `pnpm engine:build` → `pnpm dev` → 設定ページで
> 「ブラウザで解析」に切り替える → 棋譜の詳細を開く（初回はダウンロードの同意を求められる）。
> - web のコンテナは `packages/engine-wasm/dist/engine` を読み取り専用で bind mount し、Vite のプラグイン
>   （`packages/web/engine-plugin`）が `/engine/*` として配る。**成果物が無くても dev は起動する**（解析できない旨の案内が出るだけ）。
> - 🔒 **エンジン本体とエンジンのホスト（`engine-plugin/engine-host.js`。classic の Worker）は Vite のバンドルに通さない。**
>   ホストに import / export を書かない（プラグインが変換せずそのまま配る）。
> - 🔴 **COOP / COEP は全応答に要る**（Worker のスクリプト・`/engine/*`・`/api` を含む）。dev / preview はプラグインが付ける。
>   本番は静的配信の側で付ける——付いていないと、ブラウザ解析は「この配信の設定では使えません」の案内になる。
> - ⚠ **`localhost` 以外の http（LAN の IP）では動かない**（SharedArrayBuffer は secure context だけ）。実機は https の remote dev で。
> - **完了は担当によらず full**（prd/14 §5.7）。ブラウザも 2 段（quick → full）で回す。「解析が終わったか」は
>   `lib/analysisPending.ts` の `isAnalysisPending` の 1 か所で判定する（画面ごとに `analysisProfile` を直に書かない）。
> - 🔒 **段はブラウザが決めない**（`runner.ts`）。開始の口が返す段（`profile`）と思考時間で回し、チャンクに段を載せる。
>   順序（開いている詳細は quick → full を最優先・使用中は常にで quick を先に）は `scheduler.ts`。並びは server の未解析の一覧に従い、
>   web で段を推測しない（prd/14 §5.10）。
> - 経過はコンソールに `[browser-analysis]` の接頭辞で出る。
> - **評価関数は つようら王11mini（既定）/ micro から端末ごとに選ぶ**（設定ページ。localStorage の `evalId`。prd/14 §5.5）。
>   arch ごとにエンジン（WASM）が別で、manifest（`shared` の `engine-manifest.ts`）が評価関数の一覧と既定を持つ。
>   **同意は評価関数ごと**（`nn.bin` の sha256 の集合）。選択の変更は次の段・次の棋譜の開始から効き、同意していない評価関数に替えたら同意を求める。
>   来歴（`engineBuild` / `evalHash` / `fvScale`）は選んでいるエントリから。
> - 🔴 **`EvalDir` は絶対パス `/eval`**（`.` だと上流が `progress.bin` を見つけられず `isready` で黙って終了する）。ホストが `nn.bin` と
>   `progress.bin` を仮想 FS の `/eval/` に置く。🔴 **配布物の `eval_options.txt` は置かない**（`FV_SCALE` が 24 に上書きされる。16 を `setoption` で渡す）
>
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
