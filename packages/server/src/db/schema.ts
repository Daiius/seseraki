import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  snakeCase,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { defineRelations, sql, type SQL } from 'drizzle-orm';
import type { AnalysisDetail, AnalysisRun } from '../kifu-analysis-detail.js';

// --- 命名（prd/15 §3.6）---

/**
 * 表を定義する関数。**DB の列名を snake_case にする**（TS のプロパティ名は camelCase のまま）。
 * 例: `playedAt` → `played_at`。表名は第 1 引数をそのまま使う（すでに snake_case）。
 *
 * 🔒 **表は必ずこれで定義する**（`pgTable` を使わない）。drizzle 1.0 の casing は**表の定義に付く**
 * （`drizzle()` の設定ではない）ので、ここ 1 か所で server・migrate・テスト・drizzle-kit がそろう。
 * `pgTable` で足すと**その表だけ列が camelCase で作られ**、psql で毎回ダブルクォートが要る。
 * ⚠ 列の `.name` は DB 上の名前（snake_case）を返す。TS のプロパティ名が要るときは
 * `getTableColumns` のキーを使う（データ移行の `plan.ts`）。
 */
const table = snakeCase.table;

// --- 列の型の補助（prd/15 §3）---

/**
 * 日時の列。**`timestamptz`**（prd/15 §3）。`Date` で往復し、接続の時刻帯に依存しない
 * （MySQL の頃の「DB の壁時計 ＝ UTC」という前提と自前の typeCast は要らなくなった）。
 */
const timestamptz = () => timestamp({ withTimezone: true });

/**
 * 自動採番の主キー。`bigint` の **identity 列**（`generated always as identity`）。
 * ⚠ `generated always` なので**アプリから ID を指定して挿入できない**（データ移行だけが
 * `OVERRIDING SYSTEM VALUE` を使う。prd/15 §6.3）。
 */
const identityId = () => bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/** identity 列を指す側（FK）の型 */
const idRef = () => bigint({ mode: 'number' });

/**
 * Better Auth の表の ID。**DB の既定値で UUID を振る**（prd/15 §3.3）。
 *
 * 🔴 **pg 方言の Better Auth は `generateId: 'uuid'` の ID を JS 側で振らず、DB に任せる**
 * （試作で確認）。既定値が無いと **user の作成が NOT NULL 違反で落ちる**。
 * 型は `varchar(36)` のまま——既存の所有者の ID は `"1"` で、uuid 型には入らない。
 */
const authId = () =>
  varchar({ length: 36 })
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

/** SQL の文字列リテラル（DDL に値を埋め込むため。値はコード中の定数だけ） */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** `column in (…values)` の CHECK */
function inCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(values.map(literal).join(', '))})`);
}

/**
 * 値の集合が決まった文字列の列（MySQL の `enum` の置き換え。prd/15 §3.1）。
 * **値の一覧から列の型と CHECK を両方作る**——一覧を 1 か所に保つため。
 *
 * ⚠ **Drizzle の `text({ enum })` は TypeScript の型を付けるだけで CHECK を作らない**（試作で確認）。
 * だから**列を使う表では必ず `.check(…)` を table extras に置く**。
 * 🔒 `pgEnum` にはしない（値の削除・並べ替えができず、追加にもトランザクションの制約がある。
 * CHECK の差し替えならトランザクションで流せる）。
 */
function textEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return {
    values,
    column: () => text({ enum: values }),
    check: (name: string, column: AnyPgColumn) => inCheck(name, column, values),
  };
}

const ANALYSIS_PROFILE = textEnum(['quick', 'full']);
const KIFU_SOURCE = textEnum(['manual', 'swars', 'video']);
const SIDE = textEnum(['sente', 'gote']);
const TACTIC_SIDE = textEnum(['sente', 'gote', 'both']);
const SIDE_TO_MOVE = textEnum(['b', 'w']);
const DRILL_KIND = textEnum(['mate', 'best']);
const DRILL_REASON = textEnum(['missed_mate', 'own_blunder']);
const VERDICT = textEnum(['correct', 'close', 'wrong']);
/** 評価値の種類（`kifuAnalyses.detail` の候補手 / `drills.answerScoreType`）。列は varchar のまま */
const SCORE_TYPES = ['cp', 'mate'] as const;
/** 盤面の時刻帯（`kifus.sourceTz`。`localDay` が前提にしている） */
const SOURCE_TZS = ['JST', 'UTC'] as const;

/** JSON の値が配列であること（`string[]` などの型を DB の側でも守る。null は通す） */
function jsonArrayCheck(name: string, column: AnyPgColumn) {
  return check(name, sql`jsonb_typeof(${column}) = 'array'`);
}

/**
 * バイト列を **Buffer のまま**扱う `bytea`（prd/15 §3。node-postgres は `Buffer` で往復する）。
 * 固定長だった性質（MySQL の `binary(N)`）は **`octet_length(…) = N` の CHECK**
 * （`byteLengthCheck`）で保つ——列を使う表の table extras に置く。
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
function byteLengthCheck(name: string, column: AnyPgColumn, length: number) {
  return check(name, sql`octet_length(${column}) = ${sql.raw(String(length))}`);
}

/** 条件 a と b が同値（両方真か両方偽）であること */
const sameTruth = (a: SQL, b: SQL) => sql`(${a}) = (${b})`;

// --- 所有者（prd/14 §4・§4.1）---

/**
 * 子の表の所有者の列。**親（`kifus` / `drills`）の `ownerId` の写し**で、食い違わないことは
 * 複合 FK（`ownedBy`）で DB が保証する。RLS のポリシーを全表で `owner_id = …` の一様な形に
 * するために持つ（prd/14 §4・prd/15 §11）。
 *
 * 🔒 **書き込み側が必ず親と同じ値を入れる**（既定値は持たせない）。違う値は FK 違反で落ちる。
 */
const ownerRef = () => varchar({ length: 36 }).notNull();

/**
 * 子の表から親への**複合 FK** `(子の参照列, ownerId) → 親(id, ownerId)`（prd/14 §4.1）。
 * 親側に `UNIQUE(id, ownerId)` が要る（`kifus_id_owner_id_uq` / `drills_id_owner_id_uq`）。
 *
 * - **ON DELETE CASCADE**: 単独の FK だった頃の振る舞いをそのまま引き継ぐ（棋譜を消せば子も消える）。
 *   ⚠ 単独の FK は残さない——`ownerId` は NOT NULL なので、複合 FK が親の存在も確かめる
 * - **ON UPDATE CASCADE**: 親の `ownerId` を変えたら子も追随させる。`ownerId` は親の写しにすぎず、
 *   正は親の側にある。CASCADE にしないと**所有者を付け替える手段が無くなる**（親を先に変えれば子が、
 *   子を先に変えれば親が FK に反する）。付け替えを 1 文で原子的に行えるようにしておく
 */
function ownedBy(
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  foreignColumns: [AnyPgColumn, AnyPgColumn],
) {
  return foreignKey({ name, columns, foreignColumns }).onDelete('cascade').onUpdate('cascade');
}

/**
 * 所有者の行だけを見せる・書かせる RLS のポリシー（prd/14 §4「RLS の形」・prd/15 §11）。
 * `kifus` と子の表 6 つは `owner_id`、名前候補は `user_id` に付ける。**全表で一様な形**にする。
 *
 * - `app.user_id` はログインしたリクエストの tx が `set_config(…, true)` で入れる（`user-tx.ts`）
 * - 🔒 **未設定なら常に 0 件（fail-closed）**。`current_setting(…, true)` は未設定で NULL、一度設定した
 *   接続では tx の後に空文字に戻る。どちらも `owner_id` と一致しない
 * - **USING と WITH CHECK の両方**: 他人の行は読めず・更新も削除もできず、他人の `owner_id` で
 *   挿入・更新もできない
 * - 全員ぶんを扱う経路（worker・一括処理）は BYPASSRLS のロール（`DB_SYSTEM_USER`）で繋ぐので、ここを素通りする
 * - ⚠ **`FORCE ROW LEVEL SECURITY` は付けない。** 表の所有者（管理ロール。`migrate.js`）にまで効くと、
 *   マイグレーションの埋め戻し（`UPDATE … FROM kifus`）が `app.user_id` 未設定で**黙って 0 行**になる
 *   （エラーにならない）。管理ロールは DDL 専用で、アプリは表の所有者で繋がない（prd/15 §2）
 *
 * 🔴 **`kifus` 配下・所有者を持つ表を足したら、ここを付ける。** test:db がカタログで照合する
 * （`rls.db.test.ts`）。drizzle-kit はポリシーがある表に `ENABLE ROW LEVEL SECURITY` も生成する。
 */
function ownerPolicy(column: AnyPgColumn) {
  const owned = sql`${column} = current_setting('app.user_id', true)`;
  return pgPolicy('owner_scope', {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: owned,
    withCheck: owned,
  });
}

/**
 * ユーザー。**Better Auth の user 表を兼ねる**（prd/07 §3.1。`user.modelName: 'users'`）。
 *
 * 🔒 **既存の所有者の行は ID `"1"`**（bigint から varchar(36) へ作り替えたときの値そのまま）。
 * 新規は UUID。所有者スコープ（prd/14 §4）が入るまでは `"1"` 以外のセッションを通さない
 * （所有者ゲート。prd/07 §5.1）。
 *
 * 🔒 **本人の同定は `account.accountId`（Google の `sub`）で行う。** `email` は同定に使わない
 * （メールは変わりうる。prd/07 §1）。
 */
export const users = table('users', {
  id: authId(),
  /** Google の表示名（Better Auth が書く）。画面には出さない——出すのは `displayName` */
  name: varchar({ length: 255 }).notNull(),
  /**
   * Google のメール。UNIQUE だが**同定には使わない**。
   * ⚠ 所有者の行は移行（prd/07 §4）まで予約ドメインの仮アドレス。**本物を先に入れない**——
   * Better Auth がメールで行を見つけると、連携が無効なので初回ログインを拒否する
   */
  email: varchar({ length: 255 }).notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  /**
   * 画面に出す名前。**対局者名とも Google の `name` とも別**（対局者名は `userAliases`）。
   * 作成時に `databaseHooks.user.create.before` が `name` から補う（prd/07 §3.1）。以後は触らない
   */
  displayName: varchar({ length: 100 }).notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  /** 更新は DB のトリガー（`set_updated_at`）が書く（prd/15 §3.4）。以下の表も同じ */
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  // `initialDisplayName` は空なら `(未設定)` を入れる
  check('users_display_name_not_empty', sql`${table.displayName} <> ''`),
]);

/**
 * Better Auth のセッション（prd/07 §3）。**行を消せばその場で失効する**。
 *
 * `userId` の FK は `ON DELETE CASCADE`。
 */
export const session = table(
  'session',
  {
    id: authId(),
    token: varchar({ length: 255 }).notNull(),
    userId: varchar({ length: 36 }).notNull(),
    expiresAt: timestamptz().notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('session_token_uq').on(table.token),
    index('session_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.userId], foreignColumns: [users.id] }).onDelete('cascade'),
  ],
);

/**
 * Better Auth のアカウント（ログイン手段）。`(providerId, accountId)` で本人を同定する。
 * `providerId` は `'google'`（dev では `'credential'` もある。`password` はその時だけ入る）。
 * `userId` の FK は `ON DELETE CASCADE`。
 */
export const account = table(
  'account',
  {
    id: authId(),
    userId: varchar({ length: 36 }).notNull(),
    providerId: varchar({ length: 64 }).notNull(),
    /** Google の `sub`。**本人の同定はこれで行う** */
    accountId: varchar({ length: 255 }).notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_provider_account_uq').on(table.providerId, table.accountId),
    index('account_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.userId], foreignColumns: [users.id] }).onDelete('cascade'),
  ],
);

/** Better Auth の短命の値（OAuth の state など） */
export const verification = table(
  'verification',
  {
    id: authId(),
    identifier: varchar({ length: 255 }).notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/**
 * 対局者名と突き合わせる名前候補（prd/11 §2）。
 *
 * 🔒 **UNIQUE は `(userId, name)`**（prd/14 §4.1）。主体側の判定は**所有者の名前候補と所有者の棋譜だけ**で
 * 完結する（`refreshSubjectSide`）ので、別のユーザーが同じ名前を持っても互いの成績には混ざらない。
 * 全体の UNIQUE（`name` 単独。当初の形）は**他人による名前の先取り**を生むだけだった。
 *
 * ⚠ **旧名を消してはいけない**（prd/11 §2.2）。消すと、その名前で指した過去の棋譜が
 * 「自分の対局」でなくなり、成績から静かに落ちる。名前を変えたときは**足す**。
 */
export const userAliases = table(
  'user_aliases',
  {
    id: identityId(),
    userId: varchar({ length: 36 }).notNull(),
    /**
     * 棋譜の `sente` / `gote` と突き合わせる値。swars の ID もここに入る。
     *
     * 大文字小文字を区別する（Postgres の既定。`daiius` と `Daiius` は別の値）。
     * 判定する JS 側（`subjectSideFromNames`）も `Set` で区別するので食い違わない。
     */
    name: varchar({ length: 100 }).notNull(),
    /**
     * 有効期間（prd/11 §5）。**既定は無期限**（両方 null）で、
     * 旧名を他人が使い始めるなどの**衝突に気づいたときだけ埋める**。
     * ⚠ `playedAt` が NULL の棋譜では期間を見ない（prd/11 §5.3）
     */
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    uniqueIndex('user_aliases_user_id_name_uq').on(table.userId, table.name),
    check('user_aliases_name_not_empty', sql`${table.name} <> ''`),
    check(
      'user_aliases_valid_range',
      sql`${table.validFrom} is null or ${table.validTo} is null or ${table.validFrom} <= ${table.validTo}`,
    ),
  ],
);

export const kifus = table(
  'kifus',
  {
    id: identityId(),
    title: varchar({ length: 255 }).notNull(),
    kifText: text().notNull(),
    usiMoves: jsonb().$type<string[]>(),
    sente: varchar({ length: 100 }),
    gote: varchar({ length: 100 }),
    senteDan: smallint(),
    goteDan: smallint(),
    result: varchar({ length: 50 }),
    swarsGameKey: varchar({ length: 255 }).unique(),
    playedAt: timestamptz(),
    // playedAt の解釈に用いたタイムゾーン。手動貼り付け KIF は開始日時に
    // タイムゾーン欄が無いため、投入時に決めた TZ（"JST" 既定 / "UTC" は投入時指定）を残す。
    // swars 経路は gameKey 由来で常に "JST"。
    sourceTz: varchar({ length: 8 }),
    analysisCompletedAt: timestamptz(),
    /**
     * **完了した段階のうち最も高いもの**（prd/03 §2 / prd/05 §1.1d）。
     * quick だけ終わっている棋譜を一覧・詳細で見分けるために持つ。`reanalyze` で null に戻る。
     *
     * ⚠ **full 完了時刻の列は持たない**（実装判断）。`analysisCompletedAt` は
     * 「初めて全局面が揃った時刻」で、full の完了は**この列で判別できる**。
     * 表示・クエリのどこも full の時刻を要求していないので、要らない列を先に足さない
     * （進捗を DB に持たなかったのと同じ立場。prd/05 §1.1b）。
     */
    analysisProfile: ANALYSIS_PROFILE.column(),
    analysisError: text(),
    // 解析世代。reanalyze で +1 し、worker の submit/error 報告は取得時と同一世代のみ受理
    // （実行中の旧解析がリセット後の状態を上書きするのを防ぐ）
    analysisRevision: integer().notNull().default(0),
    memo: text(),
    // 棋譜の出所（prd/10 §2.1）。動画解析（'video'）は自分の対局ではないため、
    // 🔒 一覧・分析・統計のクエリは `source <> 'video'` を**既定で強制する**
    // （引数で外せる条件にしない。prd/10 §2.2）。既定値は安全側の 'manual'。
    source: KIFU_SOURCE.column().notNull().default('manual'),
    /**
     * **このデータを持っている人**（prd/11 §3）。⚠ 対局者ではない——動画解析の棋譜も
     * 投入した人が所有者で、対局者は `sente` / `gote` の話。
     */
    ownerId: varchar({ length: 36 }).notNull(),
    /**
     * 主体の手番（prd/11 §4）。**導出値**で、`source = 'video'` は `bottomIsSente` から、
     * それ以外は所有者の名前候補との突き合わせで決まる。両対局者とも一致したら null。
     */
    subjectSide: SIDE.column(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    index('kifus_analysis_completed_at_idx').on(table.analysisCompletedAt),
    // 動画解析の一覧は source で絞ってから並べる（prd/10 §6.1）
    index('kifus_source_idx').on(table.source),
    // 🔒 ユーザーを消しても棋譜は道連れにしない（CASCADE にしない。prd/14 §3.1）。
    // ユーザー行を 1 度誤って消しただけで全データが道連れになるため。削除は退会のバッチが明示的に行う
    foreignKey({ columns: [table.ownerId], foreignColumns: [users.id] }),
    // 子の表の複合 FK（`ownedBy`）の参照先。`id` だけで一意だが、FK は参照先に UNIQUE を要る
    uniqueIndex('kifus_id_owner_id_uq').on(table.id, table.ownerId),
    ANALYSIS_PROFILE.check('kifus_analysis_profile_check', table.analysisProfile),
    KIFU_SOURCE.check('kifus_source_check', table.source),
    SIDE.check('kifus_subject_side_check', table.subjectSide),
    jsonArrayCheck('kifus_usi_moves_array', table.usiMoves),
    inCheck('kifus_source_tz_check', table.sourceTz, SOURCE_TZS),
    check('kifus_analysis_revision_nonneg', sql`${table.analysisRevision} >= 0`),
  ],
);

/**
 * 動画解析の由来メタ（`kifus` と 1:1。prd/10 §3.1）。
 *
 * **`kifus` に列を足さず外出しする**のは、自分の対局行で常に NULL になる列を
 * 中心テーブルに持ち込まないため。
 *
 * ⭐ **`raw` に走査の生出力を丸ごと持つ**（1 局 8〜16KB）。後から仕様を変えても
 * 再走査せずに派生値を作り直せる。手ごとのメタ（time / side / inferredKind）はここに入る。
 * 🔒 索引が要ると分かった値だけ、後から `raw` の外に列として昇格させる。
 */
export const videoKifuSources = table(
  'video_kifu_sources',
  {
    // ⚠ FK は下の table extras で `foreignKey()` として書く。列側の `.references()` は
    // **単一列 PK のテーブルでは生成 SQL から `ON DELETE CASCADE` が落ちる**
    // （複合 PK の kifuTactics では落ちない）。CASCADE が無いと棋譜を消せなくなる
    kifuId: idRef().notNull(),
    /** 棋譜（`kifus.ownerId`）の写し（`ownerRef`） */
    ownerId: ownerRef(),
    /** 動画の識別子 */
    videoId: varchar({ length: 32 }).notNull(),
    /** その動画の何局目か（1 始まり） */
    gameIndex: integer().notNull(),
    /** 断片の開始秒 / 終了秒 */
    startedAtSec: integer().notNull(),
    endedAtSec: integer().notNull(),
    /** 画面の下が先手か（録画者の側を示す。主体側の導出に使う。prd/10 §3.3） */
    bottomIsSente: boolean().notNull(),
    /** 走査時のコミット。上書きの経緯を辿るために残す */
    extractorRev: varchar({ length: 40 }).notNull(),
    /** 走査の生出力（range / replay / moves[{time,usi,side,inferredKind}]） */
    raw: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    primaryKey({ columns: [table.kifuId] }),
    ownedBy('video_kifu_sources_kifu_owner_fkey', [table.kifuId, table.ownerId], [kifus.id, kifus.ownerId]),
    // 「同じ動画の同じ局」は 1 つの実体。再取り込みはこのキーで上書きする（prd/10 §4.3）
    uniqueIndex('video_kifu_sources_video_id_game_index_uq').on(
      table.videoId,
      table.gameIndex,
    ),
    check('video_kifu_sources_game_index_nonneg', sql`${table.gameIndex} >= 0`),
    check(
      'video_kifu_sources_range',
      sql`0 <= ${table.startedAtSec} and ${table.startedAtSec} <= ${table.endedAtSec}`,
    ),
  ],
);

/**
 * 解析結果（prd/16）。**1 棋譜の 1 回の解析を 1 行**に詰める。
 *
 * 🔒 **検索・集計に使う値は列に出し、表示にしか使わない値は `detail` に詰める**（prd/16 §1）。
 * `detail` / `runs` の形は `kifu-analysis-detail.ts` だけが知っている。
 * 🔴 **`detail` を書き換えたら `minMate*` を同じトランザクションで計算し直す**（prd/16 §3.2）。
 */
export const kifuAnalyses = table(
  'kifu_analyses',
  {
    kifuId: idRef().primaryKey(),
    /** 棋譜（`kifus.ownerId`）の写し（`ownerRef`） */
    ownerId: ownerRef(),
    /**
     * 先頭から何局面までが full か（prd/16 §4.2）。full は 0 から順に上書きするので常に連続区間。
     * 🔒 **既定値は持たせない**（アプリが常に明示して書く）
     */
    fullCount: integer().notNull(),
    /** submit 1 回ごとの来歴と時刻（prd/16 §3.1）。`detail` の各局面が添字で指す */
    runs: jsonb().$type<AnalysisRun[]>().notNull(),
    /** 先手番の局面で、最善が「自分が N 手で詰ませる」だった最小の N（prd/16 §3.2） */
    minMateSente: integer(),
    /** 後手番の局面で同上 */
    minMateGote: integer(),
    /**
     * 局面ごとの `[run, 候補手]`（prd/16 §3.1）。添字が `moveNumber`。
     * 列の圧縮は lz4（マイグレーションで手で指定。drizzle は圧縮を扱わない）
     */
    detail: jsonb().$type<AnalysisDetail>().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    ownedBy('kifu_analyses_kifu_owner_fkey', [table.kifuId, table.ownerId], [kifus.id, kifus.ownerId]),
    jsonArrayCheck('kifu_analyses_detail_array', table.detail),
    jsonArrayCheck('kifu_analyses_runs_array', table.runs),
    check(
      'kifu_analyses_full_count_range',
      sql`${table.fullCount} >= 0 and ${table.fullCount} <= jsonb_array_length(${table.detail})`,
    ),
    check('kifu_analyses_min_mate_sente_positive', sql`${table.minMateSente} >= 1`),
    check('kifu_analyses_min_mate_gote_positive', sql`${table.minMateGote} >= 1`),
  ],
);

// MultiPV の各候補手
/**
 * 戦型ラベル（prd/03 §2.1）。`usiMoves` から導く**派生値**で、正は指し手列。
 * この表は絞り込みと集計を SQL で行うための索引にすぎない。
 */
export const kifuTactics = table(
  'kifu_tactics',
  {
    kifuId: idRef().notNull(),
    /** 棋譜（`kifus.ownerId`）の写し（`ownerRef`） */
    ownerId: ownerRef(),
    /** ラベルの**帰属先**。「立った手番」ではない（prd/03 §2.1.1） */
    side: TACTIC_SIDE.column().notNull(),
    /** 一次 / 二次ラベル名。**表示名そのもの**（enum やコード値にしない） */
    label: varchar({ length: 32 }).notNull(),
    /** 成立手数。表示の抑制に使う。**絞り込み条件には使わない**（prd/03 §2.1.2） */
    turn: integer().notNull(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    primaryKey({ columns: [table.kifuId, table.side, table.label] }),
    ownedBy('kifu_tactics_kifu_owner_fkey', [table.kifuId, table.ownerId], [kifus.id, kifus.ownerId]),
    index('kifu_tactics_label_idx').on(table.label),
    TACTIC_SIDE.check('kifu_tactics_side_check', table.side),
  ],
);

/**
 * 局面索引（`kifus` に紐付く派生値。prd/10 §3.2）。
 *
 * **全棋譜（自分の対局を含む）の全局面**を展開する。正は `kifus.usiMoves` で、
 * この表は**手順前後を吸収して盤の配置で探す**ための索引にすぎない（`kifuTactics` と同じ立場）。
 *
 * 🔒 **`usiMoves` が変われば必ず作り直す**（同一トランザクション）。全件の作り直しは
 * `rebuild-positions.ts`。
 */
export const kifuPositions = table(
  'kifu_positions',
  {
    kifuId: idRef().notNull(),
    /**
     * 棋譜（`kifus.ownerId`）の写し（`ownerRef`）。**索引の先頭列**でもある——検索を所有者で絞るとき、
     * join 後に絞るのでは初期局面で全ユーザーぶんを読んでから捨てることになる（prd/14 §4.1・§6.3）
     */
    ownerId: ownerRef(),
    /** 0 = 初期局面。N は N 手適用後の局面 */
    moveNumber: integer().notNull(),
    /**
     * この局面に**至った直前の手**（USI）。`moveNumber = 0` では null。
     * ⭐ 枝の集計に要る——局面キーだけでは「同じ局面から指された別の手」を区別できない
     * （`moveNumber` は必ず +1 になるので集計単位にならない。prd/10 §5.3）
     */
    move: varchar({ length: 8 }),
    /**
     * 局面キー（SFEN の 盤 / 手番 / 持ち駒）の **64 ビットハッシュ**（`shared` の `positionHash`）。
     * **手数は含めない**ので手順前後が合流する。
     *
     * 🔒 **文字列は保存せず、ハッシュで引いてから `board` / `hands` / `sideToMove` で照合する**
     * （prd/14 §6.3・prd/10 §5.1）。照合があるので衝突しても無関係な棋譜は混ざらない。
     * 文字列が要るときは盤・持ち駒・手番から組み立てる（`stateFromBytes` → `positionSfen`）。
     * ⚠ ハッシュ関数を変えたら全件の作り直し（`rebuild-positions.ts`）が要る
     */
    sfenHash: bytea().notNull(),
    /**
     * 先手側だけの配置（盤 + 先手の持ち駒）のハッシュ。入力は**小文字にした** `sideSfen`
     * （`sideLayoutKey`）——先後をまたいで一致させるため（文字列の頃は照合順序が担っていた）。
     * 照合は盤・持ち駒から片側の配置を組み立て直して行う（`/positions/subject`）
     */
    senteSfenHash: bytea().notNull(),
    /** 後手側だけの配置（盤を 180 度回して書いたもの。`sideLayoutKey(state, 'gote')`）のハッシュ */
    goteSfenHash: bytea().notNull(),
    /** 盤 81 マス（1 マス 1 バイト）。距離の計算に読む（prd/10 §5.2） */
    board: bytea().notNull(),
    /** 持ち駒（先手 7 種 → 後手 7 種の枚数） */
    hands: bytea().notNull(),
    sideToMove: SIDE_TO_MOVE.column().notNull(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    primaryKey({ columns: [table.kifuId, table.moveNumber] }),
    ownedBy('kifu_positions_kifu_owner_fkey', [table.kifuId, table.ownerId], [kifus.id, kifus.ownerId]),
    // 🔒 **検索の索引は所有者を先頭に置く**（prd/14 §4.1・§6.3）。検索は「所有者の棋譜の中で」
    // ハッシュ・手数で引く。所有者で絞らない問い合わせ（所有者スコープの前の今の形）も
    // Postgres 18 の B-tree の skip scan で同じ索引を使える（所有者の種類が少ない間は安い）
    index('kifu_positions_owner_id_sfen_hash_idx').on(table.ownerId, table.sfenHash),
    index('kifu_positions_owner_id_sente_sfen_hash_idx').on(table.ownerId, table.senteSfenHash),
    index('kifu_positions_owner_id_gote_sfen_hash_idx').on(table.ownerId, table.goteSfenHash),
    // 近い局面の検索は `moveNumber` の範囲で候補を粗く絞る（prd/10 §5.2）。
    // ⚠ **PK は `(kifuId, moveNumber)` なので、この範囲条件には使えない**
    //（先頭列が kifuId のため）。索引が無いと全局面を走査することになる
    index('kifu_positions_owner_id_move_number_idx').on(table.ownerId, table.moveNumber),
    SIDE_TO_MOVE.check('kifu_positions_side_to_move_check', table.sideToMove),
    byteLengthCheck('kifu_positions_sfen_hash_len', table.sfenHash, 8),
    byteLengthCheck('kifu_positions_sente_sfen_hash_len', table.senteSfenHash, 8),
    byteLengthCheck('kifu_positions_gote_sfen_hash_len', table.goteSfenHash, 8),
    byteLengthCheck('kifu_positions_board_len', table.board, 81),
    byteLengthCheck('kifu_positions_hands_len', table.hands, 14),
    check('kifu_positions_move_number_nonneg', sql`${table.moveNumber} >= 0`),
    // 「`moveNumber = 0` では `move` が null」（上のコメント）を両向きで守る
    check(
      'kifu_positions_initial_has_no_move',
      sameTruth(sql`${table.moveNumber} = 0`, sql`${table.move} is null`),
    ),
  ],
);

/**
 * 出題（prd/13 §6.1）。`kifuAnalyses` から導く**派生値**で、正は解析結果。
 *
 * 🔴 **正解の材料を焼き付けて持つ**（`answer*` / `candidates`）。解析が再実行されても、
 * 出題中の問題の答えが黙って変わらないため（prd/13 §6.1）。
 * 🔴 **再生成は upsert で、DELETE → INSERT にしない。** `drillAttempts` が CASCADE で
 * ぶら下がっているので、作り直すと**解答履歴が道連れで消える**。
 */
export const drills = table(
  'drills',
  {
    id: identityId(),
    kifuId: idRef().notNull(),
    /** 棋譜（`kifus.ownerId`）の写し（`ownerRef`）。解答履歴の複合 FK の参照先でもある */
    ownerId: ownerRef(),
    /** 出題局面（= その手を指す前の局面。`kifuAnalyses.detail` の添字と同じ数え方） */
    moveNumber: integer().notNull(),
    /**
     * 出題の種類（prd/13 §2）。`mate` は詰み上がりまで指し継ぎ、`best` は初手のみ。
     * 🔒 **rank1 が `mate` の局面を `best` にしない**（prd/13 §4.1）——cp 差の採点が成立しない。
     */
    kind: DRILL_KIND.column().notNull(),
    /**
     * 拾った理由（prd/13 §4.1）。出題の絞り込みと、解答後の文言に使う。
     * ⚠ **「相手の悪手を咎める」は持たない**——咎め損ねれば評価値が落ちるので
     * `own_blunder` が同じ局面を拾う（prd/13 §4.2）。
     */
    reason: DRILL_REASON.column().notNull(),
    /** 正解手（rank1）。USI */
    answerMove: varchar({ length: 16 }).notNull(),
    answerScoreType: varchar({ length: 16 }).notNull(),
    answerScoreValue: integer().notNull(),
    /** 正解手の読み筋。`mate` では**指し継ぎの正解手順**そのもの（prd/13 §5.2） */
    answerPv: jsonb().$type<string[]>(),
    /**
     * 出題時点の候補手（rank 順・pv を除く）。**採点はここを引く**ので、
     * 解析の再実行に影響されない（prd/13 §5.1）。
     */
    candidates: jsonb()
      .$type<{ rank: number; move: string; scoreType: string; scoreValue: number }[]>()
      .notNull(),
    /** エンジンの詰み距離（plies）。`kind='mate'` のときのみ。⚠ 詰将棋の「N手詰」ではない */
    matePlies: integer(),
    /** 実戦で指された手（解答後の表示に使う）。棋譜の最終手より後は null */
    playedMove: varchar({ length: 16 }),
    /** 実戦の手の損失（cp）。mate が絡む変化では null（prd/01 §5） */
    playedLossCp: integer(),
    /** 生成来歴（prd/13 §6.1）。取得時の解析世代と、生成に使った閾値 */
    analysisRevision: integer().notNull(),
    blunderCp: integer().notNull(),
    mateMaxPlies: integer().notNull(),
    /** 生成器の版。抽出規則を変えたら上げる（一括再生成の対象を絞るための印） */
    generatorRev: varchar({ length: 16 }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    uniqueIndex('drills_kifu_id_move_number_kind_uq').on(
      table.kifuId,
      table.moveNumber,
      table.kind,
    ),
    ownedBy('drills_kifu_owner_fkey', [table.kifuId, table.ownerId], [kifus.id, kifus.ownerId]),
    // 解答履歴の複合 FK（`ownedBy`）の参照先
    uniqueIndex('drills_id_owner_id_uq').on(table.id, table.ownerId),
    // 出題順（未出題 > 間違えた > 正解済み。prd/13 §6.3）は種類で絞ってから引く
    index('drills_kind_idx').on(table.kind),
    DRILL_KIND.check('drills_kind_check', table.kind),
    DRILL_REASON.check('drills_reason_check', table.reason),
    inCheck('drills_answer_score_type_check', table.answerScoreType, SCORE_TYPES),
    // `matePlies` は「`kind='mate'` のときのみ」（上のコメント）を両向きで守る
    check(
      'drills_mate_plies_iff_mate',
      sameTruth(sql`${table.kind} = 'mate'`, sql`${table.matePlies} is not null`),
    ),
    jsonArrayCheck('drills_candidates_array', table.candidates),
    jsonArrayCheck('drills_answer_pv_array', table.answerPv),
  ],
);

/**
 * 解答履歴（prd/13 §6.2）。
 *
 * 🔒 **除外フラグ（「自明だった」）もここに持つ。** 出題側に持つと再生成で消えうる（prd/13 §7）。
 */
export const drillAttempts = table(
  'drill_attempts',
  {
    id: identityId(),
    drillId: idRef().notNull(),
    /** 出題（`drills.ownerId`）の写し（`ownerRef`）。⚠ 解答した人ではなく棋譜の所有者 */
    ownerId: ownerRef(),
    /** 解答した手（USI）。除外だけを記録する行では null */
    move: varchar({ length: 16 }),
    /**
     * 解答の手順（出題局面からの全手順・受方の応手を含み、最後が `move`。prd/13 §6.2）。
     *
     * 🔴 **日本語表記を作る盤面はこれでしか決まらない**（レビュー `OCL-A1E622FE`）。詰将棋は
     * 指し継ぎ（prd/13 §5.2）なので、`move` だけでは**どの局面で指した手かが分からず**、
     * 出題局面から読むと駒名が欠ける・別の駒として表示される。
     * ⚠ **既存の行は null**（`line` を持たない行は USI のまま出す。prd/13 §5.4）。
     */
    line: jsonb().$type<string[]>(),
    verdict: VERDICT.column(),
    /**
     * 最善との差（cp）。**null 可**——mate が絡む回答は損失を持たない（prd/13 §5.1）。
     */
    lossCp: integer(),
    /** 「自明だった」（prd/13 §7）。立っている行が 1 つでもあれば以後出題しない */
    excluded: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    ownerPolicy(table.ownerId),
    ownedBy('drill_attempts_drill_owner_fkey', [table.drillId, table.ownerId], [drills.id, drills.ownerId]),
    index('drill_attempts_drill_id_idx').on(table.drillId),
    // 解答履歴の一覧は**新しい順**に 50 件ずつ引く（prd/13 §7.3）
    index('drill_attempts_created_at_idx').on(table.createdAt),
    VERDICT.check('drill_attempts_verdict_check', table.verdict),
    jsonArrayCheck('drill_attempts_line_array', table.line),
  ],
);

export const relations = defineRelations(
  {
    kifus,
    kifuAnalyses,
    kifuTactics,
    videoKifuSources,
    kifuPositions,
    users,
    session,
    account,
    verification,
    userAliases,
    drills,
    drillAttempts,
  },
  (r) => ({
    kifus: {
      analysis: r.one.kifuAnalyses({
        from: r.kifus.id,
        to: r.kifuAnalyses.kifuId,
      }),
      videoSource: r.one.videoKifuSources({
        from: r.kifus.id,
        to: r.videoKifuSources.kifuId,
      }),
    },
    videoKifuSources: {
      kifu: r.one.kifus({
        from: r.videoKifuSources.kifuId,
        to: r.kifus.id,
      }),
    },
    kifuAnalyses: {
      kifu: r.one.kifus({
        from: r.kifuAnalyses.kifuId,
        to: r.kifus.id,
      }),
    },
    drills: {
      kifu: r.one.kifus({ from: r.drills.kifuId, to: r.kifus.id }),
      attempts: r.many.drillAttempts(),
    },
    drillAttempts: {
      drill: r.one.drills({ from: r.drillAttempts.drillId, to: r.drills.id }),
    },
  }),
);
