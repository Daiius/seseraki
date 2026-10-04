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
   web (React/Vite) ──fetch /api──> server (Hono/Drizzle) ──> Postgres 18
                                        ▲    │
                                        │    │ （旧: 履歴からの一括取り込み。無効化・実装残置。04 §4）
                                        │    ▼
                          API_KEY polling（未解析棋譜取得 / 解析結果登録）
                                        │
                                     worker (Node.js/USI) ── やねうら王 + 評価関数
```

## 2. 技術スタック

| パッケージ | 役割 | 主要技術 |
|---|---|---|
| `web` | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI, clsx |
| `server` | API + DB + KIF パース + プロンプト生成（+ 無効化済み swars 一括取り込みの残置実装。04 §4） | Hono, Drizzle ORM (1.0.0-rc.3), Postgres（node-postgres）, zod |
| `worker` | 棋譜解析 | USI プロトコル, やねうら王 |
| `shared` | 将棋ドメインの純ロジック + zod 検証スキーマ（§3）。**`board.ts` まで実装済み**、残りは gap（§3.2） | TypeScript（React/node 非依存の純 TS）, zod |
| `commentator`（将来） | LLM 解説の自動生成（薄い監視スクリプト・独立 container） | [06](./06-llm-commentary.md) |

- **DB は Postgres 18**（[15](./15-postgres.md)。MySQL 8.4 から移した。型・CHECK 制約・トリガーで DB の側でも整合を守る）。
  named volume で永続。ドライバは node-postgres（`drizzle-orm/node-postgres`）。
  **ロールを 2 つに分ける**: 管理ロール（DDL。マイグレーション）と server ロール（DML のみ。常駐の server と一括処理）。
  ⚠ データ移行と本番の切り替え（[15](./15-postgres.md) §6・§7）は未。それまで dev には旧 MySQL を `db-mysql` として残す。
- **Drizzle ORM 1.0.0-rc.3**: 1.0 正式リリースが近く、早めにキャッチアップする目的で beta を採用。
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
- **実装状況**: 1 のうち **`board.ts` は移設済み**（盤面追跡 + `getPieceName` /
  `usiToJapaneseWithPiece`。**盤面を必要とする USI→日本語表記**もここに含まれる）。
  **`cpl.ts`（悪手判定）も移設済み**——出題（[13](./13-drills.md) §4）の抽出が server 側で
  同じ判定を要するため。⚠ 閾値の**永続化**（localStorage + React hook）は web の
  `lib/thresholds.ts` に残す（環境依存なので `shared` に入れない）。
  まだ `packages/web` にあるのは `lib/usi.ts`（盤面を使わない `usiToJapanese`・`toSenteEval`・
  `formatScore` 等）と、2・3（[08](./08-roadmap.md) の gap）。
- ⚠ **環境非依存を tsconfig で強制する**（`lib: ["esnext"]` / `types: []`）。web（ブラウザ）と
  server / worker（node）の両方が消費するため、**どちらの前提も置かない**。
  `structuredClone` のように型が `lib.dom` / `@types/node` にしか無い API も使えない
  （実際 `board.test.ts` の 1 箇所を JSON 経由の複製へ置き換えた）。
- KIF/CSA パーサーは消費者が server のみのため `shared` に移さない（第 2 の消費者が出たら再検討。[04](./04-ingestion.md)）。

## 4. データフローの原則

- **KIF→USI 変換は server が棋譜登録時に一度だけ行う**（[04](./04-ingestion.md)）。変換済み `usiMoves` を DB に保持し、
  worker と Web 盤面はこれを消費する。worker は KIF パーサーを持たない（[05](./05-analysis.md)）。
- **解析結果の登録はトランザクション**で行う。通常の submit は**局面（`moveNumber`）単位の追記 upsert**で、
  同じ局面の再送は入れ直しになる（1 チャンク = 1 トランザクション）。**前世代の全消去は `reanalyze` の
  DELETE が唯一の経路**（[03](./03-data-model.md) §3 / [04](./04-ingestion.md) §7 / [05](./05-analysis.md) §1.1c）。
- **web / API は同一オリジン配信**。ブラウザは常に同一オリジンの `/api` を叩き、server が
  `basePath('/api')` で `/api/...` を**本来の形として所有**する。各環境のプロキシ（開発時は Vite の
  `server.proxy`、本番はリバースプロキシ）は **`/api` を書き換えず素通し**で server へ渡す（strip/rewrite
  しない）。これにより dev / 本番でパスの扱いが揃い、環境差が出ない。worker は server を直叩きするため
  `${SERVER_URL}/api/worker/...` を叩く。同一オリジンのため CORS も不要。

## 5. デプロイ姿勢

- **web + server + db** は常時稼働の小さなホストに、**worker** は解析用の高メモリホストに分離配置する。
  - worker を web/server と同居させる案も検討したが、**評価関数のメモリ消費が大きく分離が現実的**。
  - VPS 上での worker 動作はメモリ的に厳しいため、解析は高スペックなデスクトップ PC に寄せる。
- **本番イメージ**:
  - server: esbuild でバンドル → distroless で実行（コンテナレジストリへ発行。レジストリ/namespace の具体は `.claude-personal/`）。
  - worker: `packages/worker/Dockerfile.prod` で本番ホスト上でビルド。やねうら王 NNUE + 評価関数 +
    定跡を同梱し、esbuild バンドルで実行（[05](./05-analysis.md) §エンジン構成）。
- **web**: Vite の静的ビルド（`index.html` + ハッシュ付きの `assets/*`）を配信ディレクトリへ置く
  （`pnpm deploy:web`・`packages/deploy-static`。接続先は `.env.deploy`、既定 dry-run / `--apply` で書き込む）。
  - **`assets/` には「今回」と「1 つ前」のデプロイのファイルだけを残す。** 上書きだけだと古いチャンクが
    溜まり続け、全部消すとデプロイ前から開いていたタブが旧チャンクを取りに来て 404 になる。
    1 つ前まで残せば、開きっぱなしのタブも次の画面遷移までは動く。
  - 世代の一覧（`current.txt` / `prev.txt`）は**配信外**のディレクトリに置く。初回（一覧が無い）は何も消さない
    ——前からあったファイルが何者か分からないため。同じビルドの再デプロイでは世代を進めない。
  - 順序は `pending.txt`（公開しかけた世代）の記録 → `assets/` → `index.html` などトップレベル →
    一覧の更新（`pending.txt` を消す）→ 削除。新しい `index.html` が未着のチャンクを指す瞬間を作らないためで、
    途中で失敗・中断したら以降は行わない。
  - `index.html` の公開後に一覧の更新だけが失敗すると、公開済みの世代が一覧に載らない。次回は残った
    `pending.txt` の世代も「1 つ前」に含めて残す（載らないまま次のデプロイで消すと、開いていたタブが 404 になる）。
    `pending.txt` は上書きせず既存分に今回を足していき、一覧の更新に成功したときだけ消す
    （再試行も失敗したときに、先に公開された世代の記録を失わないため）。
  - 接続と転送はシステムの `ssh` / `rsync` を呼ぶ（`~/.ssh/config`・鍵・known_hosts の検証をそのまま効かせる）。
    ControlMaster で接続を 1 本にまとめ、パスフレーズの入力を 1 回で済ませる。
  - **`rsync` はローカルだけでなくリモート側にも必要**（リモートに無いと `pending.txt` の記録後、
    最初の rsync 転送が `rsync: command not found` で失敗し、`pending.txt` は残る）。
    リモートのシェルは POSIX sh を前提にする。
- 人の認証は Google ログイン（Better Auth・server 側のセッション。[07](./07-auth-and-privacy.md)）。worker は API_KEY で別系統。
- **本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ・シークレット）は公開リポに含めない。**
  ローカル限定の運用メモは gitignore 対象の `.claude-personal/` に置き、「存在すれば参照」する
  （[README](./README.md) §公開リポジトリでの秘匿方針）。

## 6. 開発環境（docker compose watch）

`pnpm dev`（`docker compose up --build --watch`）で全サービスを起動する。

| サービス | ポート | ホスト公開 | 備考 |
|---|---|---|---|
| db | 5432 | なし（`scripts/db-forward.sh` が都度 127.0.0.1:55432 へ forward。`DB_FORWARD_PORT` で変更可） | Postgres 18（`pg-data`）。初回に `scripts/postgres-init/` が server ロールを作る |
| db-mysql | 3306 | なし | 旧 MySQL 8.4（`db-data`）。**server は使わない**。データ移行の練習の移行元（[15](./15-postgres.md) §8.1。後片付けで外す） |
| server | 4000 | なし（web の `/api` proxy・compose 網内で到達） | `.env.database` + `.env.server` |
| web | 5173 | あり（唯一の外向き口。remote は `127.0.0.1:<port>`） | Vite dev server, `.env.web` |
| worker | - | なし | MATERIAL エンジン（開発用・軽量）, cpus: 1, `.env.worker` |

- ファイル変更は docker watch の `sync+restart` で自動同期・再起動。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。
- **主要コマンド**:

| コマンド | 内容 |
|---|---|
| `pnpm dev` | docker compose up --build --watch で db + db-mysql + server + web + worker を起動 |
| `pnpm typecheck` | 全パッケージ `tsc --noEmit` |
| `pnpm build` | 全パッケージのビルド |
| `pnpm db:generate` | schema 差分から `packages/server/drizzle/` にマイグレーション SQL を生成（DB には繋がない。トリガーは手で足す） |
| `pnpm db:migrate` | バージョン管理マイグレーションを適用（未適用分のみ・管理ロール・接続先は呼び出し環境の env） |
| `pnpm db:migrate:dev` | 上記を dev DB（`.env.database` + `DB_HOST=localhost`）に対して実行 |
| `pnpm db:seed` | サンプルデータ投入（初回のみ。既存データがあればスキップ） |
| `pnpm --filter server test` / `--filter worker test` / `--filter web test` | ユニットテスト（vitest。§7） |
| `pnpm --filter server test:db` | 実 Postgres に当てるテスト（`TEST_DATABASE_URL`。§7） |

- **マイグレーション方式**: dev も本番も **generate/migrate 方式**（`packages/server/drizzle/` にバージョン管理、`db:generate` で生成 →
  `db:migrate` で未適用分だけ適用）。🔴 **`db:push` は使わない**——`drizzle-kit push` は手で足した `updatedAt` のトリガーを作らない
  （[15](./15-postgres.md) §3.4）。Postgres は DDL もトランザクションに入るので、失敗したマイグレーションは丸ごと戻る。
- **接続先の env は上書きしない**: `db:migrate` は呼び出し環境の `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` を
  そのまま使う。本番はイメージ同梱の `migrate.js` で流す（AGENTS.md）。dev DB には `.env.database` を読む `db:migrate:dev` を使う。
- 初回セットアップ（dev）: `pnpm dev` 起動後に `pnpm db:migrate:dev && pnpm db:seed`。dev のスキーマ変更も `pnpm db:migrate:dev`。
- **環境変数は `.env.*` ファイルで管理**（gitignore 対象。雛形は `.env.*.example`）。
  - `.env.database`（Postgres の管理ロール・server ロールと接続先。移行の練習の間は旧 MySQL の値も）/ `.env.server`（認証・API_KEY・`SWARS_*` 等）/ `.env.worker`（エンジン・server 接続）/ `.env.web`（API URL・`VITE_SWARS_USER_ID`・自分の名前候補 `VITE_SELF_NAMES`）。
  - ⚠️ Docker の `--env-file` は**インラインコメント非対応**。値の後ろに `# コメント` を書くと値の一部になるため避ける（行頭 `#` のみ可）。
- **開発 dev の worker は compose 網内で完結**する（`SERVER_URL=http://server:4000`）。dev compose は
  db / server をホストに公開せず、外向きの口は web だけ（server は `/api` proxy 経由で届く）。
- **Docker 外で worker を動かす**場合は `packages/worker/.env.example` を `.env` にコピー。`USE_MOCK=true` で
  エンジンなしのモック動作が可能（[05](./05-analysis.md)）。server はホスト公開しないため、接続先
  `SERVER_URL` は **web の公開口＝`/api` proxy**（`http://localhost:5173`。worker は `${SERVER_URL}/api/worker/...`
  を叩くので proxy 経由で server に届く）に向ける。

## 7. テスト方針

テストは**全パッケージ vitest**。テストファイルは対象と同じ場所に `*.test.ts` で置く（co-located）。

- **純ドメインロジックはテストする。** 盤面追跡・KIF/CSA パース・USI 変換・悪手判定・
  クエリ組み立てのように、入出力が値で閉じているものが対象。これらの失敗モードは
  **静かに壊れる**（盤面がずれる・棋譜が欠ける）ため型検査では捕まらない。
  - **エンジン・DB を伴う処理でも、判断だけを値で閉じた関数に切り出せばテストする。**
    解析結果のチャンク分割・再開位置（worker。スタブエンジンで駆動）や、submit の世代照合・
    完了判定（server の `analysis-submit.ts`）がこれにあたる（[05](./05-analysis.md) §1.1c）。
- **UI はテストを書かない。** 描画・ルーティングは、PR の「目視確認が必要な点」に回して人が確認する。
- **DB が実際にどう振る舞うかは実 Postgres に当てて確かめる**（`*.db.test.ts`・`pnpm --filter server test:db`。[15](./15-postgres.md) §8.2）。
  CHECK 制約・トリガー・集計の戻り値の型・`ilike`・FK の CASCADE の有無・ロール分離のように、SQL の文字列を見るだけでは
  分からないものが対象。接続先は `TEST_DATABASE_URL` で、**実行ごとにランダム名の DATABASE を作ってマイグレーションを当て、
  終わったら DROP する**。通常の `test` は DB 無しのまま回る。DOM 環境（jsdom / testing-library）は
  持ち込まず、web のテストも **node 環境の純ロジックのみ**を対象にする。
  必要になった時点で、UI テスト基盤の導入是非を改めて判断する。
- **`shared` 抽出（§3.2）ではテストも一緒に移す。** 純ロジックは `shared` へ移る予定なので、
  テストは移動先に付いていく前提で書く（対象を import する以外の依存を持たせない）。
  board 抽出では実際にこれが効き、テスト 19 件が無修正で移った（環境非依存の制約に触れた
  `structuredClone` の 1 行だけ置き換えた）。`shared` も web と同じく **node 環境の最小構成**で回す。
