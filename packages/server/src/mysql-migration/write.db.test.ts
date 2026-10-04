/**
 * データ移行の Postgres 側（prd/15 §6）を実 Postgres で確かめる（`pnpm --filter server test:db`）。
 *
 * **MySQL は使わない。** 移行元は `MigrationSource` を満たす行の注入で、行の形は mysql2 の読み取りが返す形
 * （日時・JSON は文字列、`tinyint(1)` は 0 / 1）に合わせる。
 *
 * 移行先は「0000 適用直後の空の DB」でないと始まらないので、共有の DATABASE は使わず、
 * **テストごとに DATABASE を作ってマイグレーションを当てる**（roles.db.test.ts と同じ作り方）。
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { MIGRATED_TABLES } from './plan.js';
import {
  assertTargetPristine,
  canCommit,
  migrateInto,
  TargetNotReadyError,
  type MigrationSource,
} from './write.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const base = new URL(inject('testAdminUrl'));

let admin: pg.Client;
const created: string[] = [];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
});

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

/** 0000 を当てた空の DATABASE を作って繋ぐ（所有者の仮の行 "1" だけがある状態） */
async function freshTarget(): Promise<pg.Client> {
  const name = `seseraki_mig_${randomBytes(5).toString('hex')}`;
  await admin.query(`create database "${name}"`);
  created.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await migrate(drizzle({ client: pool }), { migrationsFolder });
  await pool.end();
  // 時刻帯を UTC 以外にして、timestamptz の読み書きが接続の時刻帯に依存しないことも見る
  const client = new pg.Client({ connectionString: url.toString(), options: '-c TimeZone=Asia/Tokyo' });
  await client.connect();
  return client;
}

type Row = Record<string, unknown>;

/** 表の全列を持つ行（与えなかった列は null。mysql2 は NULL の列もキーを持って返す） */
function row(table: string, values: Row): Row {
  const plan = MIGRATED_TABLES.find((t) => t.name === table)!;
  return Object.fromEntries(plan.columns.map((c) => [c.name, values[c.name] ?? null]));
}

/** 行を 2 行ずつの束で返す移行元（束の切れ目をまたぐ処理も通す）。件数は行から数える */
function memorySource(data: Record<string, Row[]>, countsOverride: Record<string, number> = {}): MigrationSource {
  return {
    async counts(tables) {
      return Object.fromEntries(tables.map((t) => [t, countsOverride[t] ?? (data[t]?.length ?? 0)]));
    },
    async *rows(table, columns) {
      const rows = data[table] ?? [];
      for (let i = 0; i < rows.length; i += 2) {
        yield rows.slice(i, i + 2).map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
      }
    },
  };
}

const T = '2026-01-02 03:04:05';

/** 一揃いの正しいデータ（全表に 1 行以上。drill_attempts は空で、空の表の setval を見る） */
function validData(): Record<string, Row[]> {
  return {
    users: [
      row('users', {
        id: '1',
        name: 'Owner',
        email: 'owner@example.com',
        emailVerified: 1,
        displayName: 'だいじ',
        createdAt: '2025-05-01 00:00:00',
        updatedAt: '2026-01-01 12:00:00',
      }),
      row('users', {
        id: '0b7c3c0e-0000-4000-8000-000000000001',
        name: 'Other',
        email: 'other@example.com',
        emailVerified: 0,
        displayName: 'other',
        createdAt: T,
        updatedAt: T,
      }),
    ],
    account: [
      row('account', {
        id: 'acc-1',
        userId: '1',
        providerId: 'google',
        accountId: 'sub-1',
        accessTokenExpiresAt: T,
        createdAt: T,
        updatedAt: T,
      }),
    ],
    user_aliases: [
      row('user_aliases', { id: 5, userId: '1', name: 'Daiius', validFrom: '2024-01-01', createdAt: T }),
      row('user_aliases', { id: 9, userId: '1', name: 'daiius', createdAt: T }),
    ],
    kifus: [
      row('kifus', {
        id: 10,
        title: 'a',
        kifText: 'k',
        usiMoves: '["7g7f","3c3d"]',
        playedAt: '2025-12-31 15:00:00',
        sourceTz: 'JST',
        analysisProfile: 'full',
        analysisRevision: 2,
        source: 'swars',
        ownerId: '1',
        subjectSide: 'sente',
        createdAt: T,
        updatedAt: T,
      }),
      row('kifus', { id: 12, title: 'b', kifText: 'k', analysisRevision: 0, source: 'video', ownerId: '1', createdAt: T, updatedAt: T }),
      row('kifus', { id: 13, title: 'c', kifText: 'k', analysisRevision: 0, source: 'manual', ownerId: '1', createdAt: T, updatedAt: T }),
    ],
    video_kifu_sources: [
      row('video_kifu_sources', {
        kifuId: 12,
        videoId: 'vid',
        gameIndex: 1,
        startedAtSec: 0,
        endedAtSec: 30,
        bottomIsSente: 1,
        extractorRev: 'abc',
        raw: '{"moves":[{"usi":"7g7f","time":1.5}]}',
        createdAt: T,
        updatedAt: T,
      }),
    ],
    move_analyses: [
      row('move_analyses', { id: 100, kifuId: 10, moveNumber: 0, profile: 'full', multiPv: 3, createdAt: T }),
      row('move_analyses', { id: 101, kifuId: 10, moveNumber: 1, profile: 'quick', createdAt: T }),
    ],
    candidate_moves: [
      row('candidate_moves', { id: 1000, moveAnalysisId: 100, rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 50, pv: '["7g7f"]', depth: 20 }),
      row('candidate_moves', { id: 1001, moveAnalysisId: 100, rank: 2, move: '2g2f', scoreType: 'mate', scoreValue: -3, depth: 20 }),
    ],
    kifu_tactics: [row('kifu_tactics', { kifuId: 10, side: 'both', label: '相居飛車', turn: 20 })],
    drills: [
      row('drills', {
        id: 50,
        kifuId: 10,
        moveNumber: 1,
        kind: 'mate',
        reason: 'missed_mate',
        answerMove: '7g7f',
        answerScoreType: 'mate',
        answerScoreValue: 3,
        answerPv: '["7g7f"]',
        candidates: '[{"rank":1,"move":"7g7f","scoreType":"mate","scoreValue":3}]',
        matePlies: 3,
        analysisRevision: 2,
        blunderCp: 300,
        mateMaxPlies: 9,
        generatorRev: 'r1',
        createdAt: T,
        updatedAt: T,
      }),
    ],
    drill_attempts: [],
  };
}

async function inTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

describe('migrateInto', () => {
  it('全表を元の ID のまま運び、所有者の仮の行を置き換え、採番を合わせる', async () => {
    const client = await freshTarget();
    try {
      await client.query('begin');
      await assertTargetPristine(client);
      const report = await migrateInto(client, memorySource(validData()), { batchRows: 2 });
      expect(report.violations).toEqual([]);
      expect(report.mismatches).toEqual([]);
      expect(canCommit(report)).toBe(true);
      expect(report.targetCounts).toMatchObject({ users: 2, kifus: 3, drill_attempts: 0 });
      // 採番の続き: max + 1。空の表は 1
      expect(report.sequences).toMatchObject({ kifus: 14, user_aliases: 10, move_analyses: 102, drill_attempts: 1 });
      await client.query('commit');

      // 所有者の行は仮の値から移行元の値へ（updatedAt は明示した値が残る。トリガーに上書きされない）
      const { rows: owner } = await client.query('select * from users where id = $1', ['1']);
      expect(owner[0]).toMatchObject({ email: 'owner@example.com', displayName: 'だいじ', emailVerified: true });
      expect((owner[0].updatedAt as Date).toISOString()).toBe('2026-01-01T12:00:00.000Z');

      // 日時は MySQL の壁時計を UTC として運ぶ（接続は Asia/Tokyo でも同じ instant）
      const { rows: k } = await client.query('select * from kifus where id = 10');
      expect((k[0].playedAt as Date).toISOString()).toBe('2025-12-31T15:00:00.000Z');
      expect(k[0].usiMoves).toEqual(['7g7f', '3c3d']);
      const { rows: v } = await client.query('select * from video_kifu_sources');
      expect(v[0]).toMatchObject({ bottomIsSente: true, raw: { moves: [{ usi: '7g7f', time: 1.5 }] } });
      const { rows: a } = await client.query('select "validFrom"::text as "validFrom" from user_aliases where id = 5');
      expect(a[0].validFrom).toBe('2024-01-01');

      // 採番を合わせたので、ID を指定しない挿入が衝突しない
      const { rows: n } = await client.query(
        `insert into kifus (title, "kifText", "ownerId") values ('new', '', '1') returning id`,
      );
      expect(Number(n[0].id)).toBe(14);
      const { rows: d } = await client.query(
        `insert into drill_attempts ("drillId") values (50) returning id`,
      );
      expect(Number(d[0].id)).toBe(1);

      // 二重実行は始まる前に止まる
      await expect(assertTargetPristine(client)).rejects.toThrow(TargetNotReadyError);
    } finally {
      await client.end();
    }
  });

  it('制約違反は止まらずに全部列挙する（束の中の正しい行は入る）', async () => {
    const client = await freshTarget();
    try {
      const data = validData();
      data.kifus.push(
        row('kifus', { id: 20, title: 'bad tz', kifText: 'k', sourceTz: 'PST', analysisRevision: 0, source: 'manual', ownerId: '1', createdAt: T, updatedAt: T }),
        row('kifus', { id: 21, title: 'bad rev', kifText: 'k', analysisRevision: -1, source: 'manual', ownerId: '1', createdAt: T, updatedAt: T }),
        row('kifus', { id: 22, title: 'bad date', kifText: 'k', analysisRevision: 0, source: 'manual', ownerId: '1', playedAt: '0000-00-00 00:00:00', createdAt: T, updatedAt: T }),
      );
      // 親の無い行（FK）と、mate なのに matePlies が無い出題（意味の制約）
      data.move_analyses.push(row('move_analyses', { id: 102, kifuId: 999, moveNumber: 0, profile: 'quick', createdAt: T }));
      data.drills.push(
        row('drills', {
          ...data.drills[0],
          id: 51,
          moveNumber: 2,
          matePlies: null,
        }),
      );

      const report = await inTransaction(client, () =>
        migrateInto(client, memorySource(data), { batchRows: 3 }),
      );
      const found = report.violations
        .map((v) => [v.table, v.key, v.constraint, v.code])
        .sort((a, b) => MIGRATED_TABLES.findIndex((t) => t.name === a[0]) - MIGRATED_TABLES.findIndex((t) => t.name === b[0]) || String(a[1]).localeCompare(String(b[1])));
      expect(found).toEqual([
        ['kifus', 'id=20', 'kifus_source_tz_check', '23514'],
        ['kifus', 'id=21', 'kifus_analysis_revision_nonneg', '23514'],
        ['kifus', 'id=22', 'conversion', undefined],
        ['move_analyses', 'id=102', expect.stringContaining('fk'), '23503'],
        ['drills', 'id=51', 'drills_mate_plies_iff_mate', '23514'],
      ]);
      // 違反した行の分だけ件数が合わない。正しい行は入っている
      expect(report.targetCounts.kifus).toBe(3);
      expect(report.mismatches.map((m) => m.table)).toEqual(['kifus', 'move_analyses', 'drills']);
      expect(canCommit(report)).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('dry-run（ROLLBACK）の後は移行先が元のまま', async () => {
    const client = await freshTarget();
    try {
      await inTransaction(client, async () => {
        await assertTargetPristine(client);
        const report = await migrateInto(client, memorySource(validData()));
        expect(canCommit(report)).toBe(true);
      });
      await assertTargetPristine(client);
      const { rows } = await client.query('select email from users');
      expect(rows).toEqual([{ email: 'owner-1@example.invalid' }]);
    } finally {
      await client.end();
    }
  });

  it('件数が移行元と合わなければ確定させない', async () => {
    const client = await freshTarget();
    try {
      const report = await inTransaction(client, () =>
        migrateInto(client, memorySource(validData(), { candidate_moves: 3 })),
      );
      expect(report.violations).toEqual([]);
      expect(report.mismatches).toEqual([{ table: 'candidate_moves', source: 3, target: 2 }]);
      expect(canCommit(report)).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('移行元に所有者の行が無ければ違反として出す', async () => {
    const client = await freshTarget();
    try {
      const data = validData();
      data.users = data.users.filter((u) => u.id !== '1');
      const report = await inTransaction(client, () => migrateInto(client, memorySource(data)));
      expect(report.violations).toContainEqual(expect.objectContaining({ table: 'users', constraint: 'owner_missing' }));
      expect(canCommit(report)).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe('assertTargetPristine', () => {
  it('マイグレーションが当たっていない DB では始めない', async () => {
    const name = `seseraki_mig_${randomBytes(5).toString('hex')}`;
    await admin.query(`create database "${name}"`);
    created.push(name);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await expect(assertTargetPristine(client)).rejects.toThrow(/マイグレーション/);
    } finally {
      await client.end();
    }
  });

  it('移さない表（session）に行があっても始めない', async () => {
    const client = await freshTarget();
    try {
      await client.query(
        `insert into session (token, "userId", "expiresAt") values ('t', '1', now())`,
      );
      await expect(assertTargetPristine(client)).rejects.toThrow(/session が空ではない/);
    } finally {
      await client.end();
    }
  });
});
