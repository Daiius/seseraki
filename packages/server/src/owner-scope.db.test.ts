/**
 * 所有者スコープ（prd/14 §4）の分離を実 Postgres で確かめる。`pnpm --filter server test:db`。
 *
 * ユーザー A・B を作り、A の棋譜・解析・局面・出題・名前候補・評価ジョブについて、**B として**
 * （`withUserTx` で `app.user_id` を B にしたトランザクションの中で）各エンドポイントが使うクエリ関数を
 * 呼ぶと、**見えない・更新できない・消せない**ことを見る。同じ関数を A として呼ぶと見える
 * （検査が空振りしていない）ことも併せて確かめる。
 *
 * ⚠ DATABASE はファイル間で共有する。A・B はこのファイルで新しく作るユーザーなので、
 * 他のテストが入れた行（所有者 "1" の棋譜など）は A・B のどちらからも見えないのが正しい。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, db, type Tx } from './db/index.js';
import {
  drillAttempts,
  drills,
  kifus,
  kifuTactics,
  userAliases,
  users,
  videoKifuSources,
} from './db/schema.js';
import {
  deleteKifu,
  getKifuDetail,
  listKifus,
  reanalyzeKifu,
  statsTactics,
  updateKifuMemo,
} from './kifu-queries.js';
import { kifuListQuerySchema } from './kifu-list-query.js';
import { statsTacticsQuerySchema } from './stats-tactics-query.js';
import {
  findPositionGames,
  findSimilarPositions,
  findSubjectGames,
  INITIAL_SFEN,
} from './position-queries.js';
import { findKifuPositionMatches, lookupKifuEvaluation } from './position-kifu-reuse.js';
import {
  drillCounts,
  listDrillAttempts,
  listDrills,
  loadDrill,
  loadDrillQuestion,
  pickNextDrill,
  unexcludeDrill,
} from './drill-query.js';
import { drillAttemptQuerySchema, drillListQuerySchema } from './drill-list-query.js';
import { encodeCandidates, type CandidateMove } from './kifu-analysis-detail.js';
import { saveAnalysis } from './kifu-analysis-store.js';
import { parsePositionKey, replacePositions } from './positions.js';
import {
  claimEvaluationJob,
  completeEvaluationJob,
  getEvaluationResult,
  resetEvaluations,
  startEvaluation,
} from './position-eval.js';
import { addAlias, countUnresolvedSubjects, removeAlias, updateAliasPeriod } from './users.js';
import { withUserTx } from './user-tx.js';
import { insertKifu, type NewKifu } from './kifu-number.js';

afterAll(async () => {
  resetEvaluations();
  await client.end();
});

const MOVES = ['7g7f', '3c3d', '2g2f'];
// 初期局面から 1 手（7g7f）進めた局面。A の棋譜だけが通る（B の棋譜は 2g2f から入る）
const AFTER_7G7F = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w -';

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

/** 棋譜 1 局と、その局面索引・戦型・解析（全局面 full・候補手 3 本）を入れる。内部 ID と番号を返す */
async function insertAnalyzedKifu(
  ownerId: string,
  moves: string[],
  values: Partial<NewKifu> = {},
): Promise<{ id: number; no: number }> {
  return db.transaction(async (tx) => {
    const row = await insertKifu(tx, {
      title: `t-${ownerId}`,
      kifText: '',
      ownerId,
      usiMoves: moves,
      sente: 'alice',
      gote: 'bob',
      // 結果コードは `SENTE_WIN_RESIGN` 等（prd/01 §3。統計は `%SENTE_WIN%` の部分一致で勝敗を読む）
      result: 'SENTE_WIN_RESIGN',
      subjectSide: 'sente',
      playedAt: new Date('2026-01-01T00:00:00Z'),
      memo: 'original',
      ...values,
    });
    const ref = { id: row.id, ownerId };
    await replacePositions(tx, ref, moves);
    // 相手（後手）側の戦型。統計の行は「相手が何を採ったか」で数える（prd/09 §2.2）
    await tx.insert(kifuTactics).values({ kifuId: row.id, ownerId, side: 'gote', label: '四間飛車', turn: 1 });
    const positions = moves.length + 1;
    await saveAnalysis(tx, ref, {
      runs: [
        {
          profile: 'full',
          engineName: null,
          movetimeMs: null,
          targetDepth: null,
          multiPv: 3,
          at: '2026-10-11T00:00:00.000Z',
        },
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
    return { id: row.id, no: row.displayNo };
  });
}

let userA: string;
let userB: string;
/**
 * 棋譜の内部 ID と番号（prd/14 §4.4）。A は動画解析の棋譜（1 番）→ 解析済みの棋譜（2 番）の順に作り、
 * B は 1 番だけを持つ。**B が A の 2 番を指すと「無い」**、B が 1 番を指すと**自分の 1 番**になる
 */
let kifuA: { id: number; no: number };
let kifuB: { id: number; no: number };
let videoKifuA: { id: number; no: number };
let drillA: number;
let aliasA: number;

/** B として流す（`app.user_id` = B のトランザクション） */
const asB = <T>(fn: (tx: Tx) => Promise<T>) => withUserTx(db, userB, fn);
/** A として流す（検査が空振りしていないことの確認用） */
const asA = <T>(fn: (tx: Tx) => Promise<T>) => withUserTx(db, userA, fn);

beforeAll(async () => {
  userA = await insertUser();
  userB = await insertUser();

  // A の動画解析の棋譜（主体側が決まらない棋譜としても数える）
  videoKifuA = await db.transaction(async (tx) => {
    const row = await insertKifu(tx, {
      title: 'video',
      kifText: '',
      ownerId: userA,
      source: 'video',
      subjectSide: null,
    });
    await tx.insert(videoKifuSources).values({
      kifuId: row.id,
      ownerId: userA,
      videoId: randomBytes(8).toString('hex'),
      gameIndex: 1,
      startedAtSec: 0,
      endedAtSec: 5,
      bottomIsSente: true,
      extractorRev: 'r',
      raw: {},
    });
    return { id: row.id, no: row.displayNo };
  });

  kifuA = await insertAnalyzedKifu(userA, MOVES);
  // B も棋譜を 1 局持つ（初期局面は両方が通る。B からは自分の棋譜だけが見えること）
  // B の対局は負け（A の勝ちが B の成績に混ざれば勝ち数で分かる）
  kifuB = await insertAnalyzedKifu(userB, ['2g2f', '8c8d'], {
    title: 'B の棋譜',
    result: 'GOTE_WIN_RESIGN',
  });

  // A の出題と「自明だった」の印
  const [drill] = await db
    .insert(drills)
    .values({
      kifuId: kifuA.id,
      ownerId: userA,
      moveNumber: 0,
      kind: 'best',
      reason: 'own_blunder',
      answerMove: '7g7f',
      answerScoreType: 'cp',
      answerScoreValue: 30,
      answerPv: null,
      candidates: [],
      matePlies: null,
      analysisRevision: 0,
      blunderCp: 600,
      mateMaxPlies: 10,
      generatorRev: 't',
    })
    .returning({ id: drills.id });
  drillA = drill.id;
  await db.insert(drillAttempts).values([
    { drillId: drillA, ownerId: userA, move: '2g2f', verdict: 'wrong', line: ['2g2f'] },
    { drillId: drillA, ownerId: userA, move: null, verdict: null, excluded: true },
  ]);

  // A の名前候補
  await db.transaction((tx) => addAlias(tx, userA, 'alice'));
  const [alias] = await db
    .select({ id: userAliases.id })
    .from(userAliases)
    .where(eq(userAliases.userId, userA));
  aliasA = alias.id;
});

describe('所有者スコープ: B から A の棋譜が見えない（prd/14 §4）', () => {
  it('番号は所有者ごと（prd/14 §4.4）', () => {
    expect([videoKifuA.no, kifuA.no, kifuB.no]).toEqual([1, 2, 1]);
  });

  it('一覧', async () => {
    const mine = await asA((tx) => listKifus(tx, userA, kifuListQuerySchema.parse({})));
    expect(mine.kifus.map((k) => k.no)).toContain(kifuA.no);

    const theirs = await asB((tx) => listKifus(tx, userB, kifuListQuerySchema.parse({})));
    expect(theirs.kifus.map((k) => k.no)).toEqual([kifuB.no]);
    expect(theirs.pagination.total).toBe(1);
  });

  it('詳細（解析・戦型も）は 404 相当（null）。同じ番号は自分の棋譜を指す', async () => {
    expect((await asA((tx) => getKifuDetail(tx, userA, kifuA.no)))?.title).toBe(`t-${userA}`);
    expect(await asB((tx) => getKifuDetail(tx, userB, kifuA.no))).toBeNull();
    // B の 1 番は B の棋譜（A の 1 番ではない）
    expect((await asB((tx) => getKifuDetail(tx, userB, videoKifuA.no)))?.title).toBe('B の棋譜');
  });

  it('統計は自分の棋譜だけを数える', async () => {
    // 主体側は保存済みの `subjectSide`（どちらも先手）を読む。A は勝ち 1 局、B は負け 1 局。
    // 動画解析の棋譜は統計から外れる（prd/10 §2.2）
    const query = statsTacticsQuerySchema.parse({});
    const mine = await asA((tx) => statsTactics(tx, userA, query));
    expect(mine.totalGames).toBe(1);
    expect(mine.rows.map((r) => [r.label, r.games, r.wins])).toEqual([['四間飛車', 1, 1]]);

    const theirs = await asB((tx) => statsTactics(tx, userB, query));
    expect(theirs.totalGames).toBe(1);
    expect(theirs.excluded).toEqual({ ambiguousSelf: 0, draw: 0, unknownResult: 0 });
    expect(theirs.rows.map((r) => [r.label, r.games, r.wins])).toEqual([['四間飛車', 1, 0]]);
  });

  it('主体側が決まらない棋譜の数', async () => {
    expect(await asA((tx) => countUnresolvedSubjects(tx, userA))).toBe(1);
    expect(await asB((tx) => countUnresolvedSubjects(tx, userB))).toBe(0);
  });
});

describe('所有者スコープ: B は A の棋譜を更新・削除・再解析できない', () => {
  it('メモの更新は false で、A の値は変わらない', async () => {
    expect(await asB((tx) => updateKifuMemo(tx, userB, kifuA.no, 'hacked'))).toBe(false);
    const [row] = await db.select({ memo: kifus.memo }).from(kifus).where(eq(kifus.id, kifuA.id));
    expect(row.memo).toBe('original');
  });

  it('再解析は null で、世代も解析も変わらない', async () => {
    const before = await db
      .select({ revision: kifus.analysisRevision })
      .from(kifus)
      .where(eq(kifus.id, kifuA.id));
    expect(await asB((tx) => reanalyzeKifu(tx, userB, kifuA.no))).toBeNull();
    const after = await db
      .select({ revision: kifus.analysisRevision })
      .from(kifus)
      .where(eq(kifus.id, kifuA.id));
    expect(after).toEqual(before);
    expect((await asA((tx) => getKifuDetail(tx, userA, kifuA.no)))!.analyses.length).toBe(MOVES.length + 1);
  });

  it('削除は null で、棋譜は残る', async () => {
    expect(await asB((tx) => deleteKifu(tx, userB, kifuA.no))).toBeNull();
    const rows = await db.select({ id: kifus.id }).from(kifus).where(eq(kifus.id, kifuA.id));
    expect(rows).toHaveLength(1);
  });
});

describe('所有者スコープ: 局面検索（prd/14 §6.3）', () => {
  const start = parsePositionKey(INITIAL_SFEN)!;
  const afterA = parsePositionKey(AFTER_7G7F)!;

  it('完全一致: 初期局面は自分の棋譜だけ、A だけが通る局面は B には無い（404）', async () => {
    const mine = await asA((tx) => findPositionGames(tx, userA, start));
    expect(mine!.games.map((g) => g.kifuNo)).toEqual([kifuA.no]);
    expect(mine!.branches.map((b) => b.move)).toEqual(['7g7f']);

    const theirs = await asB((tx) => findPositionGames(tx, userB, start));
    expect(theirs!.games.map((g) => g.kifuNo)).toEqual([kifuB.no]);
    // 枝も自分の棋譜からだけ数える（A の 7g7f は出ない）
    expect(theirs!.branches.map((b) => b.move)).toEqual(['2g2f']);

    expect(await asA((tx) => findPositionGames(tx, userA, afterA))).not.toBeNull();
    expect(await asB((tx) => findPositionGames(tx, userB, afterA))).toBeNull();
  });

  it('主体側: A だけが通る局面は B には無い。自分の棋譜だけを数える', async () => {
    expect(await asB((tx) => findSubjectGames(tx, userB, afterA, 'sente'))).toBeNull();
    const theirs = await asB((tx) => findSubjectGames(tx, userB, start, 'sente'));
    expect(new Set(theirs!.games.map((g) => g.kifuNo))).toEqual(new Set([kifuB.no]));
    expect(theirs!.truncated).toBe(false);
    expect(theirs!.unresolvedSubjects).toBe(0);
  });

  it('近い局面: A だけが通る局面は B には無い。候補も自分の棋譜だけ', async () => {
    expect(await asB((tx) => findSimilarPositions(tx, userB, afterA, { window: 4, limit: 20 }))).toBeNull();
    const mine = await asA((tx) => findSimilarPositions(tx, userA, afterA, { window: 4, limit: 20 }));
    // 候補に出るのは A の棋譜だけ（番号は所有者ごとなので、局面索引を持つ A の棋譜の番号で照らす。
    // A の 1 番は動画解析の棋譜で局面索引を持たない）
    expect(mine!.similar.every((s) => s.kifuNo === kifuA.no)).toBe(true);
  });
});

describe('所有者スコープ: 検討盤の評価で棋譜解析を再利用する問い合わせ（prd/14 §4 🔴）', () => {
  it('A だけが通る局面の解析は、B の評価に流れない', async () => {
    const mine = await asA((tx) => lookupKifuEvaluation(tx, userA, { sfen: AFTER_7G7F, move: null }));
    expect(mine?.source).toBe('kifu');
    expect(await asB((tx) => lookupKifuEvaluation(tx, userB, { sfen: AFTER_7G7F, move: null }))).toBeNull();
  });

  it('両方が通る局面でも、引くのは自分の棋譜の解析だけ', async () => {
    for (const move of [null, '7g7f', '2g2f']) {
      const matches = await asB((tx) =>
        findKifuPositionMatches(tx, userB, { sfen: INITIAL_SFEN, move }),
      );
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((m) => m.kifuId === kifuB.id)).toBe(true);
    }
  });
});

describe('所有者スコープ: 出題（prd/13・prd/14 §4）', () => {
  it('B には A の問題が出ず、名指し（棋譜の番号・手数・種類）でも開けない', async () => {
    const ref = { kifuNo: kifuA.no, moveNumber: 0, kind: 'best' as const };
    expect(await asA((tx) => loadDrill(tx, userA, ref))).not.toBeNull();
    expect(await asB((tx) => pickNextDrill(tx, userB))).toBeNull();
    expect(await asB((tx) => loadDrill(tx, userB, ref))).toBeNull();
    expect(await asB((tx) => loadDrillQuestion(tx, userB, ref))).toBeNull();
  });

  it('件数・一覧・解答履歴に A のぶんが入らない', async () => {
    expect(await asB((tx) => drillCounts(tx, userB))).toEqual({ total: 0, answered: 0, correct: 0 });
    expect((await asB((tx) => listDrills(tx, userB, drillListQuerySchema.parse({})))).pagination.total).toBe(0);
    expect(
      (await asB((tx) => listDrillAttempts(tx, userB, drillAttemptQuerySchema.parse({})))).pagination.total,
    ).toBe(0);
    // A からは見える（空振りしていない）
    expect((await asA((tx) => drillCounts(tx, userA))).total).toBe(1);
  });

  it('「自明だった」の取り消しは A の印を消さない', async () => {
    await asB((tx) => unexcludeDrill(tx, userB, drillA));
    const marks = await db
      .select({ id: drillAttempts.id })
      .from(drillAttempts)
      .where(eq(drillAttempts.drillId, drillA));
    expect(marks).toHaveLength(2);
  });
});

describe('所有者スコープ: 名前候補（prd/14 §4）', () => {
  it('B は A の名前候補の期間を変えられない', async () => {
    expect(
      await asB((tx) => updateAliasPeriod(tx, userB, aliasA, { validFrom: '2000-01-01', validTo: '2000-01-02' })),
    ).toBe(false);
    const [row] = await db
      .select({ validFrom: userAliases.validFrom, validTo: userAliases.validTo })
      .from(userAliases)
      .where(eq(userAliases.id, aliasA));
    expect(row).toEqual({ validFrom: null, validTo: null });
  });

  it('B は A の名前候補を消せない', async () => {
    expect(await asB((tx) => removeAlias(tx, userB, aliasA))).toBe(false);
    const rows = await db.select({ id: userAliases.id }).from(userAliases).where(eq(userAliases.id, aliasA));
    expect(rows).toHaveLength(1);
  });

  it('A は自分の名前候補を変えられる（検査が空振りしていない）', async () => {
    expect(
      await asA((tx) => updateAliasPeriod(tx, userA, aliasA, { validFrom: null, validTo: null })),
    ).toBe(true);
  });
});

describe('所有者スコープ: 評価ジョブ（prd/14 §4.2）', () => {
  it('B は A の評価ジョブを取れない（待ち中も完了後も 404 相当）', () => {
    resetEvaluations();
    const started = startEvaluation({ sfen: AFTER_7G7F, move: '3c3d' }, userA);
    if (started.state !== 'pending') throw new Error('pending のはず');
    expect(getEvaluationResult(started.jobId, userB)).toEqual({ state: 'unknown' });
    const job = claimEvaluationJob()!;
    completeEvaluationJob(job.id, { candidates: [], fallback: false });
    expect(getEvaluationResult(started.jobId, userB)).toEqual({ state: 'unknown' });
    expect(getEvaluationResult(started.jobId, userA).state).toBe('settled');
  });
});

describe('ユーザーとして開くトランザクション（user-tx.ts）', () => {
  it('app.user_id はトランザクションの間だけ設定され、終われば残らない', async () => {
    const inside = await withUserTx(db, userB, async (tx) => {
      const result = await tx.execute<{ v: string | null }>(
        "select current_setting('app.user_id', true) as v",
      );
      return result.rows[0].v;
    });
    expect(inside).toBe(userB);
    // プールの接続を使い回しても漏れない（未設定は NULL、一度設定した接続では空文字に戻る）
    const after = await client.query<{ v: string | null }>(
      "select current_setting('app.user_id', true) as v",
    );
    expect([null, '']).toContain(after.rows[0].v);
  });
});
