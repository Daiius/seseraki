/**
 * 入口ごとの出題順・ホームの数・一覧の状態・その問題の解答履歴（prd/13 §6.4・§7.5〜§7.7）を実 Postgres で確かめる。
 * `pnpm --filter server test:db`（`TEST_DATABASE_URL` が要る）。
 *
 * 単体テスト（`drill-list-query.test.ts`）は SQL の文字列しか見ないので、`array_agg … filter` の最後の判定・
 * `now() - interval` の段・`since` の比較が DB で狙いどおりに効くかはここで見る。
 * ⚠ ファイル内のテストは同じ DATABASE を共有する。各テストは自分で作ったユーザーの行だけを見る。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, db, type Tx } from './db/index.js';
import { drillAttempts, drills, kifus, users } from './db/schema.js';
import { drillDailyQuerySchema, drillListQuerySchema, drillNextQuerySchema } from './drill-list-query.js';
import {
  drillCounts,
  drillCountsByKifu,
  drillDailyCorrect,
  listDrillAttemptsOf,
  listDrills,
  ownsKifuNo,
  pickNextDrill,
} from './drill-query.js';
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

/** 問題の行（答えの中身はこのテストでは見ない） */
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
    // 2 日前の d3 が 1 時間前の d4 より先
    expect(await next({ mode: 'wrong' })).toMatchObject({ moveNumber: 3 });

    // 1 日の待ちを掛けないこと: 間違えた直後の問題だけを持つ別のユーザーで見る。
    // ⚠ 上のユーザーでは確かめられない——d3 だけを since で外そうとすると、それより新しい d4 の記録も
    // since 以降になり、この回に記録した問題として一緒に外れる（§7.6 の規則どおり）
    const [other] = await db
      .insert(users)
      .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
      .returning({ id: users.id });
    const kifu = await db.transaction((tx) =>
      insertKifu(tx, { title: 't', kifText: '', ownerId: other.id, usiMoves: MOVES }),
    );
    const [only] = await db
      .insert(drills)
      .values({
        kifuId: kifu.id,
        ownerId: other.id,
        moveNumber: 2,
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
      })
      .returning({ id: drills.id });
    await db.insert(drillAttempts).values({
      drillId: only.id,
      ownerId: other.id,
      move: '2g2f',
      line: ['2g2f'],
      verdict: 'wrong',
      createdAt: ago(HOUR),
    });
    const nextOf = (query: Record<string, string>) =>
      withUserTx(db, other.id, (tx) => pickNextDrill(tx, other.id, drillNextQuerySchema.parse(query)));
    expect(await nextOf({ mode: 'wrong' })).toMatchObject({ kifuNo: kifu.displayNo, moveNumber: 2 });
    // おすすめには間違えた直後は出さない
    expect(await nextOf({})).toBeNull();
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

describe('入口「この対局」と棋譜ごとの問題の数（prd/13 §6.4・§7.10・§7.11）', () => {
  it('その棋譜のまだ正解していない問題を、手数の小さい順に出す（除外は出さない）', async () => {
    // old の問題: d1（1・詰将棋・未解答）・d2（2・正解済み）・d3（3・惜しい）・d4（4・1 時間前に間違えた）・d5（5・除外）
    const kifu = { mode: 'kifu', kifuNo: String(oldNo) };
    expect(await next(kifu)).toMatchObject({ kifuNo: oldNo, moveNumber: 1, kind: 'mate' });
    // 別の棋譜の問題は出さない
    expect(await next({ mode: 'kifu', kifuNo: String(recentNo) })).toMatchObject({ kifuNo: recentNo, moveNumber: 0 });
  });

  it('正解済みを飛ばし・間違えた直後も出し・同じ手数なら詰将棋が先・記録した問題はこの回には出さない', async () => {
    const k = await db.transaction((tx) =>
      insertKifu(tx, { title: 'same-ply', kifText: '', ownerId, usiMoves: MOVES, playedAt: ago(DAY) }),
    );
    const [solved0, best2, mate2, best1, wrong3] = (
      await db
        .insert(drills)
        .values([drill(k.id, 0), drill(k.id, 2), drill(k.id, 2, 'mate'), drill(k.id, 1), drill(k.id, 3)])
        .returning({ id: drills.id })
    ).map((r) => r.id);
    const record = (drillId: number, verdict: 'correct' | 'wrong', createdAt?: Date) =>
      db.insert(drillAttempts).values({ drillId, ownerId, move: '2g2f', line: ['2g2f'], verdict, createdAt });
    // 回の前の記録: 手数 0 は正解済み・手数 3 は 1 時間前に間違えた
    await record(solved0, 'correct', ago(2 * HOUR));
    await record(wrong3, 'wrong', ago(HOUR));
    // この回の開始は前の記録より後（DB と手元の時計のずれを避けて、少し前に置く）
    const since = ago(30 * 60 * 1000).toISOString();
    const kifu = { mode: 'kifu', kifuNo: String(k.displayNo), since };
    expect(await next(kifu)).toMatchObject({ moveNumber: 1, kind: 'best' });
    await record(best1, 'correct');
    expect(await next(kifu)).toMatchObject({ moveNumber: 2, kind: 'mate' });
    await record(mate2, 'wrong');
    expect(await next(kifu)).toMatchObject({ moveNumber: 2, kind: 'best' });
    await record(best2, 'correct');
    // 間違えた直後（1 日の待ち）でも出す
    expect(await next(kifu)).toMatchObject({ moveNumber: 3, kind: 'best' });
    await record(wrong3, 'correct');
    expect(await next(kifu)).toBeNull();
    // 新しい回（since なし）なら、まだ正解していない問題（この回で間違えた詰将棋）だけ
    expect(await next({ mode: 'kifu', kifuNo: String(k.displayNo) })).toMatchObject({ moveNumber: 2, kind: 'mate' });

    const counts = await as((tx) => drillCountsByKifu(tx, ownerId, [k.id]));
    expect(counts.get(k.id)).toEqual({ total: 5, correct: 4 });
  });

  it('棋譜ごとの問題の数は除外を数えない・正解は最後の判定・問題の無い棋譜は入らない', async () => {
    const ids = await db
      .select({ id: kifus.id, no: kifus.displayNo })
      .from(kifus)
      .where(eq(kifus.ownerId, ownerId));
    const idOf = (no: number) => ids.find((r) => r.no === no)!.id;
    const counts = await as((tx) => drillCountsByKifu(tx, ownerId, [idOf(oldNo), idOf(recentNo)]));
    // old: d1〜d4（d5 は除外）。正解は d2 だけ（d3 は正解の後に惜しい）
    expect(counts.get(idOf(oldNo))).toEqual({ total: 4, correct: 1 });
    expect(counts.get(idOf(recentNo))).toEqual({ total: 1, correct: 0 });
    expect(await as((tx) => drillCountsByKifu(tx, ownerId, []))).toEqual(new Map());
  });

  it('入口「この対局」の 404 の判定は所有者の棋譜だけ', async () => {
    expect(await as((tx) => ownsKifuNo(tx, ownerId, oldNo))).toBe(true);
    expect(await as((tx) => ownsKifuNo(tx, ownerId, 99999))).toBe(false);
  });
});

describe('日ごとの正解の数（prd/13 §7.11）', () => {
  it('その時刻帯の日で区切り、正解した問題だけを 1 問 1 回で数える・0 の日も返す', async () => {
    const [user] = await db
      .insert(users)
      .values({ name: 'n', email: `${randomUUID()}@example.invalid`, displayName: 'd' })
      .returning({ id: users.id });
    const uid = user.id;
    const k = await db.transaction((tx) =>
      insertKifu(tx, { title: 'daily', kifText: '', ownerId: uid, usiMoves: MOVES, playedAt: ago(DAY) }),
    );
    const [a, b, c] = (
      await db
        .insert(drills)
        .values([0, 1, 2].map((n) => ({ ...drill(k.id, n), ownerId: uid })))
        .returning({ id: drills.id })
    ).map((r) => r.id);
    // 東京の今日の 0 時（UTC の瞬間）
    const JST = 9 * HOUR;
    const midnight = new Date(Math.floor((Date.now() + JST) / DAY) * DAY - JST);
    const at = (ms: number) => new Date(midnight.getTime() + ms);
    const row = (drillId: number, verdict: 'correct' | 'close' | 'wrong', createdAt: Date) => ({
      drillId,
      ownerId: uid,
      move: '2g2f',
      line: ['2g2f'],
      verdict,
      createdAt,
    });
    await db.insert(drillAttempts).values([
      // 今日: a を 2 回正解（1 問）・b を正解・c は不正解と惜しい（数えない）
      row(a, 'correct', at(1000)),
      row(a, 'correct', at(2000)),
      row(b, 'correct', at(3000)),
      row(c, 'wrong', at(4000)),
      row(c, 'close', at(5000)),
      // 昨日の 23:59:59（東京）
      row(c, 'correct', at(-1000)),
      // 3 日前（days=3 の窓の外）
      row(b, 'correct', at(-3 * DAY + 1000)),
    ]);
    const daily = (tz: string, days: number) =>
      withUserTx(db, uid, (tx) => drillDailyCorrect(tx, uid, drillDailyQuerySchema.parse({ tz, days: String(days) })));
    const ymd = (d: Date) => new Date(d.getTime() + JST).toISOString().slice(0, 10);
    expect(await daily('Asia/Tokyo', 3)).toEqual([
      { date: ymd(at(-2 * DAY)), correct: 0 },
      { date: ymd(at(-DAY)), correct: 1 },
      { date: ymd(midnight), correct: 2 },
    ]);
    // 既定は 28 日
    expect(await withUserTx(db, uid, (tx) => drillDailyCorrect(tx, uid, drillDailyQuerySchema.parse({ tz: 'Asia/Tokyo' })))).toHaveLength(28);
  });

  it('知らない時刻帯は受け付けない', () => {
    expect(drillDailyQuerySchema.safeParse({ tz: 'Mars/Olympus' }).success).toBe(false);
    expect(drillDailyQuerySchema.safeParse({ tz: 'Asia/Tokyo', days: '61' }).success).toBe(false);
  });
});
