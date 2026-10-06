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
  candidateMoves,
  drillAttempts,
  drills,
  kifuPositions,
  kifus,
  moveAnalyses,
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

async function insertAnalysis(kifuId: number, moveNumber = 0): Promise<number> {
  const [row] = await db
    .insert(moveAnalyses)
    .values({ kifuId, moveNumber, profile: 'full' })
    .returning({ id: moveAnalyses.id });
  return row.id;
}

/** 正しい形の出題 1 行（上書きして不正な行を作る） */
function drillRow(kifuId: number, moveNumber = 0): typeof drills.$inferInsert {
  return {
    kifuId,
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
function positionRow(kifuId: number, moveNumber: number, move: string | null) {
  return {
    kifuId,
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
        videoId: randomUUID().slice(0, 32),
        gameIndex: -1,
        startedAtSec: 0,
        endedAtSec: 5,
        bottomIsSente: true,
        extractorRev: 'r',
        raw: {},
      })],
    ['move_analyses.moveNumber >= 0', 'move_analyses_move_number_nonneg', async () =>
      db.insert(moveAnalyses).values({ kifuId: await insertKifu(), moveNumber: -1, profile: 'quick' })],
    ['move_analyses.multiPv >= 1', 'move_analyses_multi_pv_positive', async () =>
      db.insert(moveAnalyses).values({
        kifuId: await insertKifu(),
        moveNumber: 0,
        profile: 'quick',
        multiPv: 0,
      })],
    ['candidate_moves.rank >= 1', 'candidate_moves_rank_positive', async () =>
      db.insert(candidateMoves).values({
        moveAnalysisId: await insertAnalysis(await insertKifu()),
        rank: 0,
        move: '7g7f',
        scoreType: 'cp',
        scoreValue: 0,
        depth: 1,
      })],
    ['candidate_moves.scoreType は cp / mate', 'candidate_moves_score_type_check', async () =>
      db.insert(candidateMoves).values({
        moveAnalysisId: await insertAnalysis(await insertKifu()),
        rank: 1,
        move: '7g7f',
        scoreType: 'lowerbound',
        scoreValue: 0,
        depth: 1,
      })],
    ['candidate_moves.depth >= 0', 'candidate_moves_depth_nonneg', async () =>
      db.insert(candidateMoves).values({
        moveAnalysisId: await insertAnalysis(await insertKifu()),
        rank: 1,
        move: '7g7f',
        scoreType: 'cp',
        scoreValue: 0,
        depth: -1,
      })],
    ['candidate_moves.pv は配列', 'candidate_moves_pv_array', async () =>
      db.insert(candidateMoves).values({
        moveAnalysisId: await insertAnalysis(await insertKifu()),
        rank: 1,
        move: '7g7f',
        scoreType: 'cp',
        scoreValue: 0,
        depth: 1,
        pv: raw('7g7f'),
      })],
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
      return db.insert(drillAttempts).values({ drillId: drill.id, line: raw('7g7f') });
    }],
  ];

  it.each(cases)('%s', async (_name, constraint, write) => {
    const err = await failure(write());
    expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint });
  });

  it('null は通す（任意の列の制約は値があるときだけ効く）', async () => {
    const kifuId = await insertKifu({ usiMoves: null, sourceTz: null });
    await db.insert(userAliases).values({ userId: OWNER_USER_ID, name: randomUUID() });
    const analysisId = await insertAnalysis(kifuId);
    await db.insert(candidateMoves).values({
      moveAnalysisId: analysisId,
      rank: 1,
      move: '7g7f',
      scoreType: 'mate',
      scoreValue: 3,
      depth: 0,
      pv: null,
    });
    await db.insert(drills).values({ ...drillRow(kifuId), kind: 'mate', reason: 'missed_mate', matePlies: 3 });
  });
});

describe('enum（text + CHECK。prd/15 §3.1）', () => {
  const cases: [string, string, () => Promise<unknown>][] = [
    ['kifus.source', 'kifus_source_check', () => insertKifu({ source: raw('youtube') })],
    ['kifus.analysisProfile', 'kifus_analysis_profile_check', () =>
      insertKifu({ analysisProfile: raw('deep') })],
    ['kifus.subjectSide', 'kifus_subject_side_check', () => insertKifu({ subjectSide: raw('both') })],
    ['move_analyses.profile', 'move_analyses_profile_check', async () =>
      db.insert(moveAnalyses).values({ kifuId: await insertKifu(), moveNumber: 0, profile: raw('x') })],
    ['kifu_tactics.side', 'kifu_tactics_side_check', async () =>
      db.execute(sql`insert into kifu_tactics (kifu_id, side, label, turn)
        values (${await insertKifu()}, 'nobody', '四間飛車', 1)`)],
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
      return db.insert(drillAttempts).values({ drillId: drill.id, verdict: raw('maybe') });
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
    const tables = [users, session, account, verification, kifus, videoKifuSources, drills];
    const result = await db.execute<{ table: string }>(sql`
      select c.relname as "table"
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and t.tgname like '%_set_updated_at'`);
    const withTrigger = new Set(result.rows.map((r) => r.table));
    // schema の側から updatedAt を持つ表を数える（数え漏れを防ぐ）
    const all = [users, session, account, verification, kifus, videoKifuSources, drills,
      userAliases, moveAnalyses, candidateMoves, kifuPositions, drillAttempts];
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
    const [drill] = await db.insert(drills).values(drillRow(kifuId)).returning({ id: drills.id });
    const [attempt] = await db
      .insert(drillAttempts)
      .values({ drillId: drill.id, move: '2g2f', verdict: 'correct', line: ['2g2f'] })
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
  it('棋譜を消すと解析・候補手・局面索引・出題・解答履歴が道連れになる', async () => {
    const kifuId = await insertKifu();
    const analysisId = await insertAnalysis(kifuId);
    await db.insert(candidateMoves).values({
      moveAnalysisId: analysisId,
      rank: 1,
      move: '7g7f',
      scoreType: 'cp',
      scoreValue: 0,
      depth: 1,
    });
    await db.insert(kifuPositions).values(positionRow(kifuId, 0, null));
    const [drill] = await db.insert(drills).values(drillRow(kifuId)).returning({ id: drills.id });
    await db.insert(drillAttempts).values({ drillId: drill.id, excluded: true });

    await db.delete(kifus).where(eq(kifus.id, kifuId));

    expect(await db.select().from(moveAnalyses).where(eq(moveAnalyses.kifuId, kifuId))).toEqual([]);
    expect(
      await db.select().from(candidateMoves).where(eq(candidateMoves.moveAnalysisId, analysisId)),
    ).toEqual([]);
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

describe('出題の追随（upsert。prd/13 §6.1）', () => {
  it('作り直しても ID と解答履歴が残り、条件から外れた行だけが消える', async () => {
    const moves = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e'];
    const kifuId = await insertKifu({ usiMoves: moves, subjectSide: 'sente' });
    const analysisId = await insertAnalysis(kifuId, 0);
    await db.insert(candidateMoves).values([
      { moveAnalysisId: analysisId, rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 100, depth: 1 },
      { moveAnalysisId: analysisId, rank: 2, move: '7g7f', scoreType: 'cp', scoreValue: -600, depth: 1 },
    ]);
    const config = { thresholds: DEFAULT_THRESHOLDS, mateMaxPlies: 10 };

    const first = await db.transaction((tx) => syncDrills(tx, kifuId, config));
    expect(first).toEqual({ upserted: 1, removed: 0 });
    const [drill] = await db.select().from(drills).where(eq(drills.kifuId, kifuId));
    await db.insert(drillAttempts).values({ drillId: drill.id, move: '2g2f', verdict: 'correct' });
    // 条件から外れる行（抽出されない局面）を紛れ込ませる
    await db.insert(drills).values(drillRow(kifuId, 2));

    const second = await db.transaction((tx) => syncDrills(tx, kifuId, config));
    expect(second).toEqual({ upserted: 1, removed: 1 });
    const rows = await db.select().from(drills).where(eq(drills.kifuId, kifuId));
    expect(rows.map((r) => r.id)).toEqual([drill.id]);
    expect(await db.select().from(drillAttempts).where(eq(drillAttempts.drillId, drill.id))).toHaveLength(1);
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
