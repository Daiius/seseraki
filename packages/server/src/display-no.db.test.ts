/**
 * 棋譜の番号（`kifus.displayNo`。prd/14 §4.4）を実 Postgres で確かめる。`pnpm --filter server test:db`。
 *
 * 1. 採番: 所有者ごとの連番・同じユーザーの取り込みは順に並ぶ（他のユーザーは待たない）・消した番号は再利用しない
 * 2. 🔒 **web 向けの API（ログインの経路）の応答に、棋譜・出題・解答の内部 ID が出ないこと**。
 *    アプリ（`route.ts` の `app`）に実際にリクエストを流し、応答の JSON 全体を調べる。
 *    ログインの経路のルートを**すべて**叩いていることも `app.routes` と突き合わせる
 *    （ルートを足したらここに足さないと落ちる）
 *
 * ⚠ 所有者ゲート（prd/07 §5.1）があるので、API は所有者（"1"）として叩く。DATABASE はファイル間で共有なので、
 *   所有者の行には他のテストが入れた棋譜も混ざる（それも含めて内部 ID が出ないことを見る）。
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { client, db } from './db/index.js';
import { drills, kifus, kifuTactics, users } from './db/schema.js';
import { insertKifu } from './kifu-number.js';
import { encodeCandidates, type CandidateMove } from './kifu-analysis-detail.js';
import { saveAnalysis } from './kifu-analysis-store.js';
import { replacePositions } from './positions.js';
import { withUserTx } from './user-tx.js';
import { getClearToken, resetProgress, setProgress } from './analysis-progress.js';
import { resetEvaluations, startEvaluation } from './position-eval.js';

const OWNER = '1';
const MOVES = ['7g7f', '3c3d', '2g2f'];
// 初期局面から 7g7f を指した局面（局面検索の基準に使う）
const AFTER_7G7F = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w -';
// どの棋譜も通らない局面（評価ジョブを待たせる）
const UNSEEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/P8/1PPPPPPPP/1B5R1/LNSGKGSNL w -';

const cand = (move: string, scoreValue: number, rank: number): CandidateMove => ({
  rank,
  move,
  scoreType: 'cp',
  scoreValue,
  pv: null,
  depth: 1,
});

async function insertUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
    .returning({ id: users.id });
  return row.id;
}

/** 最小の棋譜を 1 局（番号は採番を通す） */
const plainKifu = (ownerId: string) =>
  db.transaction((tx) => insertKifu(tx, { title: 't', kifText: '', ownerId }));

const counterOf = async (userId: string) =>
  (await db.select({ n: users.lastKifuNo }).from(users).where(eq(users.id, userId)))[0].n;

afterAll(async () => {
  resetProgress();
  resetEvaluations();
  await client.end();
});

describe('採番（prd/14 §4.4）', () => {
  it('所有者ごとに 1 から振る（他のユーザーの取り込みは番号を進めない）', async () => {
    const a = await insertUser();
    const b = await insertUser();
    const a1 = await plainKifu(a);
    const b1 = await plainKifu(b);
    const a2 = await plainKifu(a);
    expect([a1.displayNo, b1.displayNo, a2.displayNo]).toEqual([1, 1, 2]);
    expect(await counterOf(a)).toBe(2);
    expect(await counterOf(b)).toBe(1);
  });

  it('🔒 消した番号は再利用しない（末尾を消しても次は +1。欠番を許す）', async () => {
    const { deleteKifu } = await import('./kifu-queries.js');
    const a = await insertUser();
    await plainKifu(a);
    const last = await plainKifu(a);
    expect(await withUserTx(db, a, (tx) => deleteKifu(tx, a, last.displayNo))).toBe(last.id);
    expect(await counterOf(a)).toBe(2);
    expect((await plainKifu(a)).displayNo).toBe(3);
  });

  it('同じユーザーの取り込みは並行しても重ならない', async () => {
    const a = await insertUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => plainKifu(a)));
    expect(results.map((r) => r.displayNo).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  it('同じユーザーの取り込みは順に並び、他のユーザーは待たない（所有者の行のロック）', async () => {
    const a = await insertUser();
    const b = await insertUser();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allocated!: () => void;
    const allocatedOnce = new Promise<void>((resolve) => {
      allocated = resolve;
    });
    // A の取り込みをコミットせずに止めておく（A の行のロックを握ったまま）
    const first = db.transaction(async (tx) => {
      const row = await insertKifu(tx, { title: 't', kifText: '', ownerId: a });
      allocated();
      await held;
      return row;
    });
    await allocatedOnce;

    const LOCK_NOT_AVAILABLE = '55P03';
    const withLockTimeout = (ownerId: string) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        return insertKifu(tx, { title: 't', kifText: '', ownerId });
      });
    // 同じユーザー（A）は待たされる（ロックが取れずに時間切れ）
    const blocked = await withLockTimeout(a).then(
      () => null,
      (err: { cause?: { code?: string }; code?: string }) => (err.cause ?? err).code,
    );
    expect(blocked).toBe(LOCK_NOT_AVAILABLE);
    // 他のユーザー（B）は待たない
    expect((await withLockTimeout(b)).displayNo).toBe(1);

    release();
    expect((await first).displayNo).toBe(1);
    // 時間切れで戻した側は番号を消費していない（トランザクションごと戻る）
    expect((await plainKifu(a)).displayNo).toBe(2);
  });
});

// --- web 向けの API に内部 ID が出ないこと ---

/** 内部 ID を表すキー。**ログインの経路の応答のどこにも現れてはいけない**（下の許可を除く） */
const FORBIDDEN_KEYS = new Set(['id', 'kifuId', 'drillId', 'attemptId']);

/**
 * 内部 ID のキーを持ってよい場所（JSON のパス。`[*]` は配列の要素）。
 * - `GET /users/me` の `id`: ユーザーの ID（棋譜・出題ではない。Better Auth の UUID / 所有者は "1"）
 * - `GET /users/me` の `aliases[*].id`: 名前候補の ID。🔒 **範囲外**（prd/14 §4.4。通しの連番だが
 *   件数が少なく増え方からサービス規模は読めない。`/users/me/aliases/:id` もこの ID で指す）
 */
const ALLOWED_PATHS: Record<string, string[]> = {
  'GET /api/users/me': ['$.id', '$.aliases[*].id'],
};

/** 応答の中の、許されない内部 ID のキーのパス */
function leakedPaths(value: unknown, allowed: string[], path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leakedPaths(v, allowed, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => {
      const child = `${path}.${key}`;
      const own =
        FORBIDDEN_KEYS.has(key) && !allowed.includes(child.replace(/\[\d+\]/g, '[*]')) ? [child] : [];
      return [...own, ...leakedPaths(v, allowed, child)];
    });
  }
  return [];
}

/** 応答の中の棋譜の番号（`no` / `kifuNo`） */
function kifuNumbers(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(kifuNumbers);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) =>
      (key === 'no' || key === 'kifuNo') && typeof v === 'number' ? [v, ...kifuNumbers(v)] : kifuNumbers(v),
    );
  }
  return [];
}

interface Call {
  /** ルートの登録パス（`app.routes` の `METHOD /api/...`） */
  route: string;
  /** 実際に叩く URL と本文 */
  request: () => { url: string; init?: RequestInit };
  /** 期待するステータス */
  status: number;
}

let app: Hono;
/** 所有者の棋譜（解析済み・局面索引・戦型・出題つき） */
let analyzed: { id: number; displayNo: number };
let drillId: number;
let pendingJobId: string;
/** POST /kifus で作った棋譜の番号（再解析・削除はこれで行う） */
let posted: number | undefined;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Origin の検査がある書き込み口（ブラウザ解析の受け口・担当の切り替え・出題の解答。prd/14 §5.8）用 */
const jsonFromBrowser = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify(body),
});

/** ブラウザ解析の来歴（エンジンのビルド識別と評価関数のハッシュ） */
const ENGINE = { engineBuild: 'c1b80eaa-0123456789ab', evalHash: 'a'.repeat(64) };

const drillPath = () => `/api/drills/${analyzed.displayNo}/0/best`;

/** 叩く順に並べる（作る → 読む → 書き換える → 消す） */
const CALLS: Call[] = [
  { route: 'GET /api/me', request: () => ({ url: '/api/me' }), status: 200 },
  {
    route: 'POST /api/kifus',
    request: () => ({
      url: '/api/kifus',
      init: json('POST', { kifText: '手合割：平手\n先手：a\n後手：b\n1 ７六歩(77)\n' }),
    }),
    status: 201,
  },
  { route: 'GET /api/kifus', request: () => ({ url: '/api/kifus' }), status: 200 },
  { route: 'GET /api/kifus/:no', request: () => ({ url: `/api/kifus/${analyzed.displayNo}` }), status: 200 },
  { route: 'GET /api/stats/tactics', request: () => ({ url: '/api/stats/tactics' }), status: 200 },
  { route: 'GET /api/users/me', request: () => ({ url: '/api/users/me' }), status: 200 },
  { route: 'GET /api/positions', request: () => ({ url: '/api/positions' }), status: 200 },
  {
    route: 'GET /api/positions/subject',
    request: () => ({ url: `/api/positions/subject?pos=${encodeURIComponent(AFTER_7G7F)}&side=sente` }),
    status: 200,
  },
  {
    route: 'GET /api/positions/similar',
    request: () => ({ url: `/api/positions/similar?pos=${encodeURIComponent(AFTER_7G7F)}` }),
    status: 200,
  },
  {
    route: 'POST /api/positions/evaluate',
    request: () => ({ url: '/api/positions/evaluate', init: json('POST', { sfen: AFTER_7G7F }) }),
    status: 200,
  },
  {
    route: 'GET /api/positions/evaluate/:jobId',
    request: () => ({ url: `/api/positions/evaluate/${pendingJobId}` }),
    status: 200,
  },
  { route: 'GET /api/drills/next', request: () => ({ url: '/api/drills/next' }), status: 200 },
  { route: 'GET /api/drills/counts', request: () => ({ url: '/api/drills/counts' }), status: 200 },
  {
    route: 'GET /api/drills/:kifuNo/:moveNumber/:kind',
    request: () => ({ url: drillPath() }),
    status: 200,
  },
  {
    route: 'POST /api/drills/:kifuNo/:moveNumber/:kind/answer',
    request: () => ({ url: `${drillPath()}/answer`, init: jsonFromBrowser('POST', { line: ['7g7f'] }) }),
    status: 200,
  },
  {
    route: 'POST /api/drills/:kifuNo/:moveNumber/:kind/exclude',
    request: () => ({ url: `${drillPath()}/exclude`, init: { method: 'POST' } }),
    status: 200,
  },
  { route: 'GET /api/drills', request: () => ({ url: '/api/drills?excluded=only' }), status: 200 },
  { route: 'GET /api/drills/attempts', request: () => ({ url: '/api/drills/attempts' }), status: 200 },
  {
    route: 'POST /api/drills/:kifuNo/:moveNumber/:kind/unexclude',
    request: () => ({ url: `${drillPath()}/unexclude`, init: { method: 'POST' } }),
    status: 200,
  },
  { route: 'GET /api/analysis/progress', request: () => ({ url: '/api/analysis/progress' }), status: 200 },
  {
    route: 'PATCH /api/kifus/:no',
    request: () => ({ url: `/api/kifus/${analyzed.displayNo}`, init: json('PATCH', { memo: 'm' }) }),
    status: 200,
  },
  // --- ブラウザ解析の受け口（prd/14 §5.8）。所有者の担当は worker なので、開始は 409・報告は破棄（applied: false）---
  {
    route: 'POST /api/kifus/:no/analysis/start',
    request: () => ({ url: `/api/kifus/${posted}/analysis/start`, init: jsonFromBrowser('POST', ENGINE) }),
    status: 409,
  },
  {
    route: 'POST /api/kifus/:no/analysis/chunks',
    request: () => ({
      url: `/api/kifus/${posted}/analysis/chunks`,
      init: jsonFromBrowser('POST', {
        revision: 0,
        ...ENGINE,
        fvScale: 16,
        threads: 4,
        hashMb: 64,
        movetimeMs: 300,
        analyses: [{ moveNumber: 0, candidates: [{ ...cand('7g7f', 30, 1), pv: ['7g7f'] }] }],
      }),
    }),
    status: 201,
  },
  {
    route: 'POST /api/kifus/:no/analysis/error',
    request: () => ({
      url: `/api/kifus/${posted}/analysis/error`,
      init: jsonFromBrowser('POST', { revision: 0, error: 'engine died' }),
    }),
    status: 201,
  },
  { route: 'GET /api/analysis/pending', request: () => ({ url: '/api/analysis/pending' }), status: 200 },
  {
    // 同じ値（worker）なので何も変わらない（所有者の担当を他のテストが前提にしている）
    route: 'PUT /api/users/me/analysis-assignee',
    request: () => ({
      url: '/api/users/me/analysis-assignee',
      init: jsonFromBrowser('PUT', { assignee: 'worker' }),
    }),
    status: 200,
  },
  {
    route: 'POST /api/kifus/:no/reanalyze',
    request: () => ({ url: `/api/kifus/${posted}/reanalyze`, init: { method: 'POST' } }),
    status: 201,
  },
  {
    route: 'DELETE /api/kifus/:no',
    request: () => ({ url: `/api/kifus/${posted}`, init: { method: 'DELETE' } }),
    status: 200,
  },
];

/**
 * 叩かないルート（理由つき）。**応答に棋譜・出題の ID を返さないもの**に限る。
 * 所有者の行を書き換えると他のテストファイル（DATABASE を共有）の前提が崩れるため、ここでは流さない
 */
const NOT_CALLED: Record<string, string> = {
  'PATCH /api/users/me': '表示名の更新。応答は { ok } だけ（所有者の表示名を他のテストが見ている）',
  'POST /api/users/me/aliases': '名前候補の追加。応答は { ok, rederived } だけ（所有者の主体側を作り直してしまう）',
  'PATCH /api/users/me/aliases/:id': '名前候補（範囲外。prd/14 §4.4）。応答は { ok, rederived } だけ',
  'DELETE /api/users/me/aliases/:id': '名前候補（範囲外。prd/14 §4.4）。応答は { ok, rederived } だけ',
};

beforeAll(async () => {
  // Better Auth の設定（`auth.ts` は import 時に読む）。セッションは差し替えるので値は何でもよい
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(40);
  process.env.BETTER_AUTH_URL = 'http://localhost:5173';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const { auth } = await import('./auth.js');
  (auth.api as { getSession: unknown }).getSession = vi.fn(async () => ({ user: { id: OWNER } }));
  app = (await import('./route.js')).app as unknown as Hono;

  // 🔒 **内部 ID と番号を食い違わせる**（同じ値だと、番号の代わりに内部 ID を返していても見分けられない）。
  // 他のユーザーの棋譜を先に入れて、通しの連番だけを進める
  const other = await insertUser();
  for (let i = 0; i < 3; i++) await plainKifu(other);

  analyzed = await db.transaction(async (tx) => {
    const row = await insertKifu(tx, {
      title: 'display-no',
      kifText: '',
      ownerId: OWNER,
      usiMoves: MOVES,
      sente: 'alice',
      gote: 'bob',
      result: 'SENTE_WIN_RESIGN',
      subjectSide: 'sente',
      playedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const ref = { id: row.id, ownerId: OWNER };
    await replacePositions(tx, ref, MOVES);
    await tx.insert(kifuTactics).values({ kifuId: row.id, ownerId: OWNER, side: 'gote', label: '四間飛車', turn: 1 });
    const positions = MOVES.length + 1;
    await saveAnalysis(tx, ref, {
      runs: [
        { profile: 'full', engineName: null, movetimeMs: null, targetDepth: null, multiPv: 3, at: '2026-10-11T00:00:00.000Z' },
      ],
      detail: Array.from({ length: positions }, () => [
        0,
        encodeCandidates([cand('7g7f', 30, 1), cand('2g2f', 20, 2), cand('6i7h', 10, 3)]),
      ]),
      fullCount: positions,
    });
    await tx
      .update(kifus)
      .set({ analysisCompletedAt: new Date(), analysisProfile: 'full' })
      .where(eq(kifus.id, row.id));
    return row;
  });

  const [drill] = await db
    .insert(drills)
    .values({
      kifuId: analyzed.id,
      ownerId: OWNER,
      moveNumber: 0,
      kind: 'best',
      reason: 'own_blunder',
      answerMove: '7g7f',
      answerScoreType: 'cp',
      answerScoreValue: 30,
      answerPv: ['7g7f'],
      candidates: [
        { rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 30 },
        { rank: 2, move: '2g2f', scoreType: 'cp', scoreValue: 20 },
      ],
      matePlies: null,
      playedMove: '7g7f',
      playedLossCp: 0,
      analysisRevision: 0,
      blunderCp: 600,
      mateMaxPlies: 10,
      generatorRev: 't',
    })
    .returning({ id: drills.id });
  drillId = drill.id;

  // 解析中の進捗（worker の報告が入れる形）と、待ちの評価ジョブ
  setProgress(
    { kifuId: analyzed.id, kifuNo: analyzed.displayNo, ownerId: OWNER, revision: 0, profile: 'full', analyzed: 1, total: 4 },
    getClearToken(),
  );
  const started = startEvaluation({ sfen: UNSEEN, move: null }, OWNER);
  if (started.state !== 'pending') throw new Error('評価ジョブは待ちのはず');
  pendingJobId = started.jobId;
});

describe('🔒 web 向けの API に内部 ID を出さない（prd/14 §4.4）', () => {
  it('前提: 内部 ID と番号が食い違っている（同じ値だと検査が空振りする）', () => {
    expect(analyzed.id).not.toBe(analyzed.displayNo);
    expect(drillId).toBeGreaterThan(0);
  });

  it('ログインの経路のルートをすべて叩いている（ルートを足したら CALLS に足す）', () => {
    const routes = new Set(
      app.routes
        .filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`)
        // 全員ぶんの経路（API_KEY。内部経路なので内部 ID のまま）と Better Auth
        .filter((r) => !/ \/api\/(worker|auth|dev)(\/|$)/.test(r))
        .filter((r) => r !== 'POST /api/video-analysis/kifus'),
    );
    const covered = new Set([...CALLS.map((c) => c.route), ...Object.keys(NOT_CALLED)]);
    expect([...routes].filter((r) => !covered.has(r)).sort()).toEqual([]);
    expect([...covered].filter((r) => !routes.has(r)).sort()).toEqual([]);
  });

  it.each(CALLS.map((c) => [c.route, c] as const))('%s', async (route, call) => {
    const { url, init } = call.request();
    const res = await app.request(url, init);
    const body: unknown = await res.json();
    expect({ route, status: res.status, body }).toMatchObject({ route, status: call.status });

    expect(leakedPaths(body, ALLOWED_PATHS[route] ?? [])).toEqual([]);

    // 番号として返す値は、所有者の棋譜の番号でなければならない（内部 ID をすり替えて返していない）
    const owned = new Set(
      (await db.select({ no: kifus.displayNo }).from(kifus).where(eq(kifus.ownerId, OWNER))).map((r) => r.no),
    );
    if (route === 'DELETE /api/kifus/:no' && posted !== undefined) owned.add(posted);
    expect(kifuNumbers(body).filter((n) => !owned.has(n))).toEqual([]);

    if (route === 'POST /api/kifus') {
      posted = (body as { no: number }).no;
      expect(posted).toBeGreaterThan(analyzed.displayNo);
    }
  });

  it('番号で返していることを個別にも確かめる', async () => {
    // ⚠ 題で絞って引く。DATABASE はファイル間で共有なので、所有者の棋譜が 1 ページ（50 件）を超えると
    // 絞らない一覧の 1 ページ目にこの棋譜が載らない（ファイルの順は実行ごとに変わりうる）
    const list = (await (await app.request('/api/kifus?q=display-no')).json()) as {
      kifus: { no: number; title: string }[];
    };
    expect(list.kifus.find((k) => k.title === 'display-no')?.no).toBe(analyzed.displayNo);
    const detail = (await (await app.request(`/api/kifus/${analyzed.displayNo}`)).json()) as { no: number };
    expect(detail.no).toBe(analyzed.displayNo);
    // 内部 ID では引けない（所有者の番号として解釈され、その番号の棋譜は無い）
    const owned = new Set(
      (await db.select({ no: kifus.displayNo }).from(kifus).where(eq(kifus.ownerId, OWNER))).map((r) => r.no),
    );
    if (!owned.has(analyzed.id)) {
      expect((await app.request(`/api/kifus/${analyzed.id}`)).status).toBe(404);
    }
    const progress = (await (await app.request('/api/analysis/progress')).json()) as { kifuNo: number };
    expect(progress.kifuNo).toBe(analyzed.displayNo);
  });

  it('番号の引数は正の整数だけ（それ以外は 400）', async () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '99999999999']) {
      expect((await app.request(`/api/kifus/${bad}`)).status).toBe(400);
    }
    expect((await app.request('/api/drills/1/0/tsume')).status).toBe(400);
  });
});
