/**
 * 実 Postgres に当てるテスト（prd/15 §8.2）。`pnpm --filter server test:db`（`TEST_DATABASE_URL` が要る）。
 *
 * 移行で確かめること: 意味の制約・enum と bytea の CHECK・`updatedAt` のトリガー・Better Auth の ID の既定値・
 * 集計の戻り値（node-postgres は bigint を文字列で返す）・`ilike`・FK の CASCADE の有無・upsert。
 * 単体テスト（SQL の文字列を見る）では分からない「DB が実際にどう振る舞うか」だけをここに置く。
 *
 * ⚠ DATABASE は実行ごとに作り直すが、**ファイル内のテストは同じ DATABASE を共有する**。
 * 各テストは自分で作った行だけを見る（件数を全体で数えない）。
 */
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_THRESHOLDS } from 'shared';
import { afterAll, describe, expect, it } from 'vitest';
import { authOptions } from './auth-config.js';
import { client, db } from './db/index.js';
import {
  account,
  drillAttempts,
  drills,
  kifuAnalyses,
  kifuPositions,
  kifuTactics,
  kifus,
  session,
  userAliases,
  users,
  verification,
  videoKifuSources,
} from './db/schema.js';
import { drillCounts, listDrills } from './drill-query.js';
import { drillListQuerySchema } from './drill-list-query.js';
import { syncDrills } from './drills.js';
import { kifuListQuerySchema, kifuListWhere } from './kifu-list-query.js';
import { isUniqueViolation } from './db/errors.js';
import { linkOwnerAccount } from './owner-account.js';
import { loadAnalysis, saveAnalysis } from './kifu-analysis-store.js';
import { encodeCandidates, mergeChunk, type CandidateMove } from './kifu-analysis-detail.js';
import { findKifuPositionMatches } from './position-kifu-reuse.js';
import { replacePositions } from './positions.js';
import { addAlias, OWNER_USER_ID } from './users.js';

afterAll(async () => {
  await client.end();
});

/** pg のエラー（drizzle は `cause` に包む） */
interface PgError {
  code?: string;
  constraint?: string;
}

/** 失敗したことと、その理由（SQLSTATE と制約名）を返す */
async function failure(p: Promise<unknown>): Promise<PgError> {
  try {
    await p;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    return cause as PgError;
  }
  throw new Error('失敗するはずの書き込みが通った');
}

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

/** 所有者の棋譜の指し方（子の表の書き込み関数が受け取る形） */
const owned = (id: number) => ({ id, ownerId: OWNER_USER_ID });

/** 1 局ぶんの最小の棋譜を足して id を返す */
async function insertKifu(values: Partial<typeof kifus.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(kifus)
    .values({ title: 't', kifText: '', ownerId: OWNER_USER_ID, ...values })
    .returning({ id: kifus.id });
  return row.id;
}

/** 新しいユーザー（Better Auth を通さない最小の行） */
async function insertUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
    .returning({ id: users.id });
  return row.id;
}

/** 解析 1 行（局面 0..n-1 をすべて full で、1 回の submit で書いたものとして入れる） */
async function insertAnalysis(kifuId: number, positions: CandidateMove[][]): Promise<void> {
  await db.transaction((tx) =>
    saveAnalysis(tx, owned(kifuId), {
      runs: [
        {
          profile: 'full',
          engineName: null,
          movetimeMs: null,
          targetDepth: null,
          multiPv: null,
          at: '2026-10-07T00:00:00.000Z',
        },
      ],
      detail: positions.map((c) => [0, encodeCandidates(c)]),
      fullCount: positions.length,
    }),
  );
}

const cand = (move: string, scoreValue: number, rank = 1, scoreType: 'cp' | 'mate' = 'cp'): CandidateMove => ({
  rank,
  move,
  scoreType,
  scoreValue,
  pv: null,
  depth: 1,
});

/** 正しい形の解析 1 行（上書きして不正な行を作る） */
function analysisRow(kifuId: number, ownerId = OWNER_USER_ID): typeof kifuAnalyses.$inferInsert {
  return { kifuId, ownerId, fullCount: 0, runs: [], detail: [] };
}

/** 正しい形の出題 1 行（上書きして不正な行を作る） */
function drillRow(kifuId: number, moveNumber = 0, ownerId = OWNER_USER_ID): typeof drills.$inferInsert {
  return {
    kifuId,
    ownerId,
    moveNumber,
    kind: 'best',
    reason: 'own_blunder',
    answerMove: '2g2f',
    answerScoreType: 'cp',
    answerScoreValue: 100,
    answerPv: null,
    candidates: [],
    matePlies: null,
    analysisRevision: 0,
    blunderCp: 600,
    mateMaxPlies: 10,
    generatorRev: 't',
  };
}

const bytes = (n: number) => Buffer.alloc(n, 1);
function positionRow(kifuId: number, moveNumber: number, move: string | null, ownerId = OWNER_USER_ID) {
  return {
    kifuId,
    ownerId,
    moveNumber,
    move,
    sfenHash: bytes(8),
    senteSfenHash: bytes(8),
    goteSfenHash: bytes(8),
    board: bytes(81),
    hands: bytes(14),
    sideToMove: 'b' as const,
  };
}

/** 型の上では書けない不正な値を、DB の制約に届かせるために通す */
const raw = <T>(v: unknown) => v as T;

describe('マイグレーション', () => {
  it('所有者の行（ID "1"）がある', async () => {
    const [owner] = await db.select().from(users).where(eq(users.id, OWNER_USER_ID));
    expect(owner).toMatchObject({ email: 'owner-1@example.invalid', displayName: '(未設定)' });
  });
});

describe('意味の制約（prd/15 §4.2）', () => {
  // [説明, 制約名, 不正な行を書く関数]
  const cases: [string, string, () => Promise<unknown>][] = [
    ['kifus.usiMoves は配列', 'kifus_usi_moves_array', () =>
      insertKifu({ usiMoves: raw({ a: 1 }) })],
    ['kifus.sourceTz は JST / UTC', 'kifus_source_tz_check', () => insertKifu({ sourceTz: 'PST' })],
    ['kifus.analysisRevision >= 0', 'kifus_analysis_revision_nonneg', () =>
      insertKifu({ analysisRevision: -1 })],
    ['users.displayName は空にしない', 'users_display_name_not_empty', () =>
      db.insert(users).values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: '' })],
    ['user_aliases.name は空にしない', 'user_aliases_name_not_empty', () =>
      db.insert(userAliases).values({ userId: OWNER_USER_ID, name: '' })],
    ['user_aliases の期間は validFrom <= validTo', 'user_aliases_valid_range', () =>
      db.insert(userAliases).values({
        userId: OWNER_USER_ID,
        name: randomUUID(),
        validFrom: '2026-02-01',
        validTo: '2026-01-01',
      })],
    ['video_kifu_sources の区間は 0 <= 開始 <= 終了', 'video_kifu_sources_range', async () =>
      db.insert(videoKifuSources).values({
        kifuId: await insertKifu({ source: 'video' }),
        ownerId: OWNER_USER_ID,
        videoId: randomUUID().slice(0, 32),
        gameIndex: 1,
        startedAtSec: 10,
        endedAtSec: 5,
        bottomIsSente: true,
        extractorRev: 'r',
        raw: {},
      })],
    ['video_kifu_sources.gameIndex >= 0', 'video_kifu_sources_game_index_nonneg', async () =>
      db.insert(videoKifuSources).values({
        kifuId: await insertKifu({ source: 'video' }),
        ownerId: OWNER_USER_ID,
        videoId: randomUUID().slice(0, 32),
        gameIndex: -1,
        startedAtSec: 0,
        endedAtSec: 5,
        bottomIsSente: true,
        extractorRev: 'r',
        raw: {},
      })],
    ['kifu_analyses.detail は配列', 'kifu_analyses_detail_array', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), detail: raw({}) })],
    ['kifu_analyses.runs は配列', 'kifu_analyses_runs_array', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), runs: raw({}) })],
    ['kifu_analyses.fullCount >= 0', 'kifu_analyses_full_count_range', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), fullCount: -1 })],
    ['kifu_analyses.fullCount は局面数を超えない', 'kifu_analyses_full_count_range', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), fullCount: 1 })],
    ['kifu_analyses.minMateSente >= 1', 'kifu_analyses_min_mate_sente_positive', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), minMateSente: 0 })],
    ['kifu_analyses.minMateGote >= 1', 'kifu_analyses_min_mate_gote_positive', async () =>
      db.insert(kifuAnalyses).values({ ...analysisRow(await insertKifu()), minMateGote: 0 })],
    ['kifu_positions.moveNumber >= 0', 'kifu_positions_move_number_nonneg', async () =>
      db.insert(kifuPositions).values(positionRow(await insertKifu(), -1, '7g7f'))],
    ['kifu_positions: 初期局面に手を持たせない', 'kifu_positions_initial_has_no_move', async () =>
      db.insert(kifuPositions).values(positionRow(await insertKifu(), 0, '7g7f'))],
    ['kifu_positions: 初期局面以外は手を持つ', 'kifu_positions_initial_has_no_move', async () =>
      db.insert(kifuPositions).values(positionRow(await insertKifu(), 1, null))],
    ['drills: mate なのに matePlies が無い', 'drills_mate_plies_iff_mate', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), kind: 'mate', reason: 'missed_mate' })],
    ['drills: best なのに matePlies がある', 'drills_mate_plies_iff_mate', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), matePlies: 5 })],
    ['drills.answerScoreType は cp / mate', 'drills_answer_score_type_check', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), answerScoreType: 'x' })],
    ['drills.candidates は配列', 'drills_candidates_array', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), candidates: raw({}) })],
    ['drills.answerPv は配列', 'drills_answer_pv_array', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), answerPv: raw(1) })],
    ['drill_attempts.line は配列', 'drill_attempts_line_array', async () => {
      const [drill] = await db
        .insert(drills)
        .values(drillRow(await insertKifu()))
        .returning({ id: drills.id });
      return db.insert(drillAttempts).values({ drillId: drill.id, ownerId: OWNER_USER_ID, line: raw('7g7f') });
    }],
  ];

  it.each(cases)('%s', async (_name, constraint, write) => {
    const err = await failure(write());
    expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint });
  });

  it('null は通す（任意の列の制約は値があるときだけ効く）', async () => {
    const kifuId = await insertKifu({ usiMoves: null, sourceTz: null });
    await db.insert(userAliases).values({ userId: OWNER_USER_ID, name: randomUUID() });
    await db.insert(kifuAnalyses).values({ ...analysisRow(kifuId), minMateSente: null, minMateGote: null });
    await db.insert(drills).values({ ...drillRow(kifuId), kind: 'mate', reason: 'missed_mate', matePlies: 3 });
  });
});

describe('enum（text + CHECK。prd/15 §3.1）', () => {
  const cases: [string, string, () => Promise<unknown>][] = [
    ['kifus.source', 'kifus_source_check', () => insertKifu({ source: raw('youtube') })],
    ['kifus.analysisProfile', 'kifus_analysis_profile_check', () =>
      insertKifu({ analysisProfile: raw('deep') })],
    ['kifus.subjectSide', 'kifus_subject_side_check', () => insertKifu({ subjectSide: raw('both') })],
    ['kifu_tactics.side', 'kifu_tactics_side_check', async () =>
      db.execute(sql`insert into kifu_tactics (kifu_id, owner_id, side, label, turn)
        values (${await insertKifu()}, ${OWNER_USER_ID}, 'nobody', '四間飛車', 1)`)],
    ['kifu_positions.sideToMove', 'kifu_positions_side_to_move_check', async () =>
      db.insert(kifuPositions).values({ ...positionRow(await insertKifu(), 0, null), sideToMove: raw('x') })],
    ['drills.kind', 'drills_kind_check', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), kind: raw('tsume') })],
    ['drills.reason', 'drills_reason_check', async () =>
      db.insert(drills).values({ ...drillRow(await insertKifu()), reason: raw('x') })],
    ['drill_attempts.verdict', 'drill_attempts_verdict_check', async () => {
      const [drill] = await db
        .insert(drills)
        .values(drillRow(await insertKifu()))
        .returning({ id: drills.id });
      return db.insert(drillAttempts).values({ drillId: drill.id, ownerId: OWNER_USER_ID, verdict: raw('maybe') });
    }],
  ];

  it.each(cases)('%s は値の一覧の外を弾く', async (_name, constraint, write) => {
    const err = await failure(write());
    expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint });
  });
});

describe('bytea（局面索引。prd/15 §3）', () => {
  it('Buffer で往復する', async () => {
    const kifuId = await insertKifu();
    const board = Buffer.from(Array.from({ length: 81 }, (_, i) => i));
    await db.insert(kifuPositions).values({ ...positionRow(kifuId, 0, null), board });
    const [row] = await db
      .select({ board: kifuPositions.board })
      .from(kifuPositions)
      .where(eq(kifuPositions.kifuId, kifuId));
    expect(Buffer.isBuffer(row.board)).toBe(true);
    expect(row.board.equals(board)).toBe(true);
  });

  it.each([
    ['sfenHash', 'kifu_positions_sfen_hash_len', { sfenHash: bytes(7) }],
    ['board', 'kifu_positions_board_len', { board: bytes(80) }],
    ['hands', 'kifu_positions_hands_len', { hands: bytes(15) }],
  ] as const)('%s は固定長（長さの CHECK）', async (_name, constraint, override) => {
    const kifuId = await insertKifu();
    const err = await failure(
      db.insert(kifuPositions).values({ ...positionRow(kifuId, 0, null), ...override }),
    );
    expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint });
  });
});

describe('updatedAt のトリガー（prd/15 §3.4）', () => {
  const PAST = new Date('2020-01-01T00:00:00Z');

  /** updatedAt を過去に寄せる（明示的に書いた値はトリガーが尊重する） */
  async function ageKifu(id: number) {
    await db.update(kifus).set({ updatedAt: PAST }).where(eq(kifus.id, id));
    const [row] = await db.select({ updatedAt: kifus.updatedAt }).from(kifus).where(eq(kifus.id, id));
    expect(row.updatedAt).toEqual(PAST);
  }

  it('値が変わる UPDATE で updatedAt が進む', async () => {
    const id = await insertKifu();
    await ageKifu(id);
    await db.update(kifus).set({ title: 'changed' }).where(eq(kifus.id, id));
    const [row] = await db.select({ updatedAt: kifus.updatedAt }).from(kifus).where(eq(kifus.id, id));
    expect(row.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
  });

  it('同じ値の UPDATE では動かさない（MySQL の ON UPDATE CURRENT_TIMESTAMP と同じ）', async () => {
    const id = await insertKifu({ title: 'same' });
    await ageKifu(id);
    await db.update(kifus).set({ title: 'same' }).where(eq(kifus.id, id));
    const [row] = await db.select({ updatedAt: kifus.updatedAt }).from(kifus).where(eq(kifus.id, id));
    expect(row.updatedAt).toEqual(PAST);
  });

  it('updatedAt を持つ全表にトリガーがある（表を足したらトリガーも足す）', async () => {
    const tables = [users, session, account, verification, kifus, videoKifuSources, drills, kifuAnalyses];
    const result = await db.execute<{ table: string }>(sql`
      select c.relname as "table"
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and t.tgname like '%_set_updated_at'`);
    const withTrigger = new Set(result.rows.map((r) => r.table));
    // schema の側から updatedAt を持つ表を数える（数え漏れを防ぐ）
    const all = [users, session, account, verification, kifus, videoKifuSources, drills,
      userAliases, kifuAnalyses, kifuPositions, drillAttempts];
    const expected = all.filter((t) => 'updatedAt' in t).map((t) => getTableName(t));
    expect(expected.sort()).toEqual(tables.map((t) => getTableName(t)).sort());
    expect([...withTrigger].sort()).toEqual(expected.sort());
  });
});

describe('Better Auth（pg アダプタ。prd/15 §3.3）', () => {
  it('user・account・session の ID を DB の既定値で振る', async () => {
    const auth = betterAuth(
      authOptions(
        {
          isDev: true,
          secret: 'test-secret-'.padEnd(40, 'x'),
          baseURL: 'http://localhost:5173',
          google: null,
          allowSignup: true,
          trustedOrigins: ['http://localhost:5173'],
        },
        drizzleAdapter(db, { provider: 'pg', schema: { users, session, account, verification } }),
      ),
    );
    const email = `${randomUUID()}@example.invalid`;
    const result = await auth.api.signUpEmail({
      body: { email, password: 'password-for-test', name: 'Someone' },
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(result.user.id).toMatch(uuid);

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user).toMatchObject({ id: result.user.id, displayName: 'Someone' });
    const accounts = await db.select().from(account).where(eq(account.userId, user.id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toMatch(uuid);
    const sessions = await db.select().from(session).where(eq(session.userId, user.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toMatch(uuid);
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('列名が snake_case でも signIn・セッションの照会・account が通る（prd/15 §3.6）', async () => {
    const auth = betterAuth(
      authOptions(
        {
          isDev: true,
          secret: 'test-secret-'.padEnd(40, 'x'),
          baseURL: 'http://localhost:5173',
          google: null,
          allowSignup: true,
          trustedOrigins: ['http://localhost:5173'],
        },
        drizzleAdapter(db, { provider: 'pg', schema: { users, session, account, verification } }),
      ),
    );
    const email = `${randomUUID()}@example.invalid`;
    const password = 'password-for-test';
    await auth.api.signUpEmail({ body: { email, password, name: 'Someone' } });

    const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(current?.user).toMatchObject({ email, emailVerified: false });

    const linked = await auth.api.listUserAccounts({ headers: new Headers({ cookie }) });
    expect(linked.map((a) => a.providerId)).toEqual(['credential']);

    // DB 上の列は snake_case（Better Auth がプロパティ名でなく DB の名前で書いていること）
    const raw = await db.execute<{ email_verified: boolean; provider_id: string; sessions: number }>(sql`
      select u.email_verified, a.provider_id,
        (select count(*)::int from session s where s.user_id = u.id) as sessions
      from users u join account a on a.user_id = u.id where u.email = ${email}`);
    expect(raw.rows).toEqual([{ email_verified: false, provider_id: 'credential', sessions: 2 }]);
  });
});

describe('命名（prd/15 §3.6）', () => {
  it('全表の列名が snake_case（大文字を含まない。psql でダブルクォートが要らない）', async () => {
    const result = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' order by table_name, column_name`);
    expect(result.rows.length).toBeGreaterThan(0);
    const bad = result.rows.filter((r) => !/^[a-z][a-z0-9_]*$/.test(r.column_name));
    expect(bad).toEqual([]);
  });
});

describe('集計の戻り値（node-postgres は bigint を文字列で返す。prd/15 §3.5）', () => {
  it('出題の件数・一覧の集計は number で返り、日時は ISO 文字列になる', async () => {
    const ownerId = await insertUser();
    const kifuId = await insertKifu({ ownerId });
    const [drill] = await db.insert(drills).values(drillRow(kifuId, 0, ownerId)).returning({ id: drills.id });
    const [attempt] = await db
      .insert(drillAttempts)
      .values({ drillId: drill.id, ownerId, move: '2g2f', verdict: 'correct', line: ['2g2f'] })
      .returning({ createdAt: drillAttempts.createdAt });

    const counts = await drillCounts(ownerId);
    expect(counts).toEqual({ total: 1, answered: 1, correct: 1 });

    const list = await listDrills(ownerId, drillListQuerySchema.parse({}));
    expect(list.pagination.total).toBe(1);
    expect(list.drills[0]).toMatchObject({ answers: 1, correct: 1, excluded: false, status: 'correct' });
    // 集計で取った日時（sql 断片）も、列から読んだ日時と同じ時刻を指す（セッションは Asia/Tokyo）
    expect(list.drills[0].lastAnsweredAt).toBe(attempt.createdAt.toISOString());
  });
});

describe('棋譜一覧の検索（prd/15 §3.2）', () => {
  /** その条件で自分の作った行が拾われるか */
  async function finds(where: SQL | undefined, id: number): Promise<boolean> {
    const rows = await db.select({ id: kifus.id }).from(kifus).where(and(where, eq(kifus.id, id)));
    return rows.length === 1;
  }

  it('自由文字列は大文字小文字を区別しない（ilike）', async () => {
    const name = `Daiius${randomUUID().slice(0, 8)}`;
    const id = await insertKifu({ sente: name });
    const where = kifuListWhere(kifuListQuerySchema.parse({ q: name.toLowerCase() }));
    expect(await finds(where, id)).toBe(true);
  });

  it('ワイルドカードは素の文字として扱う', async () => {
    const id = await insertKifu({ title: 'abc' });
    expect(await finds(kifuListWhere(kifuListQuerySchema.parse({ q: '%' })), id)).toBe(false);
    expect(await finds(kifuListWhere(kifuListQuerySchema.parse({ q: 'a_c' })), id)).toBe(false);
    const literal = await insertKifu({ title: '100%_\\' });
    expect(await finds(kifuListWhere(kifuListQuerySchema.parse({ q: '0%_\\' })), literal)).toBe(true);
  });

  it('期間の境界は JST の暦日（セッションの時刻帯に依らない）', async () => {
    // JST 2026-09-10 00:30 ＝ UTC 2026-09-09 15:30
    const id = await insertKifu({ playedAt: new Date('2026-09-09T15:30:00Z') });
    const on = (day: string) =>
      kifuListWhere(kifuListQuerySchema.parse({ from: day, to: day }));
    expect(await finds(on('2026-09-10'), id)).toBe(true);
    expect(await finds(on('2026-09-09'), id)).toBe(false);
  });
});

describe('名前候補の一意（prd/11 §2.1・prd/15 §3.2）', () => {
  it('同じ名前は一意制約違反として判定でき、大文字小文字だけ違う名前は別の値として登録できる', async () => {
    const name = `Daiius${randomUUID().slice(0, 8)}`;
    await db.transaction((tx) => addAlias(tx, OWNER_USER_ID, name, {}));
    let caught: unknown;
    try {
      await db.transaction((tx) => addAlias(tx, OWNER_USER_ID, name, {}));
    } catch (err) {
      caught = err;
    }
    // route（POST /users/me/aliases）はこれで 409 を返す
    expect(isUniqueViolation(caught)).toBe(true);
    await db.transaction((tx) => addAlias(tx, OWNER_USER_ID, name.toLowerCase(), {}));
  });
});

describe('FK（CASCADE の有無）', () => {
  it('棋譜を消すと解析・局面索引・出題・解答履歴が道連れになる', async () => {
    const kifuId = await insertKifu();
    await insertAnalysis(kifuId, [[cand('7g7f', 0)]]);
    await db.insert(kifuPositions).values(positionRow(kifuId, 0, null));
    const [drill] = await db.insert(drills).values(drillRow(kifuId)).returning({ id: drills.id });
    await db.insert(drillAttempts).values({ drillId: drill.id, ownerId: OWNER_USER_ID, excluded: true });

    await db.delete(kifus).where(eq(kifus.id, kifuId));

    expect(await db.select().from(kifuAnalyses).where(eq(kifuAnalyses.kifuId, kifuId))).toEqual([]);
    expect(await db.select().from(kifuPositions).where(eq(kifuPositions.kifuId, kifuId))).toEqual([]);
    expect(await db.select().from(drillAttempts).where(eq(drillAttempts.drillId, drill.id))).toEqual([]);
  });

  it('🔒 ユーザーを消しても棋譜は道連れにしない（kifus.ownerId は CASCADE しない。prd/14 §3.1）', async () => {
    const userId = await insertUser();
    await insertKifu({ ownerId: userId });
    const err = await failure(db.delete(users).where(eq(users.id, userId)));
    expect(err).toMatchObject({ code: FK_VIOLATION, constraint: 'kifus_owner_id_users_id_fkey' });
  });

  it('ユーザーを消すと名前候補・セッション・アカウントは道連れになる', async () => {
    const userId = await insertUser();
    await db.insert(userAliases).values({ userId, name: randomUUID() });
    await db.insert(session).values({ userId, token: randomUUID(), expiresAt: new Date() });
    await db.insert(account).values({ userId, providerId: 'credential', accountId: randomUUID() });

    await db.delete(users).where(eq(users.id, userId));

    expect(await db.select().from(userAliases).where(eq(userAliases.userId, userId))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.userId, userId))).toEqual([]);
  });
});

describe('所有者の写し（子の表の owner_id と複合 FK。prd/14 §4.1）', () => {
  it('kifus を参照する表・drills を参照する表のすべてが owner_id（NOT NULL）を持つ', async () => {
    // DB の側から「親を指す列を持つ表」を数える（表を足したときの付け忘れを拾う）
    const result = await db.execute<{ table_name: string; nullable: string | null }>(sql`
      select c.table_name, o.is_nullable as nullable
      from information_schema.columns c
      left join information_schema.columns o
        on o.table_schema = c.table_schema and o.table_name = c.table_name and o.column_name = 'owner_id'
      where c.table_schema = 'public' and c.column_name in ('kifu_id', 'drill_id')
      order by c.table_name`);
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'drill_attempts', 'drills', 'kifu_analyses', 'kifu_positions', 'kifu_tactics', 'video_kifu_sources',
    ]);
    expect(result.rows.filter((r) => r.nullable !== 'NO')).toEqual([]);
  });

  /** 子の行を書く関数（`ownerId` に親と違う値を渡すと複合 FK に反する） */
  const children: [string, string, (kifuId: number, ownerId: string) => Promise<unknown>][] = [
    ['kifu_analyses', 'kifu_analyses_kifu_owner_fkey', (kifuId, ownerId) =>
      db.insert(kifuAnalyses).values(analysisRow(kifuId, ownerId))],
    ['kifu_tactics', 'kifu_tactics_kifu_owner_fkey', (kifuId, ownerId) =>
      db.insert(kifuTactics).values({ kifuId, ownerId, side: 'sente', label: '四間飛車', turn: 1 })],
    ['kifu_positions', 'kifu_positions_kifu_owner_fkey', (kifuId, ownerId) =>
      db.insert(kifuPositions).values(positionRow(kifuId, 0, null, ownerId))],
    ['drills', 'drills_kifu_owner_fkey', (kifuId, ownerId) =>
      db.insert(drills).values(drillRow(kifuId, 0, ownerId))],
    ['video_kifu_sources', 'video_kifu_sources_kifu_owner_fkey', (kifuId, ownerId) =>
      db.insert(videoKifuSources).values({
        kifuId,
        ownerId,
        videoId: randomUUID().slice(0, 32),
        gameIndex: 1,
        startedAtSec: 0,
        endedAtSec: 5,
        bottomIsSente: true,
        extractorRev: 'r',
        raw: {},
      })],
    ['drill_attempts', 'drill_attempts_drill_owner_fkey', async (kifuId, ownerId) => {
      // 出題そのものは親（棋譜）と同じ所有者で作り、解答履歴の所有者だけを変える
      const [drill] = await db.insert(drills).values(drillRow(kifuId)).returning({ id: drills.id });
      return db.insert(drillAttempts).values({ drillId: drill.id, ownerId, excluded: true });
    }],
  ];

  it.each(children)('%s: 親と違う所有者の行は入らない', async (_table, constraint, write) => {
    const other = await insertUser();
    const kifuId = await insertKifu();
    const err = await failure(write(kifuId, other));
    expect(err).toMatchObject({ code: FK_VIOLATION, constraint });
  });

  it.each(children)('%s: 親と同じ所有者の行は入る', async (_table, _constraint, write) => {
    await write(await insertKifu(), OWNER_USER_ID);
  });

  it('子の owner_id だけを書き換えることはできない', async () => {
    const other = await insertUser();
    const kifuId = await insertKifu();
    await db.insert(kifuPositions).values(positionRow(kifuId, 0, null));
    const err = await failure(
      db.update(kifuPositions).set({ ownerId: other }).where(eq(kifuPositions.kifuId, kifuId)),
    );
    expect(err).toMatchObject({ code: FK_VIOLATION, constraint: 'kifu_positions_kifu_owner_fkey' });
  });

  it('棋譜の所有者を付け替えると、子の表（解答履歴まで）が追随する（ON UPDATE CASCADE）', async () => {
    const other = await insertUser();
    const kifuId = await insertKifu({ usiMoves: ['7g7f'] });
    await db.transaction(async (tx) => {
      await replacePositions(tx, owned(kifuId), ['7g7f']);
    });
    await insertAnalysis(kifuId, [[cand('7g7f', 0)]]);
    const [drill] = await db.insert(drills).values(drillRow(kifuId)).returning({ id: drills.id });
    await db.insert(drillAttempts).values({ drillId: drill.id, ownerId: OWNER_USER_ID, excluded: true });

    await db.update(kifus).set({ ownerId: other }).where(eq(kifus.id, kifuId));

    const owners = async () => [
      ...(await db.select({ o: kifuPositions.ownerId }).from(kifuPositions).where(eq(kifuPositions.kifuId, kifuId))),
      ...(await db.select({ o: kifuAnalyses.ownerId }).from(kifuAnalyses).where(eq(kifuAnalyses.kifuId, kifuId))),
      ...(await db.select({ o: drills.ownerId }).from(drills).where(eq(drills.kifuId, kifuId))),
      ...(await db.select({ o: drillAttempts.ownerId }).from(drillAttempts).where(eq(drillAttempts.drillId, drill.id))),
    ].map((r) => r.o);
    const after = await owners();
    expect(after).toHaveLength(5); // 局面 2 + 解析 1 + 出題 1 + 解答 1
    expect(new Set(after)).toEqual(new Set([other]));
  });

  it('名前候補は同じ名前を別のユーザーが持てる（UNIQUE は (userId, name)。prd/14 §4.1）', async () => {
    const name = `shared${randomUUID().slice(0, 8)}`;
    const a = await insertUser();
    const b = await insertUser();
    await db.insert(userAliases).values({ userId: a, name });
    await db.insert(userAliases).values({ userId: b, name });
    const err = await failure(db.insert(userAliases).values({ userId: a, name }));
    expect(err).toMatchObject({ code: '23505', constraint: 'user_aliases_user_id_name_uq' });
  });
});

describe('出題の追随（upsert。prd/13 §6.1）', () => {
  it('作り直しても ID と解答履歴が残り、条件から外れた行だけが消える', async () => {
    const moves = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e'];
    const kifuId = await insertKifu({ usiMoves: moves, subjectSide: 'sente' });
    await insertAnalysis(kifuId, [[cand('2g2f', 100, 1), cand('7g7f', -600, 2)]]);
    const config = { thresholds: DEFAULT_THRESHOLDS, mateMaxPlies: 10 };

    const first = await db.transaction((tx) => syncDrills(tx, kifuId, config));
    expect(first).toEqual({ upserted: 1, removed: 0 });
    const [drill] = await db.select().from(drills).where(eq(drills.kifuId, kifuId));
    await db.insert(drillAttempts).values({ drillId: drill.id, ownerId: OWNER_USER_ID, move: '2g2f', verdict: 'correct' });
    // 条件から外れる行（抽出されない局面）を紛れ込ませる
    await db.insert(drills).values(drillRow(kifuId, 2));

    const second = await db.transaction((tx) => syncDrills(tx, kifuId, config));
    expect(second).toEqual({ upserted: 1, removed: 1 });
    const rows = await db.select().from(drills).where(eq(drills.kifuId, kifuId));
    expect(rows.map((r) => r.id)).toEqual([drill.id]);
    expect(await db.select().from(drillAttempts).where(eq(drillAttempts.drillId, drill.id))).toHaveLength(1);
  });
});

describe('解析結果の 1 行（kifu_analyses。prd/16）', () => {
  const START = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -';

  it('submit の重ね合わせを保存し、minMate を詰み見逃しの述語が引ける', async () => {
    const kifuId = await insertKifu({ usiMoves: ['7g7f', '3c3d'], result: 'GOTE_WIN', subjectSide: 'sente' });
    const run = (profile: 'quick' | 'full', at: string) => ({
      profile, engineName: 'e', movetimeMs: 1, targetDepth: null, multiPv: 3, at,
    });
    let stored = await loadAnalysis(db, kifuId);
    expect(stored.exists).toBe(false);
    const quick = mergeChunk(stored, [0, 1, 2].map((moveNumber) => ({
      moveNumber,
      candidates: [cand('7g7f', 0)],
    })), run('quick', '2026-10-01T00:00:00.000Z'));
    if (!quick.ok) throw new Error('rejected');
    await db.transaction((tx) => saveAnalysis(tx, owned(kifuId), quick.next));
    stored = await loadAnalysis(db, kifuId);
    const full = mergeChunk(stored, [{ moveNumber: 0, candidates: [cand('7g7f', 9, 1, 'mate')] }],
      run('full', '2026-10-02T00:00:00.000Z'));
    if (!full.ok) throw new Error('rejected');
    await db.transaction((tx) => saveAnalysis(tx, owned(kifuId), full.next));

    const [row] = await db.select().from(kifuAnalyses).where(eq(kifuAnalyses.kifuId, kifuId));
    expect(row.fullCount).toBe(1);
    expect(row.runs.map((r) => r.profile)).toEqual(['quick', 'full']);
    expect({ sente: row.minMateSente, gote: row.minMateGote }).toEqual({ sente: 9, gote: null });

    const ids = async (missedMate: string) =>
      (await db.select({ id: kifus.id }).from(kifus)
        .where(and(eq(kifus.id, kifuId), kifuListWhere(kifuListQuerySchema.parse({ missedMate })))))
        .map((r) => r.id);
    expect(await ids('9')).toEqual([kifuId]);
    expect(await ids('8')).toEqual([]);
  });

  it('局面の再利用は full の局面だけを、その局面の submit の時刻付きで引く', async () => {
    const kifuId = await insertKifu({ usiMoves: ['7g7f', '3c3d'] });
    await db.transaction((tx) => replacePositions(tx, owned(kifuId), ['7g7f', '3c3d']));
    await db.transaction((tx) =>
      saveAnalysis(tx, owned(kifuId), {
        runs: [
          { profile: 'full', engineName: null, movetimeMs: null, targetDepth: null, multiPv: 3, at: '2026-10-05T00:00:00.000Z' },
          { profile: 'quick', engineName: null, movetimeMs: null, targetDepth: null, multiPv: 3, at: '2026-10-06T00:00:00.000Z' },
        ],
        detail: [
          [0, encodeCandidates([cand('7g7f', 30, 1), cand('2g2f', 20, 2), cand('6i7h', 10, 3)])],
          [0, encodeCandidates([cand('3c3d', -30, 1)])],
          [1, encodeCandidates([cand('2g2f', 40, 1)])],
        ],
        fullCount: 2,
      }),
    );
    const mine = <T extends { kifuId: number }>(ms: T[]) => ms.filter((m) => m.kifuId === kifuId);

    const evalMatches = mine(await findKifuPositionMatches({ sfen: START, move: null }));
    expect(evalMatches).toHaveLength(1);
    expect(evalMatches[0].candidates.map((c) => [c.rank, c.move, c.pv])).toEqual([
      [1, '7g7f', []], [2, '2g2f', []], [3, '6i7h', []],
    ]);
    expect(evalMatches[0].analyzedAt).toEqual(new Date('2026-10-05T00:00:00.000Z'));

    const named = mine(await findKifuPositionMatches({ sfen: START, move: '2g2f' }));
    // ① 候補手に持つ（局面 0）と ② 実手ではない → ① だけ
    expect(named.map((m) => [m.moveNumber, m.candidates.length, m.playedMove])).toEqual([[0, 3, null]]);

    const played = mine(await findKifuPositionMatches({ sfen: START, move: '7g7f' }));
    // ① 局面 0 の候補手にある / ② 実手で、次局面（1。full）の解析がある
    expect(played.find((m) => m.playedMove === '7g7f')?.nextCandidates[0].move).toBe('3c3d');
  });
});

// ⚠ 所有者の行（"1"）のメールを書き換えるので、ファイルの最後に置く
describe('所有者への付け替え（dev ログインと移行が使う。prd/07 §4.1）', () => {
  it('account を "1" へ移し、元の user を消して、値を "1" に写す', async () => {
    const email = `${randomUUID()}@example.invalid`;
    const [x] = await db
      .insert(users)
      .values({ name: 'Owner X', email, displayName: 'x' })
      .returning({ id: users.id });
    await db.insert(account).values({ userId: x.id, providerId: 'credential', accountId: x.id });

    const result = await linkOwnerAccount(db, { provider: 'credential', apply: true, email });
    expect(result.applied).toBe(true);

    expect(await db.select().from(users).where(eq(users.id, x.id))).toEqual([]);
    const [owner] = await db.select().from(users).where(eq(users.id, OWNER_USER_ID));
    expect(owner).toMatchObject({ email, name: 'Owner X', displayName: '(未設定)' });
    const owned = await db
      .select()
      .from(account)
      .where(and(eq(account.userId, OWNER_USER_ID), eq(account.providerId, 'credential')));
    expect(owned).toHaveLength(1);
  });
});
