# 07. 認証とプライバシー

人のログインは **Google ログインのみ**（実装は Better Auth）。**パスワードは持たない。**
worker・動画解析の取り込みは **API_KEY** の別系統で、人のログインとは交わらない。

> **段階 1 を実装済み**（2026-09-29）: Google ログイン・所有者ゲート・新規登録の拒否・dev ログイン・
> 所有者の付け替えエントリ。**退会（§7）と所有者スコープ（[14](./14-multi-user.md) §4）は後の段階。**
> 一般公開の全体設計は [14](./14-multi-user.md)、ユーザーのデータ（`users` / `user_aliases` / `ownerId`）は
> [11](./11-users.md)。決定の経緯は [決定ログ](./_grilling/decisions.md)「Google ログイン（Better Auth）の設計」。
> 実装で確かめたことは §9。
>
> 移行前の ID/パスワードの単一アカウント（§8）は**切り替えと同時に削除した。**

---

## 1. 方針

- 🔒 **パスワードを持たない。** 漏洩・再利用・リセット導線の責任を持たないため。第一は Google
- **認可コードフロー + PKCE の、リダイレクト型**（Better Auth の既定）。ポップアップ型（`window.opener` に依存）は
  ブラウザ解析の COOP と衝突する（[14](./14-multi-user.md) §5.5）。コールバックは `/api/auth/callback/google`
- 🔒 **本人の同定は Google の `sub`**（`account.accountId`）。**メールアドレスでは同定しない**（メールは変わりうる）
- 🔒 **アカウント連携は無効**（`account.accountLinking.enabled: false`）。同じメールでの自動連携は乗っ取りの経路になりやすい
- 🔒 **サーバ側セッションで、いつでも失効できる。** 今の署名 cookie は userId も失効手段も持たない（§8）
- 🔒 **Better Auth の表は `schema.ts` に手書きする**（§3）。CLI の生成は drizzle 1.0 の relations v2 に追いついていない
- **worker の API_KEY 認証は変えない**（§5）

## 2. 構成

### 2.1 server への組み込み

- `/api/auth/*` を Better Auth のハンドラへ渡す（Hono 公式の統合。`app` は `basePath('/api')` なので
  `app.on(['POST', 'GET'], '/auth/*', (c) => auth.handler(c.req.raw))`）。**Hono RPC の型とは干渉しない**
- セッションの確認は `auth.api.getSession({ headers: c.req.raw.headers })`。`sessionRequired` をこれで作り直す（§5）
- 🔴 **Better Auth には既存の `db`（`packages/server/src/db/index.ts`）を渡す。** 別の接続を作らせない——
  接続のセッションを UTC に固定しているのはこの `db` だけで、別接続では `expiresAt` などが**黙って 9h ずれる**
  （[03](./03-data-model.md) §1.1）。アダプタは `drizzleAdapter(db, { provider: 'mysql', schema })`
- `drizzleAdapter` は drizzle 1.0 rc.3（relations v2 の `db`）に渡して動く（§9）。Better Auth は **1.6 系に固定**
  （`~1.6.33`）——drizzle 1.0 との組み合わせの実績が 1.6 系にあるため。peer 依存は drizzle 0.45 を指すので警告が出るが無害
- 実装: 設定の純粋な部分は `packages/server/src/auth-config.ts`（テスト対象）、組み立てと `sessionRequired` は `auth.ts`

### 2.2 主な設定

| 設定 | 値 | 理由 |
|---|---|---|
| `socialProviders.google` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 第一のログイン手段 |
| `account.accountLinking.enabled` | `false` | §1 |
| `emailAndPassword.enabled` | **`NODE_ENV === 'development'` のときだけ `true`** | dev の抜け道の土台（§6） |
| `session.cookieCache.enabled` | `false`（明示） | 🔒 cookie cache を使うと、**失効してもキャッシュの期限まで通ってしまう** |
| `session.expiresIn` / `updateAge` | 30 日 / 1 日（仮置き） | 今の 30 日を踏襲し、使っている間は延びる |
| `user.additionalFields.displayName` | `input: false` | 表示名（§3.1）。登録時の入力から書かせない。作成時の値は `databaseHooks.user.create.before` で補う |
| `advanced.database.generateId` | UUID（36 文字） | ID を `varchar(36)` に揃え、大文字小文字の混ざらない形にする（§3.2） |
| `advanced.cookiePrefix` | `seseraki` | 他のアプリの cookie と取り違えない |
| `trustedOrigins` | `BETTER_AUTH_URL`（+ `CORS_ORIGINS`） | リダイレクト先・`Origin` の検査 |
| `advanced.disableOriginCheck` | `false`（明示） | 🔒 Better Auth は **`NODE_ENV=test` のとき既定で `Origin` / `callbackURL` の検査を外す**。env の取り違えで検査が消えないよう固定する |
| `onAPIError.errorURL` | `<BETTER_AUTH_URL>/login` | OAuth の失敗（登録を閉じている等）をログイン画面へ戻す（`?error=<code>`。web が文にする） |
| `telemetry.enabled` | `false`（明示） | 外へ何も送らない |

### 2.3 cookie

- **同一オリジンの `/api` 配下でしか使わない。** web は cookie を読まない（`HttpOnly`）。API（`/api/*`）へ届けば足りるので、
  `Path=/api` に絞る（`advanced.defaultCookieAttributes`）。OAuth の state / PKCE の cookie もコールバック
  （`/api/auth/callback/google`）で読まれるので同じ path でよい
  - ⚠ 移行前の注意（§8）はそのまま生きる: **web と API の配置を変える（サブパス配信など）ときは cookie の path も
    合わせる。** 合わないと、ログイン直後から 401 になる
  - 絞った path でもサインアウト時の cookie 削除は効く——Better Auth は削除にも作成時と同じ属性（path を含む）を使う（§9）
- `Secure` は `BETTER_AUTH_URL` が https なら自動で付く（移行前の `COOKIE_SECURE` は不要になる）
- `SameSite=Lax`（Better Auth の既定）。Google からのリダイレクト（トップレベルの GET）で state の cookie が届く

## 3. 表（`schema.ts` に手書き）

Better Auth の `user` / `session` / `account` / `verification` を持つ。**ID はすべて `varchar(36)`。**
列名はこのリポジトリの流儀（camelCase）に合わせる（アダプタは schema のキーで対応付けるので、物理名は自由）。

```
users（Better Auth の user。modelName: 'users'）
├── id: varchar(36) PK           -- 既存の所有者は "1"（§4）。新規は UUID
├── name: varchar(255)           -- Google の表示名（Better Auth が書く）
├── email: varchar(255) UNIQUE   -- Google のメール。同定には使わない（§1）
├── emailVerified: boolean
├── image: text?
├── displayName: varchar(100)    -- 画面に出す名前（独自列・additionalFields）。Google の name とは別
├── deletionRequestedAt: timestamp?  -- 退会の予約（§7。後の段階。**段階 1 では列を足していない**）
├── createdAt / updatedAt

session
├── id: varchar(36) PK
├── token: varchar(255) UNIQUE   -- 🔴 COLLATE utf8mb4_bin（§3.3）
├── userId: varchar(36) FK → users.id (CASCADE)
├── expiresAt: timestamp
├── ipAddress: text? / userAgent: text?
├── createdAt / updatedAt

account
├── id: varchar(36) PK
├── userId: varchar(36) FK → users.id (CASCADE)
├── providerId: varchar(64)      -- 'google'（dev では 'credential' もある）
├── accountId: varchar(255)      -- Google の sub（本人の同定。§1）
├── accessToken / refreshToken / idToken: text?
├── accessTokenExpiresAt / refreshTokenExpiresAt: timestamp?
├── scope: text? / password: text?（dev の email+password のみ）
├── createdAt / updatedAt
UNIQUE (providerId, accountId)

verification                     -- OAuth の state など、短命の値
├── id: varchar(36) PK
├── identifier: varchar(255) INDEX  -- 🔴 COLLATE utf8mb4_bin（乱数の文字列で引くので token と同じ扱い。§3.3）
├── value: text
├── expiresAt: timestamp
├── createdAt / updatedAt
```

### 3.1 既存の `users` を作り替える

🔒 **既存の `users` 表を Better Auth の user 表にする**（別の表を足して 1:1 で結ばない）。
**物理名は `users` のまま**（`user.modelName: 'users'`）にする——表の名前を変えると FK・コードの参照が
すべて動き、drizzle-kit の生成も改名を対話で尋ねてくる。変わるのは列と ID の型だけ。

- 🔒 **既存の行の ID は文字列 `"1"` として残す。** 参照する列（`kifus.ownerId`・`user_aliases.userId`）も
  `varchar(36)` に変えるが、**値は `"1"` のまま書き換えない**。棋譜・出題・名前候補はそのまま引き継がれる
  （[11](./11-users.md) §3 で `ownerId` を先に入れておいた理由）
- 🔒 **`displayName` は独自列として残し、Google の `name` と分けて持つ。** `name` は Google が決める値で、
  ログインのたびに上書きされうる。画面に出す名前は利用者が `/settings` で決める（[11](./11-users.md) §6.3）
- 🔴 **`displayName` は NOT NULL のまま、user の作成時に `databaseHooks.user.create.before` で初期値を補う。**
  `input: false` の列には OAuth のプロフィールも登録の入力も渡らないので、補わないと**新規 user の INSERT が落ちる**——
  初回 Google ログインの X（§4）も dev ログインの user（§6.1）も作れず、**移行を始められない**。
  初期値は **作成時の `name`**（Google の表示名 / dev ログインの固定名。空なら `(未設定)`）。
  - 🔴 **列の長さに収めてから写す。** `name` は `varchar(255)`・`displayName` は `varchar(100)` なので、長い Google の名前を
    そのまま写すと**作成が落ちる**（strict mode でないなら黙って切れる）。**先頭 100 文字（コードポイント単位）に切り詰める**。
    MySQL の `varchar(n)` は文字数で数えるので、JS の `.slice`（UTF-16 単位）ではなく `Array.from` などで数え、
    **サロゲートペアを割らない**。切り詰めた名前は利用者が `/settings` で直せる
  - **作成時に 1 回写すだけ**で、以後のログインでは触らない。「Google の `name` で上書きしない」はこれで保たれる
  - nullable にして表示時に `name` で補う案は採らない。`displayName` が「利用者が決めていないと Google 次第で変わる値」になり、
    [11](./11-users.md) §2 の「画面に出す名前。対局者名とも Google の name とも別」がぼやける。全読み出し箇所に補完が要るのも避けたい
  - 移行の X は消える（§4）ので、`"1"` の `displayName` は既存の値のまま
- ⚠ **`"1"` の行にも `name` / `email`（NOT NULL・UNIQUE）が要る。** マイグレーションで
  `name = displayName`、`email` は**予約済みドメインのプレースホルダ**（例: `owner-1@example.invalid`）で埋める。
  🔴 **所有者の本物の Gmail アドレスを先に入れてはいけない**——Better Auth は `sub` で見つからないとき
  メールで user を探し、見つかると**連携が無効なので初回ログインを拒否する**。移行（§4）が始められなくなる

### 3.2 マイグレーション

型の変更とデータ投入が絡むので、**生成した SQL を土台に手で書く**（[11](./11-users.md) §6.1 と同じ扱い）。順序:

1. `user_aliases` と `kifus` から `users` への FK を外す
2. `users.id` を `varchar(36)` に（`bigint` の `1` は `'1'` になる。AUTO_INCREMENT も外れる）
3. `user_aliases.userId`・`kifus.ownerId` を `varchar(36)` に（値は `'1'` のまま）
4. `users` に `name` / `email` / `emailVerified` / `image` を足し、`"1"` の行を埋めてから NOT NULL・UNIQUE にする
5. FK を張り直す（`user_aliases` は CASCADE・**`kifus.ownerId` は CASCADE にしない**。[14](./14-multi-user.md) §3.1）
6. `session` / `account` / `verification` を作る

- 🔴 **FK の文字列列は、参照先と文字セット・照合順序を揃える。** 揃っていないと FK の作成で落ちる。
  ID は UUID（小文字の 16 進）で生成するので、ID 列は既定の照合順序でよい
- 🔴 **`session` / `account` の FK から `ON DELETE CASCADE` が落ちる。** drizzle-kit は rc.3 でも
  新規テーブルの FK の CASCADE を生成しない（AGENTS.md）。**生成した SQL を手で直し、適用後に
  `show create table` で確かめる。** 落ちたままだと、ユーザーを消すときに FK で止まる
- ⚠ **データ投入（`"1"` の行を埋める）はマイグレーションの 2 つ目の例外**になる（1 つ目は [11](./11-users.md) §6.1）。
  理由は同じで、`NOT NULL`・`UNIQUE` の成立にデータが要る
- 実装: `packages/server/drizzle/20260929123049_google_login/migration.sql`（上の順序で手書き）。
  drizzle-kit の生成物は **FK を外さずに `users.id` の型を変えようとして落ちる**・データ投入が無い・照合順序が無い、の 3 点で
  そのままでは使えない。今回の生成では新規テーブルの FK に CASCADE が出ていた（`ALTER TABLE … ADD CONSTRAINT` の形）が、
  AGENTS.md の罠は再現条件が分かっていないので、**適用後の `show create table` での確認はやめない**
- ⚠ `serial` の名残で、`users` には主キーとは別に `id` の UNIQUE 索引が残る（`serial` = `UNIQUE` 付き）。
  名前が環境で揃っている保証が無く、落とすと失敗しうるので残した（害は無い）

### 3.3 照合順序

🔴 **`session.token` は `utf8mb4_bin`（大文字小文字を区別する）にする。**（`verification.identifier` も同じ） MySQL の既定
（`utf8mb4_0900_ai_ci`）では、**大文字小文字だけが違う token が同じ値として照合される**。
drizzle は照合順序を扱えないので、**マイグレーション SQL に手で書く**（`user_aliases.name` と同じ）。
⚠ **`db:push` で作り直すと既定に戻る。** dev で作り直したときは確かめる。

## 4. 既存アカウント（所有者）の移行

所有者が初めて Google でログインすると、Better Auth は**新しい user（ID = X）と account（sub → X）を作る**
（`"1"` の行にはまだ account が無いので、`sub` で見つからない）。これを `"1"` に付け替える。

1. 切り替えをデプロイする（マイグレーション → server。旧ログインはこの時点で消える。§8）。
   **`AUTH_ALLOW_SIGNUP=true` で起動し、新規作成の窓を開ける**（§5.2）
2. 所有者が Google でログインする。X が作られるが、**所有者ゲート（§5.1）で何も見えない**
3. 付け替える（§4.1 のエントリ。中身は下の SQL）
4. もう一度ログインする。`sub` → `"1"` で入れる
5. **`AUTH_ALLOW_SIGNUP` を外して再起動し、窓を閉じる**

```sql
-- @provider は本番 'google'（dev の練習では 'credential'。§6.3）
SET @provider := 'google';

-- 0. 確認: 付け替える account がちょうど 1 行で、"1" にはまだその provider の account が無いこと
SELECT a.userId, u.email, u.name FROM account a JOIN users u ON u.id = a.userId
 WHERE a.providerId = @provider AND a.userId <> '1';                        -- 1 行・所有者のメールであること
SELECT COUNT(*) FROM account WHERE providerId = @provider AND userId = '1';  -- 0 であること

START TRANSACTION;
SELECT userId INTO @x FROM account WHERE providerId = @provider AND userId <> '1';
SELECT name, email, emailVerified, image INTO @name, @email, @verified, @image FROM users WHERE id = @x;
-- 1. account を "1" に付け替える
UPDATE account SET userId = '1' WHERE providerId = @provider AND userId = @x;
-- 2. X を消す（session は CASCADE で消える。account は付け替え済みなので残る）
DELETE FROM users WHERE id = @x;
-- 3. Google の値を "1" に写す（email は UNIQUE なので X を消した後）。displayName は触らない
UPDATE users SET name = @name, email = @email, emailVerified = @verified, image = @image WHERE id = '1';
COMMIT;
```

- 🔒 **利用者が所有者 1 人のうちに切り替える。** 失敗しても DB を直接触って戻せる（`"1"` の行と
  棋譜は一切動かさない手順なので、最悪でも account を消してやり直せば済む）
- ⚠ 手順 0 で**メールが所有者のものか必ず目で確かめる。** 窓（§5.2）の間に他人が先にログインしていた場合、
  その X を付け替えると**他人に全データを渡す**

### 4.1 流し方 — イメージ同梱のエントリ

🔒 **`/app/link-owner-account.js` として本番イメージに同梱する**（AGENTS.md の同梱エントリと同じ形）。
**既定は dry-run**（付け替え対象の X のメール・名前を表示して止まる）、`LINK_OWNER_APPLY=1` で実書込。
`--provider` で provider を指定する（既定 `google`）。`--email` で対象をメールで絞れる
（窓の間に他人が入り込んで対象が複数になったとき。絞っても「ちょうど 1 行」の確認は同じ）。
実装は `packages/server/src/owner-account.ts`（判定の `decideOwnerLink` はテスト対象）と `link-owner-account.ts`。
付け替えられる状態でなければ（対象なし・複数・付け替え済み）終了コード 1。

```bash
docker compose run --rm --no-deps <server サービス> /app/link-owner-account.js
docker compose run --rm --no-deps -e LINK_OWNER_APPLY=1 <server サービス> /app/link-owner-account.js
```

- 手順 0 の確認（対象がちょうど 1 行・`"1"` にその provider の account が無い）を**コードで強制する**。
  満たさなければ書き込まずに止まる
- 🔒 **dev ログイン（§6.1）の自動の付け替えと同じ関数を使う。** 本番で一度しか流さないコードが、dev で毎回通る
- ホストから SQL を流す方式を採らないのは、同梱エントリ全般と同じ理由（適用するコードとイメージが一致する・
  接続先の取り違えが起きない）。`baseline.js` を同梱しない理由（中身を確かめずに記録する）は当てはまらない——こちらは確かめてから書く
- 上の SQL はエントリが行うことの正典であり、エントリが使えないときの手順でもある

## 5. ルート保護

| 系統 | 対象 | 認証 |
|---|---|---|
| Better Auth | `/api/auth/*`（サインイン・コールバック・サインアウト・セッション取得） | Better Auth 自身 |
| セッション | 棋譜・出題・設定など web 向けのエンドポイント | `sessionRequired`（Better Auth のセッション + 所有者ゲート。§5.1） |
| （無効） | `/api/swars/*`（一括取り込み系） | **常時 404**。認証前に遮断（[04](./04-ingestion.md) §4。[14](./14-multi-user.md) §4.3 で撤去） |
| API_KEY | `/api/worker/*`・動画解析の取り込み（`POST /video-analysis/kifus`） | `Authorization: Bearer <API_KEY>`（別系統・変更なし） |
| dev のみ | `/api/dev/login` | `NODE_ENV=development` のときだけ登録（§6） |

- **worker 認証はユーザー認証と別系統**。worker は inbound の口を持たず、API_KEY で server を polling する
  （[02](./02-architecture.md) / [05](./05-analysis.md)）。API_KEY 経路で作られる行の所有者は**所有者（`"1"`）固定**
  （worker・動画解析とも所有者専用。[14](./14-multi-user.md) §4・§5.1）
- `currentUserId()`（今は `users` の先頭行）は、**セッションの userId**（web）/ 所有者の定数（API_KEY 経路）に置き換える。
  `ownerId` を受け渡す関数の型は `number` → `string`
- 全リクエストに `hono/logger` でアクセスログを出力。**web と API は同一オリジン配信なので通常 CORS は不要**
  （`CORS_ORIGINS` 未設定なら CORS ミドルウェア自体が無効）。別オリジンの web から叩く特殊構成のときだけ
  `CORS_ORIGINS`（カンマ区切り）を設定する（`credentials: true`。`trustedOrigins` にも足す）

### 5.1 所有者ゲート（所有者スコープが入るまで）

🔴 **所有者スコープ（[14](./14-multi-user.md) §4）が入るまで、他人がログインできると全データが見える。**
今のクエリは所有者で絞っていない（絞っているのは出題系だけ）ので、「セッションがあること」だけを見て通すと、
**ログインできた人は誰でも所有者の棋譜を読み書き・削除できる**。

- 🔒 **`sessionRequired` は「セッションがあり、かつ userId が所有者（`"1"`）」のときだけ通す。**
  それ以外のセッションは **403**（未ログインは 401）
- 新規登録を閉じる（§5.2）のとは**別に、必ず入れる。** 登録を閉じる仕組みが漏れても（設定の取り違え・
  移行中の窓）、ゲートがあればデータは見えない。**移行手順（§4）の 2 で X が何も見えないのもこのゲートのおかげ**
- 🔒 **所有者スコープ（段階 2）を入れたら、このゲートを外す**——外す前に全エンドポイントのスコープを検査する
  （[14](./14-multi-user.md) §4 のテスト）

### 5.2 新規登録を閉じる（所有者スコープが入るまで）

🔒 **他人の Google ログインで user を作らせない。** `databaseHooks.user.create.before` で新規作成を拒否する。

- 理由: 作らせても所有者ゲート（§5.1）で何もできないが、**目的の無い他人のメール・名前を溜め込む**
  （規約・プライバシーポリシーの前）。一般公開のときに「同意していない既存ユーザー」も残る
- **移行（§4）の間だけ `AUTH_ALLOW_SIGNUP=true` で作成を許す**（切り替えのデプロイで立て、§4 が済んだら外して再起動）。
  窓の間に他人が入り込んでも、ゲートで何も見えず、§4 の手順 0（エントリの dry-run）で見分けて消せる
- **development では常に許す**（dev ログインが所有者と `?as=` の他ユーザーを作るため。§6.1）
- 採らなかった案: 「google の account が 1 行も無い間だけ作成を許す」。環境変数も再起動も要らないが、
  窓を閉じる条件が暗黙的で、他人が先に入ると所有者が入れなくなる
- 一般公開（[14](./14-multi-user.md) §10 の段階 5）でこの拒否を外す

### 5.3 web

- `/login` は **「Google でログイン」ボタンだけ**。押すと `POST /api/auth/sign-in/social`（`provider: 'google'`,
  `callbackURL`: 元の URL）→ 返った URL へ遷移 → Google → `/api/auth/callback/google` → `callbackURL` へ戻る
  （`callbackURL` は `trustedOrigins` で検査される）
- `__root.tsx` の `beforeLoad` のガードは、移行前の `/api/auth/me` をやめて **`GET /api/me`**（`/api/auth/*` の外。
  401 / 403 / `{ userId }`）を叩く。401 は `/login?redirect=<元の URL>`、403 は「このアカウントでは利用できません」と
  ログアウトを出す（実装では 403 も `/login` へ送り、ログイン画面がその表示に切り替わる）
- Google ログインの失敗は `/login?error=<code>` に戻る（`errorCallbackURL`）。`signup_disabled`（登録を閉じている）などを文にして出す
  - `/api/auth/*` は Better Auth のハンドラが丸ごと受けるので、**アプリの API をその下に置かない**
- ログアウトは `POST /api/auth/sign-out`（**セッションの行が消える**＝その場で失効する）
- dev のときだけ「dev ログイン」ボタンを出す（`import.meta.env.DEV`。§6）

## 6. 開発環境

- 🔒 **`NODE_ENV=development` のときだけ** email+password と **dev ログインの抜け道**（`POST /api/dev/login`）を有効にする。
  **それ以外（production・未設定・test）では登録すらしない**（fail-closed）。明示の allowlist にするのは、
  `NODE_ENV` を付け忘れた本番で抜け道が開く事故（fail-open）を構造的に起こさないため
- ⚠ **dev compose の server に `NODE_ENV=development` を足す必要がある**（今は付いていない）
- 目的は **Playwright の E2E を Google なしで通す**こと。本物の Google ログインも、localhost・リモート dev の
  オリジンを OAuth クライアントのリダイレクト先に登録すれば dev で試せる
- 秘密のフォールバック（`BETTER_AUTH_SECRET` 未設定時の固定値）も development だけ。それ以外は起動を失敗させる

### 6.1 dev ログインの抜け道

参考実装と同じ方式: 固定の dev ユーザー（所有者用は `dev@example.invalid`・`?as=<名前>` は `dev+<名前>@example.invalid`）で
`signUpEmail`（既にあれば握りつぶす）→ `signInEmail` して、
**Better Auth の本物のセッション cookie** を返す。以後の経路（`sessionRequired`・失効）は本番と同じものを通る。

- 🔴 **dev ユーザーも所有者ゲート（§5.1）に掛かる。** 付け替えなければ何も見えない。
  **初回の dev ログインで、移行手順（§4）と同じ付け替えを `provider = 'credential'` で行う**
  （`"1"` にまだ credential の account が無いときだけ）。E2E が所有者として動き、
  **移行手順のコードが dev のたびに通る**（本番で一度しか流さない手順を、一度きりにしない）
- 付け替え後は、**`"1"` の現在のメール**と固定のパスワードで `signInEmail` する（`"1"` に credential の account が
  あれば作成を試みない）。固定の dev メールで引くと、§6.3 の練習で `"1"` のメールが Google のものに
  書き換わった後に**別の dev ユーザーが作られ、所有者でなくなる**

#### 複数ユーザー（`?as=<名前>`）

- `/api/dev/login` の**既定は所有者**（`"1"`・上記）。`?as=<名前>`（例 `alice` / `bob`）を付けると、
  **所有者ではない別の dev ユーザー**として入れる（初回に作成。メールは名前から作る固定値。付け替えはしない）
- 理由: 一般公開の本題である**所有者スコープ（[14](./14-multi-user.md) §4）は、2 人目のユーザーがいないと確かめられない**。
  所有者ゲート（§5.1）がある間は、**他ユーザーが 403 になること自体**をこの経路で確かめられる
- 新規登録を閉じる仕組み（§5.2）とは矛盾しない——**development では作成を常に許す**（§5.2）ので、
  `?as=` のユーザーも作れる。development 以外では `/api/dev/login` 自体が無い

#### 抜け道が本番に出ないことをテストで固定する

🔒 **unit テストで確かめる**: `NODE_ENV` が development 以外（**production・未設定・test**）のとき、

実装は `packages/server/src/auth-routes.test.ts`（アプリ全体を env を変えて読み直す）と `auth-config.test.ts`:

- `/api/dev/login` が **404**（ルート自体が登録されていない）
- email+password のエンドポイント（`/api/auth/sign-up/email`・`/api/auth/sign-in/email`）が**使えない**
- `BETTER_AUTH_SECRET` などが無ければ**起動が失敗する**（固定値へのフォールバックが無い）

🔒 **本番イメージ（`Dockerfile.prod`）は最終ステージで `ENV NODE_ENV=production` を明示する。** 未設定でも抜け道は
閉じる（fail-closed）が、付け忘れに頼らない。`esbuild.config.ts`（ビルド時）と `src/dockerfile-check.test.ts`（テスト）が
COPY の照合と同じ形で確かめる。

### 6.2 dev の Google ログイン

`BETTER_AUTH_URL` を**ブラウザから見えるオリジン**（dev は Vite の origin。`/api` は Vite の proxy が server へ渡す）にし、
そのオリジンの `/api/auth/callback/google` を OAuth クライアントに登録する。`GOOGLE_CLIENT_ID` / `SECRET` が
無い dev では Google を登録しない（dev ログインだけで動く）。

### 6.3 移行手順の練習

dev ログインで付け替え済みの `"1"` に、**Google で初めてログインすると X が作られる**（`"1"` には google の
account が無いので）。これで §4 の手順を `@provider = 'google'` のまま dev DB で練習できる（`"1"` には credential と google の
account が並び、どちらでも入れる）。Google のクライアントが無いときは、DB を作り直した直後に
dev ユーザーで `signUpEmail` だけ行い、`@provider = 'credential'` で練習する（dev ログインの自動の付け替えが行う処理を手で踏む）。

### 6.4 開発環境での確認の仕方

| 確かめたいこと | 手段 |
|---|---|
| 画面・API・所有者スコープ（他ユーザーが 403 / 404 になること） | dev ログイン（複数ユーザー。§6.1）。Playwright の E2E もこれで回す |
| 抜け道が本番に出ないこと | unit テスト（§6.1）+ `Dockerfile.prod` の `NODE_ENV=production` |
| 本物の Google の流れ（リダイレクト・PKCE・コールバック・cookie） | dev で実アカウント（localhost・リモート dev をリダイレクト先に登録。§6.2）。**認証を変えたときと本番反映前に手で 1 周** |
| 既存アカウントの移行（§4） | dev の実アカウントで練習してから本番（§6.3） |

- 偽の OAuth サーバー（mock-oauth2-server 等）は**今は入れない**。Google 側の設定ミス（リダイレクト先の登録漏れ等）は
  検出できず、手間の割に得るものが小さい

## 7. 退会（後の段階）

[14](./14-multi-user.md) §3.1 のとおり**猶予期間の後に削除**する。今回は設計だけで、実装は後の段階。

- 🔒 **Better Auth の `deleteUser` は使わない**（即時削除で、猶予を置けない）。既定で無効のままにし、
  有効にする場合も `user.deleteUser.beforeDelete` で**必ず止める**
- 退会は自前の API で `users.deletionRequestedAt` を立て、**その人のセッションをすべて消す**
- 猶予期間中にログインしたら `deletionRequestedAt` を戻す（`databaseHooks.session.create` で見る）
- 期限を過ぎた行は**バッチが明示的に消す**（棋譜ほか → `users`。session / account は CASCADE）。
  🔒 **`kifus.ownerId` の FK は CASCADE にしない**——ユーザー行を 1 度誤って消しただけで全データが道連れになる

## 8. 移行前（ID/パスワード）と撤去

**撤去済み。** 以下は経緯として残す。移行前は**単一アカウント**: `/login` のフォーム → `POST /api/auth/login` → HMAC 署名 + 発行時刻の stateless cookie
（`seseraki_session`・30 日固定）。認証情報は環境変数 `AUTH_USERNAME` / `AUTH_PASSWORD`、署名鍵は `SESSION_SECRET`。
cookie は `Path=/` 固定（web は origin 直下、API は origin 直下の `/api` という配信契約。サブパス配信は未対応）。

- 🔒 **Google ログインへの切り替えと同時に削除する**（コード・環境変数・`/api/auth/login`・`/api/auth/me`・
  `/api/auth/logout`・ログインフォーム）。併存させない——**パスワードの経路が 1 本でも残ると「パスワードを持たない」が
  成り立たない**。利用者が所有者 1 人のうちに切り替えるので、失敗しても DB を直接触って戻せる（§4）
- 撤去した環境変数: `AUTH_USERNAME` / `AUTH_PASSWORD` / `SESSION_SECRET` / `COOKIE_SECURE` / `COOKIE_PATH`
  （remote dev の `COOKIE_SECURE` は `BETTER_AUTH_URL` に置き換えた。https なら `Secure` が付く）
- 古い `seseraki_session` cookie は読まれなくなるだけで、期限で消える

### 環境変数（切り替え後）

| 変数 | 必須 | 内容 |
|---|---|---|
| `BETTER_AUTH_SECRET` | development 以外は必須（無ければ起動失敗） | セッション等の署名鍵 |
| `BETTER_AUTH_URL` | development 以外は必須 | ブラウザから見えるオリジン（`/api` は付けない。Better Auth が `/api/auth` を足す） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | development 以外は必須 | Google の OAuth クライアント |
| `NODE_ENV` | — | `development` のときだけ dev の抜け道を開く（§6） |
| `AUTH_ALLOW_SIGNUP` | 移行（§4）の間だけ `true` | 新規 user の作成を許す（§5.2）。development では不要（常に許す） |
| `API_KEY` | 必須（変更なし） | worker・動画解析の取り込み |

値・ドメイン・OAuth クライアントの具体は**公開リポに置かない**（§10）。

## 9. 実装で確かめたこと

- **セッションの期間**: 30 日・`updateAge` 1 日の仮置きのまま実装した（cookie の `Max-Age` も 30 日）。運用して見直す
- **`Path=/api` の cookie**: Better Auth のすべての cookie（`session_token`・OAuth の state・`dont_remember` など）は
  `advanced.defaultCookieAttributes` を通って作られ、**削除（`Max-Age=0`）も作成時と同じ属性で出す**。
  サインアップ・サインアウト・Google のサインイン開始の `Set-Cookie` がすべて `Path=/api` で、サインアウトでセッションの行が
  消えることをメモリのアダプタで確かめた（`src/auth-flow.test.ts`）。⚠ ブラウザと本物の Google を通した 1 周は dev で手で確かめる（§6.4）
- **`drizzleAdapter` と drizzle 1.0**: アダプタは `db.query` を**結合（experimental joins）を有効にしたときだけ**使い、
  既定では素のクエリビルダ（`select` / `insert` …）で動く。relations v2 の `db` を渡して型も通る。
  ⚠ DB を通した実動作は dev での確認に委ねた（unit テストはメモリのアダプタ）
- **ID の生成**: `generateId: 'uuid'` は MySQL ではアダプタが JS 側で `crypto.randomUUID()` を振る（DB の `uuid()` には頼らない）
- **Google のメール**は Better Auth が小文字にしてから保存する。付け替えの `--email` も小文字にして比べる
- **`input: false` の追加列**: `required: true` にすると Better Auth が作成時に「値が無い」と弾く（フックより前に検査する）。
  そのため `displayName` は Better Auth の上では `required: false` にし、DB の NOT NULL とフックで必ず埋める
- **新規登録の拒否**はフックで `APIError('FORBIDDEN', 'signup disabled')` を投げる。email の登録は 403、
  Google は `errorCallbackURL` へ `?error=signup_disabled` で戻る

## 10. プライバシーと公開配置の前提

- 所有者スコープが入るまでは**所有者の private データのみ**（§5.1）。一般公開の方針は [14](./14-multi-user.md)
- 公開配置の前提: HTTPS / シークレット管理（`.env*` はコミットしない）/ 同一オリジン配信（`/api` を
  書き換えず server へ転送）。同一オリジンのため CORS は原則不要
- Google から受け取るのは `sub`・メール・名前・画像だけ（既定のスコープ）。**`sub` 以外は同定に使わない**
- **本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ・シークレット・OAuth クライアント）は公開リポに含めない。**
  PRD は姿勢のみ記述し、具体はローカルの `.claude-personal/` に置く（[02](./02-architecture.md) §5 / [README](./README.md)）
