# 15. Postgres への移行

本章は、DB を MySQL 8.4 から **Postgres 18** へ移す設計を定める。
[14](./14-multi-user.md) §9 の「当面 MySQL のまま」を改め、**所有者スコープ（[14](./14-multi-user.md) §4）の前に**移る。

> **本番切り替え済み**（2026-10-06）。残りは MySQL 側の後片付け（移行エントリは [16](./16-analysis-storage.md) の実装で外した。`mysql2` と dev の `db-mysql` が残る）と、所有者スコープ（§11）。決定の経緯は [決定ログ](./_grilling/decisions.md)「Postgres への移行」。
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
| ロール | **管理ロール**（DDL。`migrate.js`）・**server ロール**（DML のみ・RLS が効く。常駐の server のログインの経路）・**system ロール**（DML のみ・**BYPASSRLS**。全員ぶんを扱う経路＝worker の報告・動画解析の取り込み・一括処理のエントリ。2026-10-11・所有者スコープ 2b）の 3 つ。接続先は `DB_HOST` / `DB_PORT` / `DB_NAME`、資格情報は server ロールが `DB_USER` / `DB_PASSWORD`・system ロールが `DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD`・管理ロールが `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`。server と system は**別のプール**（`db/index.ts` / `db/system.ts`）。dev は `scripts/postgres-init/` が server ロール・system ロールと default privileges を作る |
| 設定 | 本番は 1GB 級の VPS に載るので小さめ（`shared_buffers` は既定・`max_connections` は 20 程度）。具体の値は `.claude-personal/` |

- worker は HTTP の API を通すだけで DB に触らないので、**worker は変わらない**

### 2.1 system ロール（RLS を迂回する）の作り方（2026-10-11）

- 🔒 **マイグレーションでは作らない。** BYPASSRLS の付与には superuser が要り、管理ロール（`migrate.js`）には無い
- 🔒 **`DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD` が無ければ server は起動しない**（fail-closed。`src/index.ts`）。一括処理のエントリも
  接続の時点で止まる。未設定のまま別のロールで繋ぐと、worker の報告が RLS で 0 行になり**黙って何もしない**ため
- 作るのは `scripts/postgres-init/20-system-role.sh`（**冪等**。superuser で流す。`--check` で現状を表示するだけ）:
  ロールが無ければ作り、`LOGIN BYPASSRLS`（superuser・DB 作成・ロール作成は持たせない）とパスワードを揃え、
  server ロールと同じ DML 権限（既存の表・シーケンスと、管理ロールが今後作るものへの default privileges）を付ける
  - dev の空の volume: compose の db が初回に流す（`10-server-role.sh` の後）
  - dev の既存の volume: `.env.database` に `DB_SYSTEM_*` を足して db を作り直し、db コンテナの中で同じスクリプトを流す
  - 本番: 下の順で行う（具体のホスト・資格情報は `.claude-personal/`）
- **本番の手順**（RLS のマイグレーションを入れたイメージに切り替えるとき。順序が大事）:
  1. 本番の DB の env に `DB_SYSTEM_USER` / `DB_SYSTEM_PASSWORD` を足す（server・一括処理のコンテナも同じ値を読む）
  2. superuser で `20-system-role.sh --check` → `20-system-role.sh` を流してロールを作る（`--check` で `rolbypassrls = t` を確かめる）
  3. 新しいイメージの `migrate.js` を流す（RLS とポリシーが入る。🔴 **これより後の古い server は、worker の報告が RLS で 0 行になる**——
     旧 server はグローバルの接続で `app.user_id` を設定しないため。2 と 3 の後は**すぐ** 4 へ進む）
  4. server を新しいイメージに入れ替える（system ロールで worker の報告を受ける）
  - 切り戻し: 前のイメージの server は `app.user_id` を設定せず、system ロールも使わないので、RLS の下では**何も読めず書けない**。
    server を前のイメージに戻すときは、管理ロールで 8 表の RLS を外す（`ALTER TABLE … DISABLE ROW LEVEL SECURITY`）

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
  - 振る舞いは MySQL の `ON UPDATE CURRENT_TIMESTAMP` に合わせる: **行の値が変わったときだけ**更新し、
    UPDATE が `updatedAt` を**明示的に書いたときはその値を尊重する**（Better Auth は自分で書く）
- 🔴 **drizzle-kit はトリガーを生成しない。** マイグレーション SQL に手で書く。**表を足したらトリガーも足す**
- ⚠ **`drizzle-kit push` もトリガーを作らない。** dev も `db:push` をやめ、マイグレーションの適用（`db:migrate`）に一本化する

### 3.5 集計の戻り値

⚠ **node-postgres は bigint を文字列で返す**（`count(*)`・`sum(…)` など）。数値として使う集計は `mapWith(Number)` を通す。
取りこぼしは実 DB のテスト（§8.2）で捕まえる。

### 3.6 命名（表・列とも小文字の snake_case）

- 🔒 **DB の表名・列名は小文字の snake_case**（`played_at`・`move_analyses`）。Postgres の慣習に合わせ、
  **psql での手作業でダブルクォートが要らない**ようにする（camelCase の列は `"playedAt"` と毎回クォートが要る）
- **TS のプロパティ名は camelCase のまま**（`kifus.playedAt`）。変換は drizzle の casing に任せ、列名の文字列を schema に書き足さない
  - drizzle 1.0 では casing が **表の定義に付く**（`snakeCase.table`。`schema.ts` の `table`）。`drizzle()` の設定ではないので、
    server・`migrate.ts`・実 DB テスト・drizzle-kit がそれだけでそろう。⚠ **`pgTable` で表を足すと、その表だけ列が camelCase になる**
    （`test:db` が全列の名前を検査する）
  - 手書きの SQL（トリガー・データ移行・テストの生 SQL）は DB の名前で書く
- 予約語を避ける（`users` は `user` を避けた名前）。Better Auth の表（`session`・`account`・`verification`）は単数形のまま
- MySQL の頃の列名は camelCase。データ移行（§6）は**読み取りを TS のプロパティ名、書き込みを DB の名前**で行う（どちらも schema から引く）
- 本番に入れる前に決めたので、0000 を生成し直した（RENAME のマイグレーションは無い）

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
- 0000 に手で足すもの: `updatedAt` のトリガー（§3.4）と**所有者の行**（ID `"1"`・仮のメール。MySQL の履歴が作っていた行と同じ形）。
  それ以外（CHECK・CASCADE・uuid の既定値）は schema から生成される
  - ⚠ 所有者の行があるので、**データ移行（§6）は users を入れる前にこの仮の行を置き換える**（ID ごと運ぶと PK が衝突する）
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
- 実装: エントリ `packages/server/migrate-from-mysql.ts`、本体 `packages/server/src/mysql-migration/`
  （`mysql-source.ts` = MySQL の読み取り / `write.ts` = Postgres への書き込み・違反の列挙・件数の照合 / `convert.ts` = 変換の純粋な関数 /
  `plan.ts` = 移す表と順序）。**読み取りと書き込みを分けてある**ので、書き込み側は MySQL 無しに行を注入して実 DB テスト（§8.2）で確かめる
- 接続: Postgres は **管理ロール**（`DB_ADMIN_*`）。identity の採番を `ALTER TABLE … RESTART WITH` で合わせるには表の所有者が要り、
  server ロール（DML だけ）では足りない。MySQL は `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`
- 🔒 **MySQL には一切書かない。** 読み取りは `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`（全表を同じ時点で読み、書く文は MySQL が拒否する）。
  単一の接続で、行はストリームで読む（全行をメモリに載せない）
- 移行先が「**適用済みのマイグレーションが 0000 の 1 本だけ**（件数と識別子で見る）・所有者の仮の行 `"1"` 以外は空（移さない表も含む）」でなければ**何もせずに中止する**（二重実行・取り違えの防止）

### 6.2 何を移すか

| 扱い | 表 |
|---|---|
| **移す** | `users`・`account`・`user_aliases`・`kifus`・`video_kifu_sources`・`move_analyses`・`candidate_moves`（エンジンの解析結果で、作り直すと高い）・`kifu_tactics`・`drills`・`drill_attempts`（解答履歴が `drills` の ID を参照するので **ID ごと移す**） |
| **移さず作り直す** | `kifu_positions`（局面索引。一番大きい。移行後に `rebuild-positions.js`） |
| **移さない** | `session`・`verification`（切り替え後に一度ログインし直すだけ） |

### 6.3 変換

- 日時: MySQL の値を**文字列のまま読み、UTC として** `Date` にする（今の typeCast と同じ解釈。実装は mysql2 の `dateStrings`）。
  ゼロ日付・存在しない日時・ミリ秒より細かい値は変換の違反（`conversion`）として一覧に出す
  - 🔴 **MySQL の読み取り接続は、最初の SELECT より前にセッションを UTC（`time_zone = '+00:00'`）に固定する。**
    `TIMESTAMP` は接続のセッションの時刻帯で文字列になるので、JST の接続で読んで UTC と解釈すると**全行が一律に 9 時間ずれる**
    （[03](./03-data-model.md) §1.1・server の `db/index.ts` と同じ罠）。固定した後に `@@session.time_zone` を読み返し、
    UTC でなければ**何も書かずに中止する**。接続を張り直す経路（プール）があるなら、すべての接続で同じことをする
- `binary` → `Buffer` のまま `bytea` へ。`json` → `jsonb`（mysql2 の既定は `JSON.parse` 済みの値を返すが、`jsonStrings` で文字列のまま受けてそのまま渡す）。
  enum → `text`。`tinyint(1)` → `boolean`。`bigint unsigned` → number（安全な整数の範囲を検査する）
- 所有者の行 `"1"` は 0000 が仮の値で入れているので、**INSERT せず移行元の値で UPDATE する**（`updatedAt` も明示するのでトリガーに上書きされない）
- 🔴 **ID は元の値のまま入れる。** identity が `generated always` なので、挿入に **`OVERRIDING SYSTEM VALUE`** が要る
  （付けないと拒否される。試作で確認）。全表を入れた後に **採番の続きを `max(id) + 1`（空の表は 1）に合わせる**（忘れると次の挿入が PK 衝突で落ちる）。
  🔴 **`setval` は使わない**——トランザクションの外の操作で、**ROLLBACK しても戻らない**（dry-run の後にも採番が動いたまま残る）。
  `ALTER TABLE … ALTER COLUMN id RESTART WITH n` は DDL なのでトランザクションに入り、ROLLBACK で戻る
- 🔒 **全体を 1 つのトランザクションで入れる。** 途中で失敗したら Postgres は空のまま

### 6.4 検査（既定 dry-run）

- **既定は dry-run**: **同じトランザクションで全部入れてみて、最後に ROLLBACK する。** 検査は DB の制約そのもの
  （意味の制約 §4.2 に加え、型の CHECK・FK・UNIQUE・NOT NULL）で行う——検査の規則をスクリプト側に書き写さない。`MIGRATE_APPLY=1` で COMMIT
- **違反は違反した行で止まらず全件を列挙する**（表・行の PK・制約名・SQLSTATE）。まとめて INSERT し、失敗した束だけ
  SAVEPOINT まで戻して 1 行ずつ入れ直す。⚠ 親の行が落ちると子の行が FK 違反として連なるので、制約ごとの件数から根を見る
- 書き込みの後（COMMIT の前）に**表ごとの件数を MySQL と照合**する。**違反か不一致があれば apply でも ROLLBACK して非 0 で終わる**
- 練習は dev で行う（dev の MySQL → dev の Postgres）。本番のデータでも、切り替えの前に dry-run を流して制約違反が無いことを確かめる

## 7. 切り替え

0. 🔴 **旧イメージ（MySQL 版）で `rederive-played-at.js` を dry-run で流し、次の 2 つがどちらも 0 件であることを確かめる。**
   移行は値をそのまま運ぶので、ここで直さないと**ずれたまま Postgres に入る**
   - **`playedAt` のずれ**。あれば `REDERIVE_PLAYED_AT_APPLY=1` で直す（主体側と出題も同じトランザクションで追随する。[03](./03-data-model.md) §1.1）
   - **`sourceTz` が未設定の行**。⚠ `rederive-played-at` は**この行を検査の対象から外し、件数を別に出すだけ**なので、
     ずれていても「変更 0 件」になる。あれば先に `sourceTz` の埋め戻し（`db:backfill-tz`。AGENTS.md）を流し、もう一度 dry-run から確かめる
   - ⚠ **埋め戻しは主体側と出題を作り直さない**（`playedAt` と `sourceTz` だけを書く）。埋め戻しを適用したら、続けて
     **`rebuild-subjects.js` を `REBUILD_SUBJECTS_APPLY=1` で流す**（主体側が変わった棋譜は出題も同じトランザクションで引き直す。
     [11](./11-users.md) §4.2・[13](./13-drills.md) §4.1）。名前候補の有効期間の境界をまたぐ棋譜が、古い主体側のまま移らないようにする
1. VPS に Postgres のコンテナを足し、空の DB に `migrate.js` で 0000 を当てる（管理ロール）
2. 本番の server と worker を止める（利用者は所有者だけなので告知は要らない）
3. MySQL の seseraki DB を `mysqldump` で丸ごとファイルに残す
4. `/app/migrate-from-mysql.js` を dry-run → `MIGRATE_APPLY=1` で流す（`MYSQL_HOST` 等を渡す）。違反 0 件・件数の照合が通ることを確かめる
5. `rebuild-positions.js` を `REBUILD_POSITIONS_APPLY=1` で流す（局面索引）
6. 新しい server（Postgres 版）を起動し、ログインし直して画面を確かめる。worker を再開する

### 戻し方

- 🔒 **MySQL 側には一切書かない。** 問題があれば旧イメージに戻すだけで元どおり動く
  （切り替え後に Postgres へ書いたデータは失われる）
- **1 週間ほど普段どおり使って問題がなければ、MySQL 側の seseraki DB を消す**（dump は手元に残す）

## 8. dev とテスト

### 8.1 dev

- compose の `db` を Postgres 18 にする。データ移行の練習の間は MySQL を `db-mysql`（旧 volume のまま・server は使わない）として並べて置き、**後片付けの PR（§9 の 5）で外す**
- dev のデータは**本番と同じ移行スクリプト**で dev の MySQL から移す（本番の練習を兼ねる）
- `db:push` はやめ、`db:migrate` に一本化する（§3.4）

### 8.2 実 DB のテスト

🔒 **実際の Postgres に当てるテストの土台をこの移行で入れる。** `pnpm --filter server test:db`（`*.db.test.ts`。通常の `test` は DB 無しのまま）。
接続先は `TEST_DATABASE_URL`（CREATE DATABASE できるロール）で、**実行ごとにランダム名の DATABASE を作ってマイグレーションを当て、終わったら DROP する**（並行して流しても衝突しない）。

- 移行で確かめる: 意味の制約が不正な値を弾くこと・トリガー・移行スクリプトの変換・集計の戻り値（§3.5）
- 所有者スコープでそのまま使う: 全エンドポイントで他人の棋譜が 404 になること・RLS

## 9. PR の分け方

1. **PRD**（本章と関連する章・AGENTS.md）
2. **移行本体**: schema・クエリ・dev compose・実 DB テストの土台・制約・トリガー・一度きりのスクリプトの削除・Better Auth のアダプタ
3. **データ移行エントリ**（§6）。dev で練習する（**エントリは実装済み**。dev の手順は AGENTS.md「MySQL からのデータ移行」）
4. 本番の切り替え（§7。PR ではなく作業）
5. **後片付け**（切り替えの 1 週間後）: 移行エントリと MySQL のドライバ・dev compose の `db-mysql` を外す

## 10. 運用

- バックアップは今の仕組み（**DB を止めてから** compose の環境を丸ごと毎日コピー）を続ける。止めてからコピーするので整合は取れる
- 本番の接続先・ロールの資格情報・設定値は `.claude-personal/`

## 11. 移行の後（所有者スコープ）

[14](./14-multi-user.md) §4 を Postgres の上で行う。PR は 4 本に分ける:

1. スキーマ（✅ 2026-10-11）: `kifus` 配下の子の表すべてに `ownerId`（親の写し）と複合 FK `(kifuId, ownerId) → kifus(id, ownerId)`、
   `kifu_positions` の索引を所有者付きに、`user_aliases` の UNIQUE を `(userId, name)` に（[14](./14-multi-user.md) §4.1・[03](./03-data-model.md) §1）。
   マイグレーションは列を NULL 可で足し、親から埋め戻してから NOT NULL と FK を付ける（1 トランザクション）。
   書き込み側は親と同じ `ownerId` を入れる。読み取りの挙動は変えない
2. クエリのスコープと **RLS**（2026-10-11 に形を決めた。[14](./14-multi-user.md) §4「RLS の形」）:
   - ✅ アプリ層のスコープ（2a。tx の張り方・クエリ関数の所有者・import の境界）は実装済み（2026-10-11）
   - ✅ RLS と別プール（2b）は実装済み（2026-10-11）。ポリシーは schema の `ownerPolicy`（drizzle-kit の `pgPolicy` が生成）、
     system ロールは §2.1。test:db がカタログ（掛け忘れ・素通りの関数とビュー）と非 superuser のロールでの振る舞いを照合する
   - リクエストごとにトランザクションを開いて `set_config('app.user_id', <id>, true)`。クエリ関数はその tx を引数で受け取る
   - worker の報告・一括処理など全員ぶんを扱う経路は **BYPASSRLS の別ロール＋別プール**。🔒 **ロールは migration で作らない**
     （BYPASSRLS の付与は superuser が要る。§2 の管理ロールには無い）。dev は `scripts/postgres-init/`、本番は手順で作る
   - ポリシーは子の表を含む全表で一様に `owner_id = current_setting('app.user_id', true)`。未設定は常に 0 件（fail-closed）
   - ⚠ 表の所有者（管理ロール）には RLS が効かない（`FORCE ROW LEVEL SECURITY` を付けない限り）。server ロールは表の所有者でないので効く。
     🔒 **`FORCE` は付けない**——付けると管理ロールのマイグレーションの埋め戻し（`UPDATE … FROM kifus`）が `app.user_id` 未設定で
     **黙って 0 行**になる。アプリは表の所有者で繋がないので、FORCE が無くてもアプリの経路はすべて RLS の下にある
3. swars を閉じる
4. **所有者ゲートを外し、同時に新規登録を既定で開く**（[07](./07-auth-and-privacy.md) §5.2）
