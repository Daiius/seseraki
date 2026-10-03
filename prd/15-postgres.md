# 15. Postgres への移行

本章は、DB を MySQL 8.4 から **Postgres 18** へ移す設計を定める。
[14](./14-multi-user.md) §9 の「当面 MySQL のまま」を改め、**所有者スコープ（[14](./14-multi-user.md) §4）の前に**移る。

> **設計確定・未実装**（2026-10-04）。決定の経緯は [決定ログ](./_grilling/decisions.md)「Postgres への移行」。
> 試作（drizzle 1.0.0-rc.3・better-auth 1.6・node-postgres を Postgres 18 に当てた）で確かめた事実を §3・§5 に書く。

---

## 1. 目的とスコープ

### 目的

- **DB の側で整合を守る。** 型（`timestamptz`）・CHECK 制約・トリガーで、アプリの書き忘れを DB が弾く
- これまで踏んだ罠の種類を DB の側で消す:
  - 日時の 9 時間ずれ（「DB の壁時計は UTC」という前提と自前の typeCast。[03](./03-data-model.md) §1.1）
  - 照合順序（大文字小文字を区別しない既定値と `utf8mb4_bin` の手書き）
  - 途中で失敗したマイグレーションが半分だけ当たる（MySQL の DDL は 1 文ごとに暗黙のコミット）
  - drizzle-kit が新規テーブルの FK から `ON DELETE CASCADE` を落とす（MySQL 方言。pg 方言では正しく出ることを試作で確かめた）
- 所有者スコープで **RLS** を使えるようにする（§11）

### 方針

- 🔒 **挙動を変えない差し替えに徹する。** 切り替え後に何か起きたら、原因を「DB の差し替え」に絞れるようにする
- 🔒 **RLS はこの移行では入れない**（所有者スコープの PR で入れる。§11）。移行ではロールを 2 つに分けるところまで（§2）

### スコープ外

- RLS のポリシーと、リクエストごとに「誰として動くか」を DB に伝える仕組み（所有者スコープ）
- VPS 上の他の個人プロジェクトの MySQL をどこへ移すか（リポジトリの外の運用）

## 2. 構成

| 項目 | 内容 |
|---|---|
| 版 | **Postgres 18**（dev・本番とも同じ。公式イメージ） |
| 配置 | dev は compose のサービス、本番は VPS の docker（姿勢のみ。具体は `.claude-personal/`） |
| ドライバ | **node-postgres（`pg`）** + `drizzle-orm/node-postgres` |
| ロール | **管理ロール**（DDL。`migrate.js` などのエントリ）と **server ロール**（DML のみ。常駐の server）を分ける。今の MySQL と同じ分け方で、RLS の土台になる |
| 設定 | 本番は 1GB 級の VPS に載るので小さめ（`shared_buffers` は既定・`max_connections` は 20 程度）。具体の値は `.claude-personal/` |

- worker は HTTP の API を通すだけで DB に触らないので、**worker は変わらない**

## 3. 型の対応

| MySQL（今） | Postgres | 補足 |
|---|---|---|
| `timestamp` ×23 | **`timestamptz`** | 自前の typeCast（[03](./03-data-model.md) §1.1）と、接続のセッションを UTC に固定する処理を撤去する。`Date` で往復する（試作で確認） |
| `date` ×2（名前候補の有効期間） | `date` | 日付だけの値。`mode: 'string'` のまま |
| `serial`（自動採番）と、それを指す `bigint unsigned` | `bigint` の **identity 列**（`generated always as identity`）と `bigint` | unsigned は無いが、2^63 に届かない。⚠ §6.3 |
| `json` ×6 | **`jsonb`** | |
| `mysqlEnum` ×9 | **`text` + CHECK** | §3.1 |
| `binary(8)`（局面のハッシュ）・`binary(81)`（盤）・`binary(14)`（持ち駒） | **`bytea` + 長さの CHECK** | `Buffer` で往復する（試作で確認）。固定長だった性質は `octet_length(…) = N` の CHECK で保つ |
| `varchar(36)`（users の ID） | `varchar(36)` | 所有者は `"1"` のまま。値も定数も変えない。⚠ §3.3 |
| `varchar(n)` / `text` / `int` / `smallint` / `boolean` | 同じ型 | 長さの指定も変えない（差分を小さく保つ） |

### 3.1 enum は `text` + CHECK

- `pgEnum` は値の削除・並べ替えができず、追加にもトランザクションの制約がある。CHECK の差し替えならトランザクションで流せる
- ⚠ **Drizzle の `text({ enum })` は TypeScript の型を付けるだけで、CHECK を作らない**（試作で確認）。
  値の一覧を 2 か所に書かないよう、**一覧から列の型と CHECK を両方作る補助関数**を `schema.ts` に置く

### 3.2 照合順序

- **既定（大文字小文字を区別する）のまま**。列に照合順序を付けない。`utf8mb4_bin` の手書きは撤去する
- MySQL の「区別しない」既定に頼っていたのは**棋譜一覧の自由文字列検索だけ**（タイトル・先手・後手の部分一致）。
  そこは **`ILIKE`** にして今の挙動（`daiius` で `Daiius` も出る）を保つ
- 主体側の判定（[11](./11-users.md)）は JS 側の `Set` で比べており、DB の照合順序に依存しない

### 3.3 Better Auth の ID

🔴 **pg 方言では、Better Auth は `generateId: 'uuid'` の ID を JS 側で振らず、DB の既定値に任せる**（試作で確認。
MySQL では JS 側で `crypto.randomUUID()` を振っていた。[07](./07-auth-and-privacy.md) §9）。
既定値が無いと **user の作成が NOT NULL 違反で落ちる**。

- `users`・`session`・`account`・`verification` の ID 列に **`default gen_random_uuid()::text`** を付ける（schema に書ける）

### 3.4 `updatedAt` はトリガーで更新する

- MySQL の `ON UPDATE CURRENT_TIMESTAMP`（`onUpdateNow()`）は Postgres に無い。**DB のトリガー**で更新する
  （Drizzle の `$onUpdate` はアプリの時計で、Drizzle を通らない更新では抜ける）
- トリガー関数を 1 つ作り、`updatedAt` を持つ表（7 つ）で共有する
- 🔴 **drizzle-kit はトリガーを生成しない。** マイグレーション SQL に手で書く。**表を足したらトリガーも足す**
- ⚠ **`drizzle-kit push` もトリガーを作らない。** dev も `db:push` をやめ、マイグレーションの適用（`db:migrate`）に一本化する

### 3.5 集計の戻り値

⚠ **node-postgres は bigint を文字列で返す**（`count(*)`・`sum(…)` など）。数値として使う集計は `mapWith(Number)` を通す。
取りこぼしは実 DB のテスト（§8.2）で捕まえる。

## 4. 制約

### 4.1 移す制約

- 既存の PK・UNIQUE・FK（CASCADE の有無を含む）・NOT NULL
- 型に付いてくる CHECK: enum の値（§3.1）・`bytea` の長さ（§3）

### 4.2 足す制約（意味の制約）

🔒 **移行に含める。** データ移行の練習（§6.4）で**本番データが満たすことを確かめてから**確定する。
満たさない行があれば、制約を緩めるか、データを直すかをその場で決める（移行の失敗の原因を後から混ぜないため、練習で出し切る）。

候補（コードとコメントが前提にしている不変条件）:

| 表 | 制約 | 前提にしている箇所 |
|---|---|---|
| `kifus` | `usiMoves` が JSON の配列（`jsonb_typeof = 'array'`） | 型 `string[]` |
| `kifus` | `sourceTz in ('JST', 'UTC')` | `localDay`（`users.ts`） |
| `kifus` | `analysisRevision >= 0` | 解析の世代 |
| `user_aliases` | `validFrom <= validTo`（両方あるとき）・`name <> ''` | [11](./11-users.md) §5 |
| `users` | `displayName <> ''` | `initialDisplayName` は空なら `(未設定)` を入れる |
| `video_kifu_sources` | `0 <= startedAtSec <= endedAtSec`・`gameIndex >= 0` | 動画の区間 |
| `move_analyses` | `moveNumber >= 0`・`multiPv >= 1`（null 可） | |
| `candidate_moves` | `rank >= 1`・`scoreType in ('cp', 'mate')`・`depth >= 0`・`pv` が配列 | コメント `"cp" \| "mate"` |
| `kifu_positions` | `moveNumber >= 0`・**`moveNumber = 0` と `move is null` が同値** | 「`moveNumber = 0` では null」 |
| `drills` | `answerScoreType in ('cp', 'mate')`・**`kind = 'mate'` と `matePlies is not null` が同値**・`candidates` / `answerPv` が配列 | 「`kind='mate'` のときのみ」 |
| `drill_attempts` | `line` が配列 | |

- ⚠ 確かめずに入れない候補: `kifus.result` の値の集合（パーサが返す文字列の種類が多い）、
  `analysisProfile` と `analysisCompletedAt` の対応（`reanalyze` での戻し方を見てから）

## 5. マイグレーションとスクリプト

- MySQL の履歴（15 本）は作業ツリーから消し、**Postgres の 0000 を 1 本生成し直す**（git の履歴には残る）
- 0000 に手で足すもの: `updatedAt` のトリガー（§3.4）。それ以外（CHECK・CASCADE・uuid の既定値）は schema から生成される
- 🔒 **マイグレーションはトランザクションで流れる**（Postgres は DDL もトランザクションに入る）。途中で失敗したら丸ごと戻る
- 削除する一度きりのスクリプト（役目を終えた・Postgres では要らない）:
  `baseline.ts`（既存 DB を管理下に載せる）・`backfill-source-tz.ts`・`backfill-user.ts`・`rederive-played-at.ts`
  （`timestamptz` で日時の不具合の種類が無くなる）
  - 🔴 **ただし、既に保存されている `playedAt` のずれは移行では直らない**（形として正しい日時なので、制約の検査も通る）。
    切り替えの最初の手順（§7 の 0）で、**旧イメージに残っている `rederive-played-at.js` の dry-run を流し、ずれと `sourceTz` 未設定の行が
    どちらも 0 件であることを確かめる**
- 残して移植する: `migrate.ts`・`link-owner-account.ts`（dev ログインが毎回使う関数のエントリ）・
  `generate-drills`・`rebuild-positions`・`rebuild-subjects`・`redetect-tactics`

## 6. データ移行

### 6.1 方式

🔒 **自前の TS スクリプト**を**本番イメージに同梱するエントリ**（`/app/migrate-from-mysql.js`）にする。
VPS の compose 網の中で MySQL から読み、Postgres へ書く。そのイメージだけ MySQL のドライバを一時的に持つ（§9 の後片付けで外す）。

- 汎用の移行ツール（pgloader）は使わない。**日時の解釈（MySQL の壁時計 ＝ UTC）を自分のコードで握る**ためと、
  件数の照合・制約の検査を同じ工程に入れるため

### 6.2 何を移すか

| 扱い | 表 |
|---|---|
| **移す** | `users`・`account`・`user_aliases`・`kifus`・`video_kifu_sources`・`move_analyses`・`candidate_moves`（エンジンの解析結果で、作り直すと高い）・`kifu_tactics`・`drills`・`drill_attempts`（解答履歴が `drills` の ID を参照するので **ID ごと移す**） |
| **移さず作り直す** | `kifu_positions`（局面索引。一番大きい。移行後に `rebuild-positions.js`） |
| **移さない** | `session`・`verification`（切り替え後に一度ログインし直すだけ） |

### 6.3 変換

- 日時: MySQL の値を**文字列のまま読み、UTC として** `Date` にする（今の typeCast と同じ解釈）
  - 🔴 **MySQL の読み取り接続は、最初の SELECT より前にセッションを UTC（`time_zone = '+00:00'`）に固定する。**
    `TIMESTAMP` は接続のセッションの時刻帯で文字列になるので、JST の接続で読んで UTC と解釈すると**全行が一律に 9 時間ずれる**
    （[03](./03-data-model.md) §1.1・server の `db/index.ts` と同じ罠）。固定した後に `@@session.time_zone` を読み返し、
    UTC でなければ**何も書かずに中止する**。接続を張り直す経路（プール）があるなら、すべての接続で同じことをする
- `binary` → `Buffer` のまま `bytea` へ。`json` → `jsonb`。enum → `text`
- 🔴 **ID は元の値のまま入れる。** identity が `generated always` なので、挿入に **`OVERRIDING SYSTEM VALUE`** が要る
  （付けないと拒否される。試作で確認）。全表を入れた後に **`setval` で採番の続きを合わせる**（忘れると次の挿入が PK 衝突で落ちる）
- 🔒 **全体を 1 つのトランザクションで入れる。** 途中で失敗したら Postgres は空のまま

### 6.4 検査（既定 dry-run）

- **既定は dry-run**: MySQL を読み、変換し、**意味の制約（§4.2）に合わない行と件数**を表示して止まる。`MIGRATE_APPLY=1` で実書込
- 実書込の後に**表ごとの件数を照合**し、合わなければ非 0 で終わる
- 練習は dev で行う（dev の MySQL → dev の Postgres）。本番のデータでも、切り替えの前に dry-run を流して制約違反が無いことを確かめる

## 7. 切り替え

0. 🔴 **旧イメージ（MySQL 版）で `rederive-played-at.js` を dry-run で流し、次の 2 つがどちらも 0 件であることを確かめる。**
   移行は値をそのまま運ぶので、ここで直さないと**ずれたまま Postgres に入る**
   - **`playedAt` のずれ**。あれば `REDERIVE_PLAYED_AT_APPLY=1` で直す（主体側と出題も同じトランザクションで追随する。[03](./03-data-model.md) §1.1）
   - **`sourceTz` が未設定の行**。⚠ `rederive-played-at` は**この行を検査の対象から外し、件数を別に出すだけ**なので、
     ずれていても「変更 0 件」になる。あれば先に `sourceTz` の埋め戻し（`db:backfill-tz`。AGENTS.md）を流し、もう一度 dry-run から確かめる
1. VPS に Postgres のコンテナを足し、空の DB に `migrate.js` で 0000 を当てる（管理ロール）
2. 本番の server と worker を止める（利用者は所有者だけなので告知は要らない）
3. MySQL の seseraki DB を `mysqldump` で丸ごとファイルに残す
4. `/app/migrate-from-mysql.js` を dry-run → `MIGRATE_APPLY=1` で流す。件数の照合が通ることを確かめる
5. `rebuild-positions.js` を `REBUILD_POSITIONS_APPLY=1` で流す（局面索引）
6. 新しい server（Postgres 版）を起動し、ログインし直して画面を確かめる。worker を再開する

### 戻し方

- 🔒 **MySQL 側には一切書かない。** 問題があれば旧イメージに戻すだけで元どおり動く
  （切り替え後に Postgres へ書いたデータは失われる）
- **1 週間ほど普段どおり使って問題がなければ、MySQL 側の seseraki DB を消す**（dump は手元に残す）

## 8. dev とテスト

### 8.1 dev

- compose の `db` を Postgres 18 にする。データ移行の練習の間は MySQL と並べて置き、移行本体の PR で MySQL を外す
- dev のデータは**本番と同じ移行スクリプト**で dev の MySQL から移す（本番の練習を兼ねる）
- `db:push` はやめ、`db:migrate` に一本化する（§3.4）

### 8.2 実 DB のテスト

🔒 **実際の Postgres に当てるテストの土台をこの移行で入れる。** compose の Postgres にテスト用の DB を作り、スキーマを当てて流す。

- 移行で確かめる: 意味の制約が不正な値を弾くこと・トリガー・移行スクリプトの変換・集計の戻り値（§3.5）
- 所有者スコープでそのまま使う: 全エンドポイントで他人の棋譜が 404 になること・RLS

## 9. PR の分け方

1. **PRD**（本章と関連する章・AGENTS.md）
2. **移行本体**: schema・クエリ・dev compose・実 DB テストの土台・制約・トリガー・一度きりのスクリプトの削除・Better Auth のアダプタ
3. **データ移行エントリ**（§6）。dev で練習する
4. 本番の切り替え（§7。PR ではなく作業）
5. **後片付け**（切り替えの 1 週間後）: 移行エントリと MySQL のドライバを外す

## 10. 運用

- バックアップは今の仕組み（**DB を止めてから** compose の環境を丸ごと毎日コピー）を続ける。止めてからコピーするので整合は取れる
- 本番の接続先・ロールの資格情報・設定値は `.claude-personal/`

## 11. 移行の後（所有者スコープ）

[14](./14-multi-user.md) §4 を Postgres の上で行う。PR は 4 本に分ける:

1. スキーマ（`kifu_positions.ownerId` の非正規化・`user_aliases` の UNIQUE を `(userId, name)` に）
2. クエリのスコープと **RLS**（ロールの設計・リクエストごとの `SET LOCAL`・全員ぶんを扱う経路の迂回ロール）
3. swars を閉じる
4. **所有者ゲートを外し、同時に新規登録を既定で開く**（[07](./07-auth-and-privacy.md) §5.2）
