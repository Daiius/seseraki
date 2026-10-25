/**
 * 入口ごとの出題順・ホームの数・一覧の状態・その問題の解答履歴（prd/13 §6.4・§7.5〜§7.7）を実 Postgres で確かめる。
 * `pnpm --filter server test:db`（`TEST_DATABASE_URL` が要る）。
 *
 * 単体テスト（`drill-list-query.test.ts`）は SQL の文字列しか見ないので、`array_agg … filter` の最後の判定・
 * `now() - interval` の段・`since` の比較が DB で狙いどおりに効くかはここで見る。
 * ⚠ ファイル内のテストは同じ DATABASE を共有する。各テストは自分で作ったユーザーの行だけを見る。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, db, type Tx } from './db/index.js';
import { drillAttempts, drills, users } from './db/schema.js';
import { drillListQuerySchema, drillNextQuerySchema } from './drill-list-query.js';
import { drillCounts, listDrillAttemptsOf, listDrills, pickNextDrill } from './drill-query.js';
import { insertKifu } from './kifu-number.js';
import { withUserTx } from './user-tx.js';

afterAll(async () => {
  await client.end();
});

const MOVES = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e', '8d8e'];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

let ownerId: string;
let recentNo: number;
let oldNo: number;

/**
 * 問題の並び（すべて `best` だが d1 だけ `mate`）:
 * - d0: 直近の対局の未解答（おすすめ ②）
 * - d1: 古い対局の未解答・詰将棋（おすすめ ③）
 * - d2: 間違えた後に正解（最後の判定が正解 → 正解・おすすめ ④）
 * - d3: 正解の後に惜しい（2 日前。最後の判定が正解でない → 間違えた・おすすめ ①）
 * - d4: 1 時間前に間違えた（間違えた・おすすめには出さない）
 * - d5: 除外（どこにも出さない）
 */
beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
    .returning({ id: users.id });
  ownerId = user.id;
  const recent = await db.transaction((tx) =>
    insertKifu(tx, { title: 'recent', kifText: '', ownerId, usiMoves: MOVES, playedAt: ago(DAY) }),
  );
  const old = await db.transaction((tx) =>
    insertKifu(tx, { title: 'old', kifText: '', ownerId, usiMoves: MOVES, playedAt: new Date('2025-01-01T00:00:00Z') }),
  );
  recentNo = recent.displayNo;
  oldNo = old.displayNo;

  const drill = (kifuId: number, moveNumber: number, kind: 'mate' | 'best' = 'best') => ({
    kifuId,
    ownerId,
    moveNumber,
    kind,
    reason: kind === 'mate' ? ('missed_mate' as const) : ('own_blunder' as const),
    answerMove: '2g2f',
    answerScoreType: kind === 'mate' ? ('mate' as const) : ('cp' as const),
    answerScoreValue: kind === 'mate' ? 3 : 100,
    answerPv: kind === 'mate' ? ['2g2f', '8c8d', '2f2e'] : null,
    candidates: [],
    matePlies: kind === 'mate' ? 3 : null,
    analysisRevision: 0,
    blunderCp: 600,
    mateMaxPlies: 10,
    generatorRev: 't',
  });
  const rows = await db
    .insert(drills)
    .values([
      drill(recent.id, 0),
      drill(old.id, 1, 'mate'),
      drill(old.id, 2),
      drill(old.id, 3),
      drill(old.id, 4),
      drill(old.id, 5),
    ])
    .returning({ id: drills.id });
  const [, , d2, d3, d4, d5] = rows.map((r) => r.id);
  const attempt = (
    drillId: number,
    verdict: 'correct' | 'close' | 'wrong' | null,
    createdAt: Date,
    excluded = false,
  ) => ({ drillId, ownerId, move: verdict ? '2g2f' : null, line: verdict ? ['2g2f'] : null, verdict, createdAt, excluded });
  await db.insert(drillAttempts).values([
    attempt(d2, 'wrong', ago(6 * DAY)),
    attempt(d2, 'correct', ago(5 * DAY)),
    attempt(d3, 'correct', ago(5 * DAY)),
    attempt(d3, 'close', ago(2 * DAY)),
    attempt(d4, 'wrong', ago(HOUR)),
    attempt(d5, null, ago(3 * DAY), true),
  ]);
});

const as = <T>(fn: (tx: Tx) => Promise<T>) => withUserTx(db, ownerId, fn);
const next = (query: Record<string, string>) =>
  as((tx) => pickNextDrill(tx, ownerId, drillNextQuerySchema.parse(query)));

describe('ホームの数（prd/13 §7.5）', () => {
  it('入口ごとの在庫: おすすめは除外と間違えた直後を除く・詰将棋 / 次の一手は未解答・間違えたは最後の判定', async () => {
    expect(await as((tx) => drillCounts(tx, ownerId))).toEqual({
      total: 6,
      recommend: 4,
      mate: 1,
      best: 1,
      wrong: 2,
    });
  });
});

describe('入口ごとの出題順（prd/13 §6.4）', () => {
  it('おすすめは ① 間違えてから 1 日以上の問題から', async () => {
    expect(await next({})).toMatchObject({ kifuNo: oldNo, moveNumber: 3, wrongBefore: true });
  });

  it('この回（since 以降）に記録した問題を外すと、② 直近 30 日の未解答に進む', async () => {
    expect(await next({ since: ago(3 * DAY).toISOString() })).toMatchObject({
      kifuNo: recentNo,
      moveNumber: 0,
    });
  });

  it('詰将棋 / 次の一手はその種類の未解答だけ', async () => {
    expect(await next({ mode: 'mate' })).toMatchObject({ kifuNo: oldNo, moveNumber: 1, kind: 'mate' });
    expect(await next({ mode: 'best' })).toMatchObject({ kifuNo: recentNo, moveNumber: 0, kind: 'best' });
  });

  it('間違えた問題は最後の解答が古い順で、1 日の待ちを掛けない', async () => {
    expect(await next({ mode: 'wrong' })).toMatchObject({ moveNumber: 3 });
    // d3 をこの回に解いたことにすると、間違えた直後の d4 が出る
    expect(await next({ mode: 'wrong', since: ago(2 * DAY + HOUR).toISOString() })).toMatchObject({
      moveNumber: 4,
    });
  });

  it('在庫が尽きたら null', async () => {
    expect(await next({ mode: 'wrong', since: ago(3 * DAY).toISOString() })).toBeNull();
  });
});

describe('一覧の状態（prd/13 §7.7）', () => {
  const statusOf = async (status: string) =>
    (await as((tx) => listDrills(tx, ownerId, drillListQuerySchema.parse({ status })))).drills
      .map((d) => d.moveNumber)
      .sort();

  it('最後の判定で読み、除外は状態「除外」だけに出す', async () => {
    expect(await statusOf('all')).toEqual([0, 1, 2, 3, 4]);
    expect(await statusOf('unanswered')).toEqual([0, 1]);
    expect(await statusOf('wrong')).toEqual([3, 4]);
    expect(await statusOf('correct')).toEqual([2]);
    expect(await statusOf('excluded')).toEqual([5]);
  });

  it('行に出題局面の SFEN と状態が載り、棋譜名は載らない', async () => {
    const { drills: rows } = await as((tx) => listDrills(tx, ownerId, drillListQuerySchema.parse({})));
    const d3 = rows.find((d) => d.moveNumber === 3)!;
    expect(d3).toMatchObject({ status: 'wrong', answers: 2, excluded: false });
    expect(d3.sfen).toMatch(/ [bw] /);
    expect(d3).not.toHaveProperty('title');
  });
});

describe('その問題の解答履歴（prd/13 §7.7）', () => {
  it('新しい順で、何回目かを返す', async () => {
    const { attempts } = await as((tx) =>
      listDrillAttemptsOf(tx, ownerId, { kifuNo: oldNo, moveNumber: 3, kind: 'best' }),
    );
    expect(attempts.map((a) => [a.verdict, a.attemptNo])).toEqual([
      ['close', 2],
      ['correct', 1],
    ]);
  });

  it('除外だけの行も出す（何回目かは null）', async () => {
    const { attempts } = await as((tx) =>
      listDrillAttemptsOf(tx, ownerId, { kifuNo: oldNo, moveNumber: 5, kind: 'best' }),
    );
    expect(attempts).toMatchObject([{ verdict: null, excluded: true, attemptNo: null }]);
  });
});
