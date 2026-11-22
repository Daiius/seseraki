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
| `server` | API + DB + KIF パース + プロンプト生成（+ swars 一括取り込みの残置コード（ルートは外した）。04 §4） | Hono, Drizzle ORM (1.0.0-rc.3), Postgres（node-postgres）, zod |
| `worker` | 棋譜解析 | USI プロトコル, やねうら王 |
| `shared` | 将棋ドメインの純ロジック + zod 検証スキーマ（§3）。**`board.ts` まで実装済み**、残りは gap（§3.2） | TypeScript（React/node 非依存の純 TS）, zod |
| `commentator`（将来） | LLM 解説の自動生成（薄い監視スクリプト・独立 container） | [06](./06-llm-commentary.md) |

- **DB は Postgres 18**（[15](./15-postgres.md)。MySQL 8.4 から移した。型・CHECK 制約・トリガーで DB の側でも整合を守る）。
  named volume で永続。ドライバは node-postgres（`drizzle-orm/node-postgres`）。
  **ロールを 3 つに分ける**（[15](./15-postgres.md) §2）: 管理ロール（DDL。マイグレーション）・server ロール（DML のみ・RLS が効く。常駐の server のログインの経路）・
  system ロール（DML のみ・BYPASSRLS。worker の報告・一括処理など全員ぶんを扱う経路）。
  データ移行と本番の切り替えは済み（2026-10-06。[15](./15-postgres.md) §6・§7）。dev の旧 MySQL（`db-mysql`）も外した。
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
     **エンジンとの USI のやり取りと解析のループ**（`usi/`。下の「実装状況」）もここ。
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
- **`usi/`（USI の解釈・セッション・解析のループ）は worker から移設済み**（2026-10-14。[14](./14-multi-user.md) §5.11）。
  手元 worker（子プロセスのやねうら王）とブラウザ（WASM のエンジン）が同じループを使う。
  - **エンジンとの行の入出力だけを `UsiTransport`（送る・受ける・死を知る）に切り出し**、USI の手順
    （`usi` / `isready` / `setoption` / `position` + `go`・時間切れ・`info string Error!`）は
    `createUsiSession` が持つ。worker の `UsiEngine` はプロセスの起動と transport だけを持つ。
  - **`analyzeKifu`（1 局の解析とチャンク分け）は、時間でも局面数でも区切れる**（`chunkMaxPositions`。
    ブラウザの報告は 1 チャンクの局面数に上限がある。手元 worker は今までどおり時間だけ）。
  - ブラウザの報告の形への変換（読み筋を上限で切る・検証を通る形に切りそろえる）と、開始の口の応答から
    解析を回す `analyzeKifuForBrowser` も置く（純関数。fetch・Worker には触れない）。
  - ⚠ **タイマーとログは注入で受ける**（`shared` は `setTimeout` も `console` も型を持たない）。
    `Date.now()` は使える。
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
    - 2026-10-16 決定（実装済み・本番反映済み）: 評価関数を水匠5 から **つようら王11mini**（SFNN・`nn.bin` + `progress.bin`）に替え、
      上流のコミットを `packages/engine-wasm/UPSTREAM` と同じものに固定し、配布物を sha256 で照合する（[05](./05-analysis.md) §1.2）。
- **web**: Vite の静的ビルド（`index.html` + ハッシュ付きの `assets/*`）を配信ディレクトリへ置く。
  **main に入ると出る追従（§5.2。2026-11-21 に有効化）で出す。**
  手の `pnpm deploy:web`（下の項目）は追従より前の出し方で、🔒 **今は使わない（緊急でも。§5.2）。**
  追従をやめて配信ディレクトリを実体のディレクトリに戻したときのために、`packages/deploy-static` と以下の記述を残す。
  以下は `pnpm deploy:web`（`packages/deploy-static`。接続先は `.env.deploy`、既定 dry-run / `--apply` で書き込む）の性質。
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
  - ⚠ **トップレベルの転送（`uploadTopLevelStep`）は `--delete` を付けていない**（2026-10-30 時点・未対応）。ビルドから消えた
    トップレベルのファイルや古い `engine/` の中身は配信先に溜まり、手で消すしかない。案は `--delete` を付けた dry-run の一覧を計画に
    出して確かめてから消す・消す対象を `engine/` の manifest に載らないものに限る、など。対象を誤ると本番の配信物が消えるので、変えるときは別に詰める。
- **版の確かめ方**（2026-10-30）: 本番の web と server がどのコミットから作られたかを、外から確かめられるようにする。
  値はどちらも `{ commit, builtAt, dirty }`（SHA は 40 桁・日時は ISO 8601 の UTC・`dirty` は追跡しているファイルに
  未コミットの変更がある状態でビルドしたか）。分からない値は `unknown` にし、ビルドは止めない。
  - **web**: ビルドのときに Vite のプラグイン（`packages/web/build-version`）が git から取り、`dist/version.json` と
    アプリ内（`__BUILD_VERSION__`）に埋め込む。git が無い・失敗したら `unknown`。dev は `/version.json` を同じ形で返す。
    追従のイメージ（§5.2）は、`version.json` の `commit` と同じ値を環境変数 `GIT_COMMIT` に持ち、VPS は切り替える前に両者を照合する。
    ⚠ **配信の側で `version.json` は `index.html` と同じく no-cache にする**（キャッシュされると古い版が見える）。
    （`deploy:web` の場合: `version.json` は名前が固定のトップレベルのファイルなので `index.html` と一緒に送り、世代管理には載らない。
    `version.json` が無ければ止まり、送る版を計画と一緒に表示する。）
  - **server**: `GET /api/version`（認証なし・DB に触れない）。値はイメージのビルド引数を `Dockerfile.prod` の最終ステージで
    `ENV` に入れたもの（`.dockerignore` が `.git` を除くので、イメージの中では git から取れない）。
    **server のイメージは `--build-arg GIT_COMMIT=$(git rev-parse HEAD)` などを付けてビルドする**
    （ほかに `BUILD_TIME`（`date -u +%Y-%m-%dT%H:%M:%SZ`）・`GIT_DIRTY`（`true` / `false`））。付けなければ `unknown`。
    dev の Dockerfile と compose は渡さない（`unknown`）。
    Actions のビルド（`.github/workflows/build-push-server.yml`）も同じ引数を渡す（`GIT_COMMIT` は `github.sha`・`GIT_DIRTY` は常に `false`）。
  - 設定ページの隅に、web と server の版（短い SHA・ビルド日時。dirty なら `*`）を小さく出す。
- **ブラウザ解析のエンジンと評価関数**（決定・2026-10-14。**ビルドと web への同梱は実装済み・本番の配信の設定も済み（2026-10-15）**。[14](./14-multi-user.md) §5.5）:
  - エンジン（WASM）は `packages/engine-wasm` でビルドする（`pnpm engine:build`。`packages/engine-wasm/dist/engine/` に
    配信物の形で揃う）。**成果物はコミットせず**、ビルドして配信先へ置く。
    - 2026-10-16 決定（実装済み（本番反映済み））: 評価関数を **つようら王11mini / micro** の 2 つにし、端末ごとに選べるようにする（[14](./14-multi-user.md) §5.5）。
      arch ごとにエンジンを 1 本ずつビルドするので、`engine/` には**エンジン 2 本**（arch ごとのディレクトリ）と、
      それぞれの `nn.bin`・共通の `progress.bin` と MIT の許諾文が並び、`manifest.json` が評価関数の一覧と既定を持つ。
      水匠5 は配らない（本番も 2026-10-18 から つようら王11 だけを配っている）。
  - **web のビルドが `dist/engine/` へコピーする**（`packages/web/engine-plugin`）。成果物が無ければ警告して飛ばし、
    `ENGINE_REQUIRED=1` のときは落とす（エンジンを入れ忘れたデプロイを止める）。追従の workflow（§5.2）はこれを立てて、runner の上で
    `pnpm engine:build` を流してからビルドする（`pnpm deploy:web` も立てるので、使うときは先に `pnpm engine:build` を流す）。
  - **評価関数は `assets/` とは別のディレクトリ（`engine/`）に、内容ハッシュ入りの名前で置く。** 端末の側は HTTP キャッシュに任せる。
    追従では `engine/` も世代の中身になり、古いエンジン・評価関数は世代と一緒に入れ替わる（§5.2）。
    （`deploy:web` の場合: `engine/` は世代管理の外で、トップレベルの転送は削除をしないので、古いビルド・古い評価関数は溜まり手で消す。）
  - エンジンのホスト（Worker のスクリプト）だけは `assets/` に内容ハッシュ入りの名前で出る（世代管理に載る）。
  - ⚠ **配信の側で要ること**（全応答の COOP / COEP・wasm の MIME・圧縮・`manifest.json` をキャッシュさせない）は [14](./14-multi-user.md) §5.5。
- 人の認証は Google ログイン（Better Auth・server 側のセッション。[07](./07-auth-and-privacy.md)）。worker は API_KEY で別系統。
- **本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ・シークレット）は公開リポに含めない。**
  ローカル限定の運用メモは gitignore 対象の `.claude-personal/` に置き、「存在すれば参照」する
  （[README](./README.md) §公開リポジトリでの秘匿方針）。

### 5.1 server は main に入ると本番に出る（タグの追従。2026-11-18 決定）

**状態: workflow は実装済み・本番の追従は有効（2026-11-19 に有効化）。** 有効化の直後に、本番が main のイメージへ入れ替わり、版の口が main のコミットを返すことを確かめた。

**main にマージされた server の変更は、数分で本番に出る。**

- 流れ: main への push → [`build-push-server.yml`](../.github/workflows/build-push-server.yml) が
  イメージをビルドして `<40 桁の SHA>` で push し、そのあとの job が main に突き合わせて `latest` を動かす → 本番の VPS がレジストリの `latest` を数分おきに見て、
  変わっていれば入れ替える → VPS の側で疎通と版（`/api/version` の `commit` がイメージの `GIT_COMMIT` と一致するか）を
  確かめ、駄目なら前のイメージに自動で戻す。動いているが挙動がおかしいときは、所有者が VPS で手で戻す（エージェントは VPS に触らない）。
  デプロイの仕組みの設計は、所有者の非公開のリポジトリにある。
- ビルドが走るのは、`packages/server/Dockerfile.prod` が読むものに触れた push だけ（workflow の `paths`。
  `packages/server/**`・`packages/shared/**`・根の `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `tsconfig.json` / `.dockerignore`・workflow 自身）。
  文書や web・worker・kifu-vision・deploy-static・engine-wasm だけの変更では、本番は入れ替わらない。
  `packages/web/package.json`・`packages/worker/package.json` は Dockerfile が COPY するが入れていない（`--frozen-lockfile` のためだけ。依存を変えれば `pnpm-lock.yaml` が変わる）。
- `latest` は、ビルドの job とは別の job「promote」が動かす。この job は**その回のコミットに依らず、その時点の main に突き合わせる**:
  - main を取り直し、main の先頭の workflow から `paths` の一覧を読み、main の first-parent の履歴で `paths` に当たる最後のコミット T を求める
    （merge commit なら、それ自身が T）。`latest` のイメージの `GIT_COMMIT` は、ふつう T（ビルドの入力が変わった最後のコミット）になる
  - T の SHA のタグのイメージがあれば、`latest` をそれに向ける（push 済みのイメージにあとから付ける。作り直さない。既に同じなら何もしない）。
    効く変更と文書を 1 回で push したときは先頭のコミットでしかビルドされないので、T のイメージが無ければ、T から先頭までのコミット
    （入力は T と同じ）のうちイメージのあるものに向ける（打ち切らずに全部を調べる。調べる順は回に依らず新しい方からで、どの回の job も同じ答えになる）
  - どのイメージも無ければ（T のビルドがまだ終わっていない・失敗した）何もしない。T の回が終われば、その回の job が付ける。
    T のビルドが失敗していれば `latest` は前の版のままで、Summary に「T のイメージがまだ無い」と出る。T の回を再実行すれば付く
  - 突き合わせられないとき（main を取れない・履歴が浅い・`paths` の一覧を読めない・レジストリを確かめられない）は、動かさずに失敗で終わる
  - この job は固定の group で直列に走る（判定と付与の間に、別の回の付与が割り込まない）。どの回のこの job も同じ突き合わせをするので、
    古い回の再実行でも `latest` は戻らず、待っていた回が取り消されても、生き残った回がより新しい main で同じ突き合わせをする。
    ビルドの job は並んで走ってよい（同じコミットの重複だけ直列）。main 以外の枝の回では、この job は走らない
  - `paths` の一覧は workflow の起動条件の 1 か所だけにあり、job「promote」は main の先頭のそれを読む
- 🔒 **順序を守るのは、マージする人とエージェント。** 仕組みの側にマイグレーションで止める関所は無い（所有者の方針。2026-11-18）。
  - マイグレーション・環境変数の追加・デプロイ前後の手作業（後処理の一括処理など）を伴う PR は、マージの前に所有者と段取りを決める。
    エージェントは勝手にマージしない。seseraki で具体的に何が当たるかは [AGENTS.md](../AGENTS.md) の冒頭の節。
  - マイグレーションは**古い server でも動く形（足すだけ）**にし、**先に本番へ流してからマージする**。
    同梱の `migrate.js` を管理用のサービスで流すには（[15](./15-postgres.md) §2）、そのマイグレーションを含むイメージが先に要る。
    PR の枝で workflow を手動起動すれば、`latest` を動かさずに `<40 桁の SHA>` のイメージができる。どう流すかは所有者と決める。
  - RLS（[15](./15-postgres.md) §2.1）のように古い server と両立しない変更は、「先に流してからマージ」が成り立たない。
  - ⚠ 切り戻しで server を戻しても、スキーマは戻らない。戻した server が新しいスキーマで動けることが前提になる。
- worker は今までどおり手で出す。web（静的配信）も同じ形で main から出る（§5.2。2026-11-21 に有効化）。
  server と web・worker の口を変える変更は、出る時刻がずれる（server と web は別のイメージで、出る順は決まらない）。
- 「実装済み（本番は未反映）」の書き分け: server と web の変更は、追従が有効になったので「main に入れた ＝ 数分で本番に出た」になる。
  この書き方は main に入れていない間（と、手で出す worker の変更）だけのものになる。
  追従を有効にする前に書いた記述は、2026-11-22 に本番の版を確かめて書き換えた（server は `/api/version`・web は `/version.json` がどちらも main の最新のビルドを返していた）。

### 5.2 web は main に入ると本番に出る（タグの追従）

**状態: 本番の追従は有効（2026-11-21 に有効化）。** 有効化のあと、本番の `/version.json` の `commit` が main の最新（#235 の `f93bdb1`）と一致することを確かめた。
VPS の側の仕組みは所有者の非公開のリポジトリにある（このリポジトリの外）。
本番が古く見えるときは、まずブラウザ（iOS の Safari など）と前段のキャッシュを疑う。出ている版は `/version.json` の `commit` で分かる。

- 流れ: main への push → [`build-push-web.yml`](../.github/workflows/build-push-web.yml) が runner の上でエンジン（`pnpm engine:build`）と
  web（`ENGINE_REQUIRED=1 pnpm --filter web build`。手元の `pnpm deploy:web` と同じビルド）を作り、
  `packages/web/dist` だけを入れたイメージ（[`packages/web/Dockerfile.static`](../packages/web/Dockerfile.static)。`FROM scratch` の `/site` に `dist/` の中身）を
  `<40 桁の SHA>` だけで push → 別の job が main に突き合わせて `latest` を動かす（考え方は §5.1 の server と同じ。`paths` の印は `web-paths`）。
  手動起動（workflow_dispatch）はどの枝でもでき、main 以外の枝ではその枝の先頭の `<40 桁の SHA>` を作るだけで `latest` は動かさない。
  ⚠ main を選んだ手動起動では `latest` を動かす job も走り、push の回と同じく main に突き合わせる（`latest` が無い・ずれていれば直す。直すと本番の配信の世代も進む）。
  同じコミットを作り直すと（再実行・手動起動）、`builtAt` が変わるので同じ SHA のタグが別のダイジェストに付け替わり、それが指すべき版なら `latest` も動いて世代が進む
  （版のほかは中身が同じ。変わるのは `version.json`・版を埋め込んだ JS・その JS の内容ハッシュ入りの名前を指す `index.html` などのファイル）。`latest` は、照合したダイジェストから付ける
  → 本番の VPS が `latest` を数分おきに見て、変わっていればイメージを pull し、**起動せずに**中の `/site` を取り出して、
  配信ディレクトリへ新しい「世代」として置き、リンクを切り替える。駄目なら 1 つ前の世代に戻す（仕組みの設計は所有者の非公開のリポジトリにある）。
- **ビルドを Docker の中でしない理由**: 根の `.dockerignore` が `**/dist` と `.git` を除く。中でビルドすると、`version.json` を作る
  Vite のプラグイン（`packages/web/build-version`）が git を読めず `unknown` になる。そこで runner の上でビルドし、`dist` をビルドの文脈にして COPY だけを行う。
- **版**: イメージは配信される `/version.json`（§5「版の確かめ方」の形）と、同じ commit の環境変数 `GIT_COMMIT` を持つ。
  VPS は切り替える前に、`version.json` の最上位の `commit` とイメージの `GIT_COMMIT` が一致することを確かめる。
  workflow は、ビルドの前後で追跡しているファイルが変わっていないこと（`dirty` が `false` になる）・`version.json` の `commit` がその回のコミットであること・
  `dist` にシンボリックリンクなどが無いことを確かめてから push する。`Dockerfile.static` も、`GIT_COMMIT` が 40 桁の 16 進で `version.json` と一致しなければ止まる。
- **エンジンの成果物はキャッシュする**（Actions のキャッシュ。鍵は `packages/engine-wasm` の `UPSTREAM`・`build.sh`・`lib.sh`・`fetch-eval.sh`・`eval-licenses/`）。
  復元しても `build.sh` / `fetch-eval.sh` が記録・内容ハッシュ・sha256 を `UPSTREAM` と照合し直し、合っていれば作り直さない。
  workflow も同じ判定で作り直すものがあるかを見て、あるときだけビルドに要るイメージを pull する（鍵が一致しても中身が欠けていれば、その回で作り直せる）。
  欠けたキャッシュは同じ鍵では上書きされず毎回作り直しになるので、Summary に出たらそのキャッシュを消す。
  エンジン（GPL-3.0）と評価関数の許諾文・`manifest.json`（対応ソースの上流の SHA とビルドの手順を辿れる）は、`deploy:web` と同じく `dist/engine/` に入る。
- `paths`: `packages/{web,shared,server,engine-wasm}/**`・根の `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `tsconfig.json` / `.dockerignore`・workflow 自身。
  web の `tsc` が API の型（server）を辿るので、server だけの変更でも web の世代が進む（変わるのは `version.json` と、版（`__BUILD_VERSION__`。設定ページの隅の表示）を埋め込んだ JS と、その JS の内容ハッシュ入りの名前を指す `index.html` などのファイル。CSS や画面の中身は変わらない）。
- **開きっぱなしのタブ**: VPS の側が、新しい世代に 1 つ前の世代のファイルも併せて置く（§5 の `deploy:web` の「今回と 1 つ前」と同じ性質）。
  `engine/` も世代の中身になるので、`deploy:web` のように古いエンジン・評価関数が配信先に溜まり続けることはない。
- 🔒 **`pnpm deploy:web` は使わない（緊急でも）。** VPS の配信ディレクトリは世代へのリンクになり、
  手で rsync すると今の世代の中身をその場で書き換える（記録されたイメージと中身・`version.json` が食い違い、次の版が引き継ぐファイルの記録とも合わなくなる）。
  しかも VPS は記録の上では版が合っているとみなすので、**次に main が変わるまで戻らない**。
  緊急で戻したいときは、所有者が VPS で 1 つ前の世代に戻して固定する（server と同じく VPS での作業。エージェントは VPS に触らない）。
  `pnpm deploy:web` に戻るのは、追従をやめて、配信ディレクトリを実体のディレクトリに戻したあと。`packages/deploy-static` はそのために残す。

## 6. 開発環境（docker compose watch）

`pnpm dev`（`docker compose up --build --watch`）で全サービスを起動する。

| サービス | ポート | ホスト公開 | 備考 |
|---|---|---|---|
| db | 5432 | なし（`scripts/db-forward.sh` が都度 127.0.0.1:55432 へ forward。`DB_FORWARD_PORT` で変更可） | Postgres 18（`pg-data`）。初回に `scripts/postgres-init/` が server ロールと system ロールを作る |
| server | 4000 | なし（web の `/api` proxy・compose 網内で到達） | `.env.database` + `.env.server` |
| web | 5173 | あり（唯一の外向き口。remote は `127.0.0.1:<port>`） | Vite dev server, `.env.web` |
| worker | - | なし | MATERIAL エンジン（開発用・軽量）, cpus: 1, `.env.worker` |

- ファイル変更は docker watch の `sync+restart` で自動同期・再起動。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。
- **ブラウザ解析のエンジン**（[14](./14-multi-user.md) §5.5）: web のコンテナは `packages/engine-wasm/dist/engine` を
  読み取り専用で bind mount し（`ENGINE_DIST_DIR`）、Vite のプラグインが `/engine/*` として配る。
  評価関数（64MB。つようら王11 に替えた後は mini と micro を合わせて約 13MB）をイメージにも watch の sync にも乗せないため。
  - **使うときは `pnpm engine:build` を流してから `pnpm dev`**（起動した後に流しても、作り直さずに見える）。
    流していなくても dev は起動する（ブラウザ解析が「エンジンが配置されていない」の案内になるだけ）。
  - dev の Vite は**全応答に COOP / COEP を付ける**（SharedArrayBuffer に要る）。
  - ⚠ **SharedArrayBuffer は secure context でしか使えない。** `localhost` は通るが、LAN の IP + http（`WEB_BIND=5173` での実機確認）では
    ブラウザ解析は動かない（案内が出る）。実機は https の remote dev で確かめる。
  - コンソールに `[browser-analysis]` の接頭辞で経過が出る（エンジンの読み込み・`readyok`・開始・チャンクの報告・失敗の理由）。
    `localStorage['seseraki:browserAnalysis:debug'] = '1'` で USI のやり取りも出す。
- **主要コマンド**:

| コマンド | 内容 |
|---|---|
| `pnpm dev` | docker compose up --build --watch で db + server + web を起動（worker は起動しない） |
| `pnpm dev:with-worker` | 上に手元 worker も加えて起動（compose の profile `worker`） |
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
  - `.env.database`（Postgres の管理ロール・server ロール・system ロールと接続先）/ `.env.server`（認証・API_KEY 等）/ `.env.worker`（エンジン・server 接続）/ `.env.web`（API URL。自分の名前候補は DB が正で env には持たない。[11](./11-users.md)）。
  - ⚠️ Docker の `--env-file` は**インラインコメント非対応**。値の後ろに `# コメント` を書くと値の一部になるため避ける（行頭 `#` のみ可）。
- **dev の worker は既定では起動しない**（2026-11-22。解析はブラウザ解析を主に使うため）。compose の profile `worker` に入れてあり、
  使うときは `pnpm dev:with-worker`。担当が `worker` の利用者で確かめるときに要る（[14](./14-multi-user.md) §5.7）。
- **開発 dev の worker は compose 網内で完結**する（`SERVER_URL=http://server:4000`）。dev compose は
  db / server をホストに公開せず、外向きの口は web だけ（server は `/api` proxy 経由で届く）。
- **Docker 外で worker を動かす**場合は `packages/worker/.env.example` を `.env` にコピー。`USE_MOCK=true` で
  server に繋がないモック動作が可能（🔒 既定は `false`。2026-10-30 に `true` から変えた——本番で書き忘れると黙って mock で動くため）（[05](./05-analysis.md)）。server はホスト公開しないため、接続先
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

## 8. ホーム画面に追加して使う（PWA）

iOS の「ホーム画面に追加」で、ブラウザの枠の無い standalone の画面として開けるようにしている（2026-10-18）。

- 🔒 **service worker は置かない。** オフライン対応はしない（manifest とアイコン・`<meta>` だけ）。
  ブラウザ解析の配信物（[14](./14-multi-user.md) §5.5）のキャッシュも今の HTTP キャッシュのまま。
- **manifest**: `packages/web/public/manifest.webmanifest`（`display: standalone`・`start_url` / `scope` は `/`）。
  `theme_color` は navbar（`bg-base-200`）の色。daisyUI は light / dark を `prefers-color-scheme` で切り替えるので、
  `index.html` の `theme-color` は media 付きで 2 つ置く（manifest は light の値）。
- **ステータスバーは `default`**（本文はステータスバーの下から始まる）。`black-translucent` は文字が白に固定され、
  light の navbar の上で読めなくなる。替えるなら、sticky の要素（盤のまとまり・棋譜詳細の通知）の `top` にも
  `env(safe-area-inset-top)` を足す。
- **safe-area**: `viewport-fit=cover` にし、navbar と `main`（`__root.tsx`）の padding に `env(safe-area-inset-*)` を足す
  （横向きのノッチ・下端のホームインジケータ）。通常のブラウザでは inset が 0 なので見た目は変わらない。
  `position: fixed` の要素は無い（通知も `sticky`）。固定の要素を足したら inset を考える。
- **アイコン**: 原本は SVG（駒の五角形に「細」。文字はロゴ `Logo.tsx` のグリフ輪郭を流用し、フォントを読まない）。
  `pnpm --filter web gen:icons` が `packages/web/icons/*.svg` と `public/favicon.svg` を書き、`CHROME` に手元の Chrome
  （headless）を渡すと PNG（apple-touch-icon 180・192・512・maskable 512・favicon 32）も書き出す。
  リポジトリに依存は足さず、成果物の PNG をコミットする。maskable は駒を安全域（直径 80% の円）の内側に収める。
- **配信**: `public/` の中身はビルドで `dist/` のトップレベルに出る。追従のイメージにもそのまま入り、世代と一緒に入れ替わる（§5.2）。
  manifest・アイコンは同一オリジンなので COEP（`require-corp`）に掛からない。manifest の Content-Type
  （`application/manifest+json`）は静的配信の側で付ける。
- ⚠ **standalone は Safari と cookie を共有しない。** ログイン（Google。リダイレクト型）は standalone の中でやり直しになる。
  standalone にはブラウザの戻るボタンも無い——画面の中に戻る導線を置く。
