/**
 * 解析の担当（`worker` / `browser`）とブラウザ解析の受け口（prd/14 §5.7〜§5.9）を実 Postgres で確かめる。
 * `pnpm --filter server test:db`。
 *
 * 1. 担当の切り替え: 棋譜の分類（消す / 世代だけ進める / 触れない）・同じ値は何もしない・往復しても世代が戻らない
 * 2. 切り替え前の世代の報告（手元 worker・ブラウザの両方）が破棄されること、担当違いの報告・開始が通らないこと
 * 3. ブラウザ解析: 開始 → チャンク → 完了、別のエンジンの途中の解析のやり直し、失敗の記録
 * 4. 手元 worker の取得（poll）と quickPending が、担当 `browser` のユーザーの棋譜を返さないこと
 * 5. 所有者スコープ: 他人の番号は「無い」（404 相当）
 *
 * ⚠ `worker` を担当にできるのは所有者（"1"）だけ（DB の CHECK）なので、切り替えは所有者の行で試す。
 *   DATABASE はファイル間で共有するため、**所有者の担当は最後に必ず `worker` に戻す**（他のファイルは
 *   所有者が `worker` である前提で `POST /positions/evaluate` などを叩く）。切り替えは所有者の未完了の棋譜の
 *   世代を進めるが、各テストは自分で作った行だけを見る。
 *   所有者ゲート（prd/07 §5.1）があるので、API は所有者として叩く。所有者以外（担当 `browser`）は関数で確かめる。
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { client, db, type Tx } from './db/index.js';
import { kifuAnalyses, kifus, users } from './db/schema.js';
import {
  analysisAssigneeOf,
  BROWSER_ANALYSIS_SETTINGS,
  pendingBrowserKifuNos,
  recordAnalysisFailure,
  startBrowserAnalysis,
  submitAnalysisChunk,
  switchAnalysisAssignee,
  type AnalysisAssignee,
  type ChunkSubmission,
} from './analysis-report.js';
import { resetProgress } from './analysis-progress.js';
import type { AnalysisRun, CandidateInput } from './kifu-analysis-detail.js';
import { loadAnalysis } from './kifu-analysis-store.js';
import { insertKifu, type NewKifu } from './kifu-number.js';
import { resetEvaluations } from './position-eval.js';
import { withUserTx } from './user-tx.js';

const OWNER = '1';
const MOVES = ['7g7f', '3c3d', '2g2f'];
/** 全局面数（初期局面を含む） */
const POSITIONS = MOVES.length + 1;
const ORIGIN = 'http://localhost:5173';
const API_KEY = 'test-api-key';

const ENGINE = { engineBuild: 'c1b80eaa-0123456789ab', evalHash: 'a'.repeat(64) };
const OTHER_ENGINE = { engineBuild: 'deadbeef-0123456789ab', evalHash: 'a'.repeat(64) };

const cand = (move = '7g7f'): CandidateInput => ({
  rank: 1,
  move,
  scoreType: 'cp',
  scoreValue: 30,
  depth: 10,
  pv: [move],
});

/** `from` から `count` 局面ぶんのチャンク（最善手は実際に指した手。最後の局面は適当な 1 手） */
const positions = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    moveNumber: from + i,
    candidates: [cand(MOVES[from + i] ?? '8c8d')],
  }));

const nativeRun = (profile: 'quick' | 'full'): Omit<AnalysisRun, 'at'> => ({
  profile,
  engineName: 'YaneuraOu',
  movetimeMs: 1000,
  targetDepth: null,
  multiPv: 3,
});

const wasmRun = (engine = ENGINE): Omit<AnalysisRun, 'at'> => ({
  profile: 'quick',
  engineName: 'YaneuraOu',
  movetimeMs: 300,
  targetDepth: null,
  multiPv: 1,
  runtime: 'wasm',
  ...engine,
  fvScale: 16,
  threads: 4,
  hashMb: 64,
  book: false,
});

/** 手元 worker の報告（system ロールの経路と同じ形。棋譜は内部 ID で指す） */
const workerChunk = (
  id: number,
  revision: number,
  profile: 'quick' | 'full',
  from: number,
  count: number,
) =>
  db.transaction((tx) =>
    submitAnalysisChunk(tx, { id }, {
      revision,
      assignee: 'worker',
      run: nativeRun(profile),
      analyses: positions(from, count),
    }),
  );

/** ブラウザの報告（ログインの経路と同じ形。ユーザーとして開いた tx・棋譜は所有者と番号で指す） */
const browserChunk = (
  userId: string,
  no: number,
  revision: number,
  from: number,
  count: number,
  engine = ENGINE,
  override: Partial<ChunkSubmission> = {},
) =>
  withUserTx(db, userId, (tx) =>
    submitAnalysisChunk(tx, { ownerId: userId, no }, {
      revision,
      assignee: 'browser',
      run: wasmRun(engine),
      sameEngine: engine,
      analyses: positions(from, count),
      ...override,
    }),
  );

async function insertUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
    .returning({ id: users.id });
  return row.id;
}

/** 指し手列のある未解析の棋譜を 1 局（番号は採番を通す） */
const newKifu = async (ownerId: string, values: Partial<NewKifu> = {}) => {
  const row = await db.transaction((tx) =>
    insertKifu(tx, { title: 't', kifText: '', ownerId, usiMoves: MOVES, ...values }),
  );
  if (ownerId === OWNER) ownerKifuIds.push(row.id);
  return row;
};

/**
 * このファイルが所有者（"1"）に作った棋譜。**最後に消す**——DATABASE はファイル間で共有で、所有者の一覧は
 * 1 ページ 50 件。ここで増やしたまま残すと、所有者の一覧の 1 ページ目を見る他のファイルのテストが
 * 自分の棋譜を見つけられなくなる（ファイルの順は実行ごとに変わりうる）
 */
const ownerKifuIds: number[] = [];

async function stateOf(id: number) {
  const [row] = await db
    .select({
      revision: kifus.analysisRevision,
      profile: kifus.analysisProfile,
      completed: kifus.analysisCompletedAt,
      error: kifus.analysisError,
    })
    .from(kifus)
    .where(eq(kifus.id, id));
  const stored = await loadAnalysis(db, id);
  return {
    revision: row.revision,
    profile: row.profile,
    completed: row.completed !== null,
    error: row.error,
    positions: stored.detail.length,
    fullCount: stored.fullCount,
    exists: stored.exists,
  };
}

/** 所有者の担当を切り替える（所有者として開いた tx で） */
const switchOwner = (next: AnalysisAssignee) =>
  withUserTx(db, OWNER, (tx) => switchAnalysisAssignee(tx, OWNER, next));

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => withUserTx(db, userId, fn);

let app: Hono;
const savedApiKey = process.env.API_KEY;

beforeAll(async () => {
  // Better Auth の設定（`auth.ts` は import 時に読む）。セッションは差し替えるので値は何でもよい
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(40);
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.API_KEY = API_KEY;
  const { auth } = await import('./auth.js');
  (auth.api as { getSession: unknown }).getSession = vi.fn(async () => ({ user: { id: OWNER } }));
  app = (await import('./route.js')).app as unknown as Hono;
  // 前提: 所有者の担当は worker（マイグレーションの埋め戻し）
  await switchOwner('worker');
});

afterAll(async () => {
  // 🔒 他のファイルのために、所有者の担当を worker に戻し、所有者に作った棋譜を消す
  await switchOwner('worker');
  if (ownerKifuIds.length > 0) await db.delete(kifus).where(inArray(kifus.id, ownerKifuIds));
  process.env.API_KEY = savedApiKey;
  resetProgress();
  resetEvaluations();
  await (await import('./db/system.js')).endSystemDb();
  await client.end();
});

const ownerJson = (method: string, body: unknown, origin: string | null = ORIGIN): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: JSON.stringify(body),
});

const workerGet = (path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${API_KEY}` } });
const workerPost = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('列と既定値（prd/14 §5.7）', () => {
  it('新しいユーザーの担当は browser、所有者は worker', async () => {
    const user = await insertUser();
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, user))).toBe('browser');
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, OWNER))).toBe('worker');
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, randomUUID()))).toBeNull();
  });

  it('🔒 所有者以外は worker を選べない（関数が断り、DB の CHECK も弾く）', async () => {
    const user = await insertUser();
    expect(await asUser(user, (tx) => switchAnalysisAssignee(tx, user, 'worker'))).toEqual({
      status: 'forbidden',
    });
    const err = await db
      .update(users)
      .set({ analysisAssignee: 'worker' })
      .where(eq(users.id, user))
      .then(
        () => null,
        (e: { cause?: { constraint?: string } }) => e.cause?.constraint,
      );
    expect(err).toBe('users_analysis_assignee_worker_owner_only');
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, user))).toBe('browser');
  });
});

describe('担当の切り替え（prd/14 §5.7 規則 1）', () => {
  it('棋譜の分類: 途中は消す・quick 完了は世代だけ進める・full 完了は触れない。失敗の記録は戻す', async () => {
    // (a) 未着手
    const untouched = await newKifu(OWNER);
    // (b) quick の途中（2 局面）
    const quickPartial = await newKifu(OWNER);
    await workerChunk(quickPartial.id, 0, 'quick', 0, 2);
    // (c) quick 完了・full は 0 局面。full の失敗の記録あり
    const quickDone = await newKifu(OWNER);
    await workerChunk(quickDone.id, 0, 'quick', 0, POSITIONS);
    await db.transaction((tx) =>
      recordAnalysisFailure(tx, { id: quickDone.id }, { revision: 0, error: 'full failed', assignee: 'worker', stage: 'full' }),
    );
    // (d) quick 完了・full が途中まで（2 局面）
    const fullPartial = await newKifu(OWNER);
    await workerChunk(fullPartial.id, 0, 'quick', 0, POSITIONS);
    await workerChunk(fullPartial.id, 0, 'full', 0, 2);
    // (e) full まで完了
    const fullDone = await newKifu(OWNER);
    await workerChunk(fullDone.id, 0, 'full', 0, POSITIONS);
    // (f) quick の途中で失敗して止まったもの
    const failed = await newKifu(OWNER);
    await workerChunk(failed.id, 0, 'quick', 0, 1);
    await db.transaction((tx) =>
      recordAnalysisFailure(tx, { id: failed.id }, { revision: 0, error: 'engine died', assignee: 'worker', stage: 'full' }),
    );
    // 他のユーザーの途中の棋譜（所有者の切り替えで触れない）
    const other = await insertUser();
    const otherKifu = await newKifu(other);
    await browserChunk(other, otherKifu.displayNo, 0, 0, 2);

    // 前提（検査が空振りしていない）
    expect(await stateOf(quickDone.id)).toMatchObject({ profile: 'quick', completed: true, error: 'full failed', fullCount: 0 });
    expect(await stateOf(fullPartial.id)).toMatchObject({ profile: 'quick', completed: true, fullCount: 2 });
    expect(await stateOf(fullDone.id)).toMatchObject({ profile: 'full', completed: true, fullCount: POSITIONS });
    expect(await stateOf(failed.id)).toMatchObject({ error: 'engine died', positions: 1 });

    const result = await switchOwner('browser');
    expect(result).toMatchObject({ status: 'switched', assignee: 'browser' });
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, OWNER))).toBe('browser');

    const reset = { revision: 1, profile: null, completed: false, error: null, positions: 0, fullCount: 0, exists: false };
    expect(await stateOf(untouched.id)).toEqual(reset);
    expect(await stateOf(quickPartial.id)).toEqual(reset);
    expect(await stateOf(fullPartial.id)).toEqual(reset);
    expect(await stateOf(failed.id)).toEqual(reset);
    // quick 完了は行を残す（世代だけ進み、失敗の記録は消える）
    expect(await stateOf(quickDone.id)).toEqual({
      revision: 1,
      profile: 'quick',
      completed: true,
      error: null,
      positions: POSITIONS,
      fullCount: 0,
      exists: true,
    });
    // 🔒 full まで完了した棋譜は不変
    expect(await stateOf(fullDone.id)).toMatchObject({ revision: 0, profile: 'full', completed: true, fullCount: POSITIONS });
    // 他のユーザーの棋譜には触れない
    expect(await stateOf(otherKifu.id)).toMatchObject({ revision: 0, positions: 2 });

    await switchOwner('worker');
  });

  it('同じ値への切り替えは何もしない（途中の解析を消さない・世代を進めない）', async () => {
    const kifu = await newKifu(OWNER);
    await workerChunk(kifu.id, 0, 'quick', 0, 2);
    const [before] = await db.select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, OWNER));

    expect(await switchOwner('worker')).toEqual({ status: 'unchanged', assignee: 'worker' });

    expect(await stateOf(kifu.id)).toMatchObject({ revision: 0, positions: 2 });
    const [after] = await db.select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, OWNER));
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('往復しても世代は戻らない（worker → browser → worker）', async () => {
    const kifu = await newKifu(OWNER);
    await workerChunk(kifu.id, 0, 'quick', 0, 2);
    await switchOwner('browser');
    expect((await stateOf(kifu.id)).revision).toBe(1);
    await switchOwner('worker');
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 2, positions: 0 });
  });

  it('browser → worker: ブラウザの quick が完了した棋譜は残り、手元 worker の full の対象になる', async () => {
    await switchOwner('browser');
    const kifu = await newKifu(OWNER);
    const started = await asUser(OWNER, (tx) => startBrowserAnalysis(tx, OWNER, kifu.displayNo, ENGINE));
    if (started?.status !== 'run') throw new Error('開始できるはず');
    expect(await browserChunk(OWNER, kifu.displayNo, started.revision, 0, POSITIONS)).toEqual({
      status: 'applied',
      completed: true,
    });

    await switchOwner('worker');

    const after = await stateOf(kifu.id);
    expect(after).toMatchObject({ revision: started.revision + 1, profile: 'quick', completed: true, positions: POSITIONS });
    // 手元 worker の full は新しい世代で受理され、quick を上書きしていく（prd/05 §1.1d）
    expect(await workerChunk(kifu.id, after.revision, 'full', 0, POSITIONS)).toEqual({
      status: 'applied',
      completed: true,
    });
    expect(await stateOf(kifu.id)).toMatchObject({ profile: 'full', fullCount: POSITIONS });
  });

  it('切り替えは取り込みと直列になる（切り替えの tx が終わるまで、同じユーザーの取り込みは待つ）', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let switched!: () => void;
    const switchedOnce = new Promise<void>((resolve) => {
      switched = resolve;
    });
    const switching = withUserTx(db, OWNER, async (tx) => {
      const result = await switchAnalysisAssignee(tx, OWNER, 'browser');
      switched();
      await held;
      return result;
    });
    await switchedOnce;

    let inserted = false;
    const importing = newKifu(OWNER).then((row) => {
      inserted = true;
      return row;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(inserted).toBe(false);

    release();
    expect((await switching).status).toBe('switched');
    const kifu = await importing;
    // 切り替えの後に生まれた棋譜なので、世代は進んでいない（新しい担当の下で 0 から始まる）
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 0 });
    await switchOwner('worker');
  });
});

describe('切り替えの前後の報告（prd/14 §5.7 規則 1・規則 2）', () => {
  it('手元 worker: 切り替え前に取得した世代の報告・失敗は破棄され、新しい世代でも担当違いで受けない', async () => {
    const kifu = await newKifu(OWNER);
    expect(await workerChunk(kifu.id, 0, 'quick', 0, 1)).toEqual({ status: 'applied', completed: false });

    await switchOwner('browser');

    // 古い世代（切り替え前に取得したもの）
    expect(await workerChunk(kifu.id, 0, 'quick', 1, 1)).toEqual({ status: 'ignored' });
    expect(
      await db.transaction((tx) =>
        recordAnalysisFailure(tx, { id: kifu.id }, { revision: 0, error: 'e', assignee: 'worker', stage: 'full' }),
      ),
    ).toEqual({ applied: false });
    // 新しい世代を知っていても、担当が browser の間は手元 worker の報告を受けない（規則 2）
    expect(await workerChunk(kifu.id, 1, 'quick', 0, 1)).toEqual({ status: 'ignored' });
    expect(
      await db.transaction((tx) =>
        recordAnalysisFailure(tx, { id: kifu.id }, { revision: 1, error: 'e', assignee: 'worker', stage: 'full' }),
      ),
    ).toEqual({ applied: false });
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 1, positions: 0, error: null });

    await switchOwner('worker');
  });

  it('手元 worker の API: 担当違い・古い世代の報告は 201 applied:false（4xx にしない）', async () => {
    const kifu = await newKifu(OWNER);
    await switchOwner('browser');
    const { revision } = await stateOf(kifu.id);

    const submit = await workerPost('/api/worker/analyses', {
      kifuId: kifu.id,
      revision,
      profile: 'quick',
      analyses: positions(0, 1),
    });
    expect(submit.status).toBe(201);
    expect(await submit.json()).toEqual({ ok: true, applied: false, completed: false });

    const error = await workerPost(`/api/worker/kifus/${kifu.id}/error`, { error: 'e', revision });
    expect(error.status).toBe(201);
    expect(await error.json()).toEqual({ ok: true, applied: false });

    const progress = await workerPost('/api/worker/analyses/progress', {
      kifuId: kifu.id,
      revision,
      profile: 'quick',
      analyzed: 1,
      total: POSITIONS,
    });
    expect(await progress.json()).toEqual({ ok: true, applied: false });
    expect(await stateOf(kifu.id)).toMatchObject({ positions: 0, error: null });

    // 担当を worker に戻せば、新しい世代の報告は通る（来歴の任意の項目つき。古い worker は送らない）
    await switchOwner('worker');
    const current = await stateOf(kifu.id);
    const accepted = await workerPost('/api/worker/analyses', {
      kifuId: kifu.id,
      revision: current.revision,
      profile: 'quick',
      runtime: 'native',
      threads: 8,
      hashMb: 1024,
      book: true,
      analyses: [{ moveNumber: 0, candidates: [{ rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 30, depth: 10, pv: ['7g7f'] }] }],
    });
    expect(await accepted.json()).toEqual({ ok: true, applied: true, completed: false });
    const stored = await loadAnalysis(db, kifu.id);
    expect(stored.runs[0]).toMatchObject({ profile: 'quick', runtime: 'native', threads: 8, hashMb: 1024, book: true });
    expect(stored.runs[0]).not.toHaveProperty('engineBuild');
  });

  it('ブラウザ: 切り替え前に開始した世代の報告・失敗は破棄され、開始は 409 相当になる', async () => {
    await switchOwner('browser');
    const kifu = await newKifu(OWNER);
    const started = await asUser(OWNER, (tx) => startBrowserAnalysis(tx, OWNER, kifu.displayNo, ENGINE));
    if (started?.status !== 'run') throw new Error('開始できるはず');
    expect(await browserChunk(OWNER, kifu.displayNo, started.revision, 0, 2)).toEqual({ status: 'applied', completed: false });

    await switchOwner('worker');

    // 途中の解析は消え、世代が進んでいる。開いたままのタブの報告は古い世代として落ちる
    expect(await stateOf(kifu.id)).toMatchObject({ revision: started.revision + 1, positions: 0 });
    expect(await browserChunk(OWNER, kifu.displayNo, started.revision, 2, 1)).toEqual({ status: 'ignored' });
    // 新しい世代を知っていても、担当が worker の間はブラウザの報告を受けない（規則 2）
    expect(await browserChunk(OWNER, kifu.displayNo, started.revision + 1, 0, 1)).toEqual({ status: 'ignored' });
    expect(
      await asUser(OWNER, (tx) =>
        recordAnalysisFailure(tx, { ownerId: OWNER, no: kifu.displayNo }, {
          revision: started.revision + 1,
          error: 'e',
          assignee: 'browser',
          stage: 'quick',
        }),
      ),
    ).toEqual({ applied: false });
    expect(await asUser(OWNER, (tx) => startBrowserAnalysis(tx, OWNER, kifu.displayNo, ENGINE))).toEqual({
      status: 'wrong-assignee',
    });
    expect(await stateOf(kifu.id)).toMatchObject({ positions: 0, error: null });
  });
});

describe('ブラウザ解析の受け口の本体（prd/14 §5.8・§5.9）', () => {
  let user: string;
  beforeAll(async () => {
    user = await insertUser();
  });

  it('開始 → チャンク → 完了。quick として保存し、来歴に実行環境とエンジンを残す', async () => {
    const kifu = await newKifu(user);
    const started = await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE));
    expect(started).toEqual({
      status: 'run',
      revision: 0,
      startMoveNumber: 0,
      usiMoves: MOVES,
      settings: BROWSER_ANALYSIS_SETTINGS,
    });

    expect(await browserChunk(user, kifu.displayNo, 0, 0, 2)).toEqual({ status: 'applied', completed: false });
    // タブを閉じて開き直した: 続き（入っている局面数）から
    expect(await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE))).toMatchObject({
      status: 'run',
      revision: 0,
      startMoveNumber: 2,
    });
    expect(await browserChunk(user, kifu.displayNo, 0, 2, POSITIONS - 2)).toEqual({ status: 'applied', completed: true });

    expect(await stateOf(kifu.id)).toMatchObject({ profile: 'quick', completed: true, positions: POSITIONS, fullCount: 0 });
    const stored = await loadAnalysis(db, kifu.id);
    expect(stored.runs.every((r) => r.profile === 'quick' && r.runtime === 'wasm' && r.book === false)).toBe(true);
    expect(stored.runs[0]).toMatchObject({ ...ENGINE, fvScale: 16, threads: 4, hashMb: 64, multiPv: 1 });

    // 🔒 完了済みは不変: 開始は complete、遅れて届いたチャンクは破棄
    expect(await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, OTHER_ENGINE))).toEqual({
      status: 'complete',
    });
    expect(await browserChunk(user, kifu.displayNo, 0, 0, 1)).toEqual({ status: 'ignored' });
    expect((await loadAnalysis(db, kifu.id)).runs).toEqual(stored.runs);
  });

  it('🔒 途中の解析が別のエンジンのものなら、開始で行を消して世代を進める（続きに重ねない）', async () => {
    const kifu = await newKifu(user);
    await browserChunk(user, kifu.displayNo, 0, 0, 3, OTHER_ENGINE);
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 0, positions: 3 });

    // 開始を通さない別のエンジンの報告は破棄する（1 つの解析に混ぜない）
    expect(await browserChunk(user, kifu.displayNo, 0, 3, 1, ENGINE)).toEqual({ status: 'ignored' });
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 0, positions: 3 });

    const restarted = await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE));
    expect(restarted).toMatchObject({ status: 'run', revision: 1, startMoveNumber: 0 });
    expect(await stateOf(kifu.id)).toMatchObject({ revision: 1, positions: 0, exists: false });

    // 前の世代を掴んだ側の報告は破棄される
    expect(await browserChunk(user, kifu.displayNo, 0, 3, 1, OTHER_ENGINE)).toEqual({ status: 'ignored' });
    // 新しい世代は 0 から。同じエンジンでの開始し直しはやり直さない
    expect(await browserChunk(user, kifu.displayNo, 1, 0, 2, ENGINE)).toEqual({ status: 'applied', completed: false });
    expect(await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE))).toMatchObject({
      status: 'run',
      revision: 1,
      startMoveNumber: 2,
    });
  });

  it('範囲外・不連続のチャンクは書かない', async () => {
    const kifu = await newKifu(user);
    expect(await browserChunk(user, kifu.displayNo, 0, POSITIONS, 1)).toEqual({ status: 'out-of-range' });
    expect(await browserChunk(user, kifu.displayNo, 0, 2, 1)).toEqual({ status: 'not-contiguous' });
    expect(await stateOf(kifu.id)).toMatchObject({ positions: 0, exists: false });
  });

  it('失敗の記録: 同じ世代・quick が未完了のときだけ。記録した後は開始が failed・チャンクは破棄', async () => {
    const kifu = await newKifu(user);
    const target = { ownerId: user, no: kifu.displayNo };
    const fail = (revision: number) =>
      asUser(user, (tx) =>
        recordAnalysisFailure(tx, target, { revision, error: 'engine died', assignee: 'browser', stage: 'quick' }),
      );
    expect(await fail(5)).toEqual({ applied: false });
    expect(await fail(0)).toEqual({ applied: true });
    expect(await stateOf(kifu.id)).toMatchObject({ error: 'engine died' });
    expect(await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE))).toEqual({ status: 'failed' });
    expect(await browserChunk(user, kifu.displayNo, 0, 0, 1)).toEqual({ status: 'ignored' });

    // 完了済みの棋譜に遅れて届いた失敗は記録しない
    const done = await newKifu(user);
    await browserChunk(user, done.displayNo, 0, 0, POSITIONS);
    expect(
      await asUser(user, (tx) =>
        recordAnalysisFailure(tx, { ownerId: user, no: done.displayNo }, {
          revision: 0,
          error: 'late',
          assignee: 'browser',
          stage: 'quick',
        }),
      ),
    ).toEqual({ applied: false });
    expect((await stateOf(done.id)).error).toBeNull();
  });

  it('指し手列の無い棋譜は解析の対象にならない', async () => {
    const kifu = await newKifu(user, { usiMoves: null });
    expect(await asUser(user, (tx) => startBrowserAnalysis(tx, user, kifu.displayNo, ENGINE))).toEqual({
      status: 'unanalyzable',
    });
  });

  it('未解析の棋譜の番号: 未完了・失敗なし・指し手列ありだけを新しい順に', async () => {
    const fresh = await insertUser();
    const old = await newKifu(fresh, { playedAt: new Date('2020-01-01T00:00:00Z') });
    const recent = await newKifu(fresh, { playedAt: new Date('2026-01-01T00:00:00Z') });
    const partial = await newKifu(fresh, { playedAt: new Date('2023-01-01T00:00:00Z') });
    await browserChunk(fresh, partial.displayNo, 0, 0, 1);
    const done = await newKifu(fresh);
    await browserChunk(fresh, done.displayNo, 0, 0, POSITIONS);
    const failed = await newKifu(fresh);
    await asUser(fresh, (tx) =>
      recordAnalysisFailure(tx, { ownerId: fresh, no: failed.displayNo }, {
        revision: 0,
        error: 'e',
        assignee: 'browser',
        stage: 'quick',
      }),
    );
    await newKifu(fresh, { usiMoves: null });

    expect(await asUser(fresh, (tx) => pendingBrowserKifuNos(tx, fresh, 20))).toEqual([
      recent.displayNo,
      partial.displayNo,
      old.displayNo,
    ]);
    expect(await asUser(fresh, (tx) => pendingBrowserKifuNos(tx, fresh, 1))).toEqual([recent.displayNo]);
    // 担当が worker のユーザー（所有者）には空
    expect(await asUser(OWNER, (tx) => pendingBrowserKifuNos(tx, OWNER, 20))).toEqual([]);
  });
});

describe('所有者スコープ: 他人の番号は「無い」（prd/14 §4）', () => {
  it('開始・チャンク・失敗のどれも、他人の棋譜には届かない', async () => {
    const a = await insertUser();
    const b = await insertUser();
    // A は 2 局、B は 1 局。B が 2 番を指すと「無い」、1 番を指すと自分の棋譜
    await newKifu(a);
    const target = await newKifu(a);
    const mine = await newKifu(b);
    expect([target.displayNo, mine.displayNo]).toEqual([2, 1]);

    expect(await asUser(b, (tx) => startBrowserAnalysis(tx, b, target.displayNo, ENGINE))).toBeNull();
    expect(await browserChunk(b, target.displayNo, 0, 0, 1)).toEqual({ status: 'not-found' });
    expect(
      await asUser(b, (tx) =>
        recordAnalysisFailure(tx, { ownerId: b, no: target.displayNo }, {
          revision: 0,
          error: 'e',
          assignee: 'browser',
          stage: 'quick',
        }),
      ),
    ).toBeNull();
    expect(await stateOf(target.id)).toMatchObject({ revision: 0, positions: 0, error: null });

    // 同じ番号でも自分の棋譜を指す（A の 1 番ではない）
    expect(await browserChunk(b, 1, 0, 0, 1)).toEqual({ status: 'applied', completed: false });
    const [row] = await db
      .select({ kifuId: kifuAnalyses.kifuId, ownerId: kifuAnalyses.ownerId })
      .from(kifuAnalyses)
      .where(eq(kifuAnalyses.ownerId, b));
    expect(row).toEqual({ kifuId: mine.id, ownerId: b });
    expect(await asUser(b, (tx) => pendingBrowserKifuNos(tx, b, 20))).toEqual([1]);
  });
});

describe('手元 worker の取得は担当 worker のユーザーの棋譜だけ（prd/14 §5.7）', () => {
  it('poll と quickPending は、担当 browser のユーザーの棋譜を返さない', async () => {
    // 担当 browser のユーザーの、いちばん古い未解析の棋譜
    const browserUser = await insertUser();
    const theirs = await newKifu(browserUser, { playedAt: new Date('1890-01-01T00:00:00Z') });
    // 所有者（担当 worker）の未解析の棋譜（それより新しいが、他のどの棋譜よりも古い）
    const mine = await newKifu(OWNER, { playedAt: new Date('1900-01-01T00:00:00Z') });

    const polled = (await (await workerGet('/api/worker/kifus?quick=1')).json()) as { id: number; profile: string } | null;
    expect(polled).toMatchObject({ id: mine.id, profile: 'quick' });
    expect(polled?.id).not.toBe(theirs.id);
    const jobs = (await (await workerGet('/api/worker/position-jobs')).json()) as { quickPending: boolean };
    expect(jobs.quickPending).toBe(true);

    // 所有者を browser にすると、担当 worker のユーザーが 1 人もいなくなる（worker は所有者だけ）。
    // 未解析の棋譜が残っていても、手元 worker には何も渡らず、full も止めない
    await switchOwner('browser');
    expect(await (await workerGet('/api/worker/kifus?quick=1')).json()).toBeNull();
    expect(await (await workerGet('/api/worker/kifus')).json()).toBeNull();
    expect(await (await workerGet('/api/worker/position-jobs')).json()).toMatchObject({ quickPending: false });

    await switchOwner('worker');
    expect(await (await workerGet('/api/worker/kifus?quick=1')).json()).toMatchObject({ id: mine.id });
    // 後片付け: 他のファイルの poll の順に影響しないよう、極端に古い日付の棋譜を消す
    await db.delete(kifus).where(eq(kifus.id, mine.id));
    await db.delete(kifus).where(eq(kifus.id, theirs.id));
  });
});

describe('ログインの経路の API（所有者として。prd/14 §5.7・§5.8）', () => {
  const START = { engineBuild: ENGINE.engineBuild, evalHash: ENGINE.evalHash };
  const chunkBody = (revision: number, from: number, count: number) => ({
    revision,
    ...ENGINE,
    engineName: 'YaneuraOu',
    fvScale: 16,
    threads: 4,
    hashMb: 64,
    movetimeMs: 300,
    analyses: positions(from, count),
  });

  it('GET /api/me が担当と「worker を選べるか」を返す', async () => {
    expect(await (await app.request('/api/me')).json()).toEqual({
      userId: OWNER,
      analysisAssignee: 'worker',
      canChooseWorker: true,
    });
  });

  it('担当が worker の間: 開始は 409・チャンクと失敗は 201 applied:false・未解析の一覧は空', async () => {
    const kifu = await newKifu(OWNER);
    const base = `/api/kifus/${kifu.displayNo}/analysis`;
    expect((await app.request(`${base}/start`, ownerJson('POST', START))).status).toBe(409);
    const chunk = await app.request(`${base}/chunks`, ownerJson('POST', chunkBody(0, 0, 1)));
    expect([chunk.status, await chunk.json()]).toEqual([201, { ok: true, applied: false, completed: false }]);
    const error = await app.request(`${base}/error`, ownerJson('POST', { revision: 0, error: 'e' }));
    expect([error.status, await error.json()]).toEqual([201, { ok: true, applied: false }]);
    expect(await (await app.request('/api/analysis/pending')).json()).toEqual({ kifuNos: [] });
    expect(await stateOf(kifu.id)).toMatchObject({ positions: 0, error: null });
  });

  it('切り替え → 開始 → チャンク → 完了まで通る。browser の間は検討盤の評価の要求が 403', async () => {
    const kifu = await newKifu(OWNER);
    const base = `/api/kifus/${kifu.displayNo}/analysis`;

    const switched = await app.request('/api/users/me/analysis-assignee', ownerJson('PUT', { assignee: 'browser' }));
    expect([switched.status, await switched.json()]).toEqual([200, { ok: true, analysisAssignee: 'browser', changed: true }]);
    const again = await app.request('/api/users/me/analysis-assignee', ownerJson('PUT', { assignee: 'browser' }));
    expect(await again.json()).toEqual({ ok: true, analysisAssignee: 'browser', changed: false });
    expect(await (await app.request('/api/me')).json()).toMatchObject({ analysisAssignee: 'browser', canChooseWorker: true });

    const pending = (await (await app.request('/api/analysis/pending?limit=50')).json()) as { kifuNos: number[] };
    expect(pending.kifuNos).toContain(kifu.displayNo);

    const start = await app.request(`${base}/start`, ownerJson('POST', START));
    expect(start.status).toBe(200);
    const started = (await start.json()) as { status: string; revision: number; startMoveNumber: number; usiMoves: string[] };
    // 切り替えで世代が 1 つ進んでいる
    expect(started).toMatchObject({ status: 'run', revision: 1, startMoveNumber: 0, usiMoves: MOVES, settings: BROWSER_ANALYSIS_SETTINGS });

    const chunk = await app.request(`${base}/chunks`, ownerJson('POST', chunkBody(started.revision, 0, POSITIONS)));
    expect([chunk.status, await chunk.json()]).toEqual([201, { ok: true, applied: true, completed: true }]);
    expect(await stateOf(kifu.id)).toMatchObject({ profile: 'quick', completed: true, positions: POSITIONS });
    expect((await (await app.request(`${base}/start`, ownerJson('POST', START))).json())).toEqual({ status: 'complete' });

    // 番号の無い棋譜は 404
    expect((await app.request('/api/kifus/2147483000/analysis/start', ownerJson('POST', START))).status).toBe(404);
    expect(
      (await app.request('/api/kifus/2147483000/analysis/chunks', ownerJson('POST', chunkBody(0, 0, 1)))).status,
    ).toBe(404);
    expect(
      (await app.request('/api/kifus/2147483000/analysis/error', ownerJson('POST', { revision: 0, error: 'e' }))).status,
    ).toBe(404);

    // 🔒 検討盤の評価の要求は担当 worker のユーザーだけ（手元 worker にジョブを積む口）
    const sfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w -';
    expect((await app.request('/api/positions/evaluate', ownerJson('POST', { sfen }))).status).toBe(403);

    const back = await app.request('/api/users/me/analysis-assignee', ownerJson('PUT', { assignee: 'worker' }));
    expect(await back.json()).toEqual({ ok: true, analysisAssignee: 'worker', changed: true });
    expect((await app.request('/api/positions/evaluate', ownerJson('POST', { sfen }))).status).not.toBe(403);
  });

  it('検証: 候補手 2 本・長すぎる読み筋・多すぎる局面・形の違う手は 400（何も書かない）', async () => {
    const kifu = await newKifu(OWNER);
    const url = `/api/kifus/${kifu.displayNo}/analysis/chunks`;
    const withCandidates = (candidates: unknown[]) => ({ ...chunkBody(0, 0, 1), analyses: [{ moveNumber: 0, candidates }] });
    const bad = [
      withCandidates([cand(), { ...cand(), rank: 2 }]),
      withCandidates([{ ...cand(), pv: Array.from({ length: 129 }, () => '7g7f') }]),
      withCandidates([{ ...cand(), move: 'drop table' }]),
      { ...chunkBody(0, 0, 1), analyses: positions(0, 33) },
      { ...chunkBody(0, 0, 1), engineBuild: 'x' },
    ];
    for (const body of bad) {
      expect((await app.request(url, ownerJson('POST', body))).status).toBe(400);
    }
    // 詰まされた局面の resign・空の move は通る（担当が worker なので applied:false だが、検証は通っている）
    const resign = withCandidates([{ ...cand('resign'), scoreType: 'mate', scoreValue: 0 }]);
    expect((await app.request(url, ownerJson('POST', resign))).status).toBe(201);
    expect((await app.request(url, ownerJson('POST', withCandidates([{ ...cand(), move: '', pv: [] }])))).status).toBe(201);
    expect(await stateOf(kifu.id)).toMatchObject({ positions: 0 });
  });

  it('🔒 Origin が無い・信頼しないオリジンの書き込みは 403（担当も解析も変わらない）', async () => {
    const kifu = await newKifu(OWNER);
    for (const origin of [null, 'https://evil.example.test']) {
      expect(
        (await app.request('/api/users/me/analysis-assignee', ownerJson('PUT', { assignee: 'browser' }, origin))).status,
      ).toBe(403);
      expect(
        (await app.request(`/api/kifus/${kifu.displayNo}/analysis/start`, ownerJson('POST', START, origin))).status,
      ).toBe(403);
    }
    expect(await db.transaction((tx) => analysisAssigneeOf(tx, OWNER))).toBe('worker');
  });
});
