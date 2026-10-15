/**
 * 出題の採点を担当で分ける（prd/13 §5.3・prd/14 §5.7）を実 Postgres で確かめる。`pnpm --filter server test:db`。
 *
 * 1. 担当 `worker`: 候補の外の答えは手元 worker にジョブを積む（202 `pending`）。ブラウザの評価を付けても使わない
 * 2. 担当 `browser`: ジョブを積まず「名指しで読んで」（200 `evaluate`）を返す。🔒 答えは何も載せない
 * 3. 結果を付けた送り直しを server が判定して記録する（次の一手・候補なし・詰将棋の別解と手順の記憶）
 * 4. 届いた評価の検証: 手が解答と違えば 400・形が違えば 400・Origin が無ければ 403
 *
 * ⚠ 所有者ゲート（prd/07 §5.1）があるので API は所有者として叩き、担当は所有者の行で切り替える。
 *   DATABASE はファイル間で共有するため、**所有者の担当は最後に必ず `worker` に戻す**。
 * ⚠ 棋譜解析の再利用（prd/12 §2.6）に当たらないよう、局面索引（`kifu_positions`）は作らない。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { buildPositions, positionSfen } from 'shared';
import { client, db } from './db/index.js';
import { drillAttempts, drills, kifus } from './db/schema.js';
import { switchAnalysisAssignee, type AnalysisAssignee } from './analysis-report.js';
import { resetProgress } from './analysis-progress.js';
import { forgetLine } from './drill-lines.js';
import { insertKifu } from './kifu-number.js';
import { claimEvaluationJob, resetEvaluations } from './position-eval.js';
import { withUserTx } from './user-tx.js';

const OWNER = '1';
const ORIGIN = 'http://localhost:5173';
/** 出題局面は 4 手目の後（ほかのファイルの棋譜と局面が重ならない手順） */
const MOVES = ['9g9f', '1c1d', '9f9e', '1d1e'];
const MOVE_NUMBER = MOVES.length;
const DRILL_SFEN = positionSfen(buildPositions(MOVES)[MOVE_NUMBER]);

const PROVENANCE = {
  engineBuild: 'c1b80eaa-0123456789ab',
  evalHash: 'a'.repeat(64),
  engineName: 'YaneuraOu',
  fvScale: 16,
  threads: 4,
  hashMb: 64,
  movetimeMs: 600,
};

let app: Hono;
let kifuId = 0;
let kifuNo = 0;
const drillIds: Record<'best' | 'mate', number> = { best: 0, mate: 0 };

const switchOwner = (next: AnalysisAssignee) =>
  withUserTx(db, OWNER, (tx) => switchAnalysisAssignee(tx, OWNER, next));

const answer = (kind: 'best' | 'mate', body: unknown, origin: string | null = ORIGIN) =>
  app.request(`/api/drills/${kifuNo}/${MOVE_NUMBER}/${kind}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

const attemptsOf = (kind: 'best' | 'mate') =>
  db
    .select({ move: drillAttempts.move, verdict: drillAttempts.verdict, lossCp: drillAttempts.lossCp })
    .from(drillAttempts)
    .where(and(eq(drillAttempts.drillId, drillIds[kind])));

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(40);
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const { auth } = await import('./auth.js');
  (auth.api as { getSession: unknown }).getSession = vi.fn(async () => ({ user: { id: OWNER } }));
  app = (await import('./route.js')).app as unknown as Hono;

  const kifu = await db.transaction((tx) =>
    insertKifu(tx, { title: 'grading', kifText: '', ownerId: OWNER, usiMoves: MOVES }),
  );
  kifuId = kifu.id;
  kifuNo = kifu.displayNo;
  const common = {
    kifuId,
    ownerId: OWNER,
    moveNumber: MOVE_NUMBER,
    reason: 'own_blunder' as const,
    playedMove: '2g2f',
    playedLossCp: 0,
    analysisRevision: 0,
    blunderCp: 600,
    mateMaxPlies: 10,
    generatorRev: 't',
  };
  const rows = await db
    .insert(drills)
    .values([
      {
        ...common,
        kind: 'best',
        answerMove: '2g2f',
        answerScoreType: 'cp',
        answerScoreValue: 50,
        answerPv: ['2g2f'],
        candidates: [{ rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 50 }],
        matePlies: null,
      },
      {
        ...common,
        kind: 'mate',
        reason: 'missed_mate',
        answerMove: '2g2f',
        answerScoreType: 'mate',
        answerScoreValue: 3,
        answerPv: ['2g2f', '8c8d', '2f2e'],
        candidates: [{ rank: 1, move: '2g2f', scoreType: 'mate', scoreValue: 3 }],
        matePlies: 3,
      },
    ])
    .returning({ id: drills.id, kind: drills.kind });
  for (const row of rows) drillIds[row.kind as 'best' | 'mate'] = row.id;
  await switchOwner('worker');
});

beforeEach(() => {
  resetEvaluations();
  forgetLine(drillIds.mate);
});

afterAll(async () => {
  // 🔒 他のファイルのために、所有者の担当を worker に戻し、作った棋譜を消す（出題・解答は CASCADE）
  await switchOwner('worker');
  await db.delete(kifus).where(inArray(kifus.id, [kifuId]));
  resetProgress();
  resetEvaluations();
  await (await import('./db/system.js')).endSystemDb();
  await client.end();
});

const evaluation = (move: string, candidate: unknown) => ({ move, candidate, ...PROVENANCE });

describe('担当 worker（prd/14 §5.7）', () => {
  it('候補の外の答えは手元 worker にジョブを積む', async () => {
    const res = await answer('best', { line: ['7g7f'] });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'pending' });
    expect(claimEvaluationJob()).toMatchObject({ sfen: DRILL_SFEN, move: '7g7f' });
  });

  it('ブラウザの評価を付けてきても使わない（手元 worker で読む）', async () => {
    const res = await answer('best', {
      line: ['7g7f'],
      evaluation: evaluation('7g7f', { scoreType: 'cp', scoreValue: 40, depth: 10, pv: ['7g7f'] }),
    });
    expect(res.status).toBe(202);
  });
});

describe('担当 browser（prd/13 §5.3）', () => {
  beforeAll(async () => {
    await switchOwner('browser');
  });
  afterAll(async () => {
    await switchOwner('worker');
  });

  it('🔒 ジョブを積まず「名指しで読んで」を返す。答えは何も載せない', async () => {
    const res = await answer('best', { line: ['7g7f'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'evaluate',
      sfen: DRILL_SFEN,
      move: '7g7f',
      settings: expect.objectContaining({ movetimeMs: 600, multiPv: 1 }),
    });
    for (const key of ['answerMove', 'answerPv', 'candidates', 'playedMove', 'verdict']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(claimEvaluationJob()).toBeNull();
    expect(await attemptsOf('best')).toEqual([]);
  });

  it('候補に入る答えはその場で採点する（読ませない）', async () => {
    const res = await answer('best', { line: ['2g2f'] });
    expect(await res.json()).toMatchObject({ status: 'done', verdict: 'correct', answerMove: '2g2f' });
  });

  it('結果を付けた送り直しを server が判定し、記録する', async () => {
    const res = await answer('best', {
      line: ['7g7f'],
      evaluation: evaluation('7g7f', { scoreType: 'cp', scoreValue: -400, depth: 14, pv: ['7g7f', '3c3d', '2g2f'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'done',
      verdict: 'wrong',
      lossCp: 450,
      refutation: ['3c3d', '2g2f'],
      answerMove: '2g2f',
    });
    expect(await attemptsOf('best')).toContainEqual({ move: '7g7f', verdict: 'wrong', lossCp: 450 });
  });

  it('候補なしは盤面で判定する（王手でない手は不正解）', async () => {
    const res = await answer('best', { line: ['6g6f'], evaluation: evaluation('6g6f', null) });
    expect(await res.json()).toMatchObject({ status: 'done', verdict: 'wrong', lossCp: null });
  });

  it('🔒 評価の手が解答と違えば 400（別の手の評価で採点させない）', async () => {
    const res = await answer('best', {
      line: ['7g7f'],
      evaluation: evaluation('6g6f', { scoreType: 'cp', scoreValue: 50, depth: 10, pv: ['6g6f'] }),
    });
    expect(res.status).toBe(400);
  });

  it('形の違う評価（読み筋の先頭が別の手・範囲外の値）は 400', async () => {
    for (const candidate of [
      { scoreType: 'cp', scoreValue: 50, depth: 10, pv: ['2g2f'] },
      { scoreType: 'cp', scoreValue: 5_000_000, depth: 10, pv: ['7g7f'] },
    ]) {
      const res = await answer('best', { line: ['7g7f'], evaluation: evaluation('7g7f', candidate) });
      expect(res.status).toBe(400);
    }
  });

  it('🔒 Origin が無ければ 403', async () => {
    const res = await answer('best', { line: ['7g7f'] }, null);
    expect(res.status).toBe(403);
  });

  it('詰将棋: 手順を外れた手を名指しで読ませ、詰みなら別解として手順を引き継ぐ', async () => {
    const asked = await answer('mate', { line: ['7g7f'] });
    expect(await asked.json()).toMatchObject({ status: 'evaluate', sfen: DRILL_SFEN, move: '7g7f' });

    const alt = await answer('mate', {
      line: ['7g7f'],
      evaluation: evaluation('7g7f', { scoreType: 'mate', scoreValue: 3, depth: 10, pv: ['7g7f', '3c3d', '8h2b+'] }),
    });
    expect(await alt.json()).toEqual({ status: 'continue', reply: '3c3d' });

    // 覚えた手順をなぞる間は読ませない
    const solved = await answer('mate', { line: ['7g7f', '3c3d', '8h2b+'] });
    expect(await solved.json()).toMatchObject({ status: 'done', verdict: 'correct', answerPv: ['2g2f', '8c8d', '2f2e'] });
    expect(await attemptsOf('mate')).toContainEqual({ move: '8h2b+', verdict: 'correct', lossCp: null });
  });

  it('詰将棋: 詰まない手は不正解と咎め筋', async () => {
    const res = await answer('mate', {
      line: ['6g6f'],
      evaluation: evaluation('6g6f', { scoreType: 'cp', scoreValue: 100, depth: 10, pv: ['6g6f', '8c8d'] }),
    });
    expect(await res.json()).toMatchObject({ status: 'done', verdict: 'wrong', refutation: ['8c8d'] });
  });
});
