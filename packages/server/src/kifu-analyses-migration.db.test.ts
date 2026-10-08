/**
 * 解析結果の詰め替え（prd/16 §7）のマイグレーションを実 Postgres で確かめる。
 *
 * 実行ごとに専用の DATABASE を作り、**詰め替えより前のマイグレーションだけ**を当てて旧形式
 * （`move_analyses` / `candidate_moves`）の行を入れ、詰め替えのマイグレーションを当てて結果を見る。
 * `minMate*` は SQL（マイグレーション）と TS（`minMateBySide`）の 2 か所にあるので、ここで突き合わせる。
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  decodeAll,
  minMateBySide,
  type AnalysisDetail,
  type AnalysisRun,
} from './kifu-analysis-detail.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const migrations = readdirSync(migrationsFolder).sort();
const target = migrations.findIndex((name) => name.endsWith('_kifu_analyses'));
const sqlOf = (name: string) => readFileSync(`${migrationsFolder}/${name}/migration.sql`, 'utf8');

const base = new URL(inject('testAdminUrl'));
let admin: pg.Client;
const created: string[] = [];

/** 詰め替えの直前まで当てた DATABASE に繋いだクライアント */
async function databaseBeforeTarget(): Promise<pg.Client> {
  const name = `seseraki_ka_${randomBytes(5).toString('hex')}`;
  await admin.query(`create database "${name}"`);
  created.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  // マイグレーションは 1 本ずつトランザクションに入れて当てる（migrator と同じ）
  for (const m of migrations.slice(0, target)) await applyMigration(client, m);
  return client;
}

async function applyMigration(client: pg.Client, name: string) {
  await client.query('begin');
  try {
    await client.query(sqlOf(name));
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

async function insertKifu(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `insert into kifus (title, kif_text, owner_id) values ('t', '', '1') returning id`,
  );
  return Number(rows[0].id);
}

interface OldPosition {
  moveNumber: number;
  profile: 'quick' | 'full';
  movetimeMs: number;
  createdAt: string;
  candidates: [move: string, scoreType: 'cp' | 'mate', scoreValue: number, pv: string[] | null][];
}

async function insertOld(client: pg.Client, kifuId: number, positions: OldPosition[]) {
  for (const p of positions) {
    const { rows } = await client.query<{ id: string }>(
      `insert into move_analyses (kifu_id, move_number, profile, engine_name, movetime_ms, multi_pv, created_at)
       values ($1, $2, $3, 'YaneuraOu', $4, 3, $5) returning id`,
      [kifuId, p.moveNumber, p.profile, p.movetimeMs, p.createdAt],
    );
    for (const [i, [move, scoreType, scoreValue, pv]] of p.candidates.entries()) {
      await client.query(
        `insert into candidate_moves (move_analysis_id, rank, move, score_type, score_value, pv, depth)
         values ($1, $2, $3, $4, $5, $6, 20)`,
        [rows[0].id, i + 1, move, scoreType, scoreValue, pv === null ? null : JSON.stringify(pv)],
      );
    }
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
});

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

describe('解析結果の詰め替え（prd/16 §7）', () => {
  it('詰め替えのマイグレーションがある', () => {
    expect(target).toBeGreaterThan(0);
  });

  it('局面・候補手・来歴・時刻を失わずに 1 行へ詰め、minMate は TS の計算と一致する', async () => {
    const client = await databaseBeforeTarget();
    const T1 = '2026-09-01T00:00:00.000000Z';
    const T2 = '2026-09-02T00:00:00.000000Z';
    const T3 = '2026-09-03T00:00:00.123456Z';
    const analyzed = await insertKifu(client);
    const untouched = await insertKifu(client);
    await insertOld(client, analyzed, [
      // full は先頭からの連続区間（0・1 は T2 の submit、2 は T3 の submit）
      { moveNumber: 0, profile: 'full', movetimeMs: 1000, createdAt: T2, candidates: [['7g7f', 'mate', 7, ['7g7f']], ['2g2f', 'cp', 10, null]] },
      { moveNumber: 1, profile: 'full', movetimeMs: 1000, createdAt: T2, candidates: [['3c3d', 'mate', 3, ['3c3d', '8h2b+']]] },
      { moveNumber: 2, profile: 'full', movetimeMs: 1000, createdAt: T3, candidates: [] },
      // quick（T1）。詰まされる側の mate と、rank 2 の短い mate は数えない
      { moveNumber: 3, profile: 'quick', movetimeMs: 100, createdAt: T1, candidates: [['8c8d', 'mate', -2, null]] },
      { moveNumber: 4, profile: 'quick', movetimeMs: 100, createdAt: T1, candidates: [['2f2e', 'mate', 5, null], ['1g1f', 'mate', 1, null]] },
    ]);

    await applyMigration(client, migrations[target]);

    const { rows } = await client.query<{
      kifu_id: string;
      full_count: number;
      runs: AnalysisRun[];
      detail: AnalysisDetail;
      min_mate_sente: number | null;
      min_mate_gote: number | null;
    }>('select * from kifu_analyses order by kifu_id');
    // 未解析の棋譜は行を持たない
    expect(rows.map((r) => Number(r.kifu_id))).toEqual([analyzed]);
    const [row] = rows;
    expect(untouched).not.toBe(analyzed);

    expect(row.full_count).toBe(3);
    // 🔒 来歴も時刻も失わない（(時刻, 段階, 来歴) の組ごとに 1 件。時刻順）
    expect(row.runs).toEqual([
      { profile: 'quick', engineName: 'YaneuraOu', movetimeMs: 100, targetDepth: null, multiPv: 3, at: T1 },
      { profile: 'full', engineName: 'YaneuraOu', movetimeMs: 1000, targetDepth: null, multiPv: 3, at: T2 },
      { profile: 'full', engineName: 'YaneuraOu', movetimeMs: 1000, targetDepth: null, multiPv: 3, at: T3 },
    ]);

    const decoded = decodeAll(row.detail, row.runs);
    expect(decoded.map((p) => [p.moveNumber, p.run.profile, p.run.at])).toEqual([
      [0, 'full', T2],
      [1, 'full', T2],
      [2, 'full', T3],
      [3, 'quick', T1],
      [4, 'quick', T1],
    ]);
    expect(decoded[0].candidates).toEqual([
      { rank: 1, move: '7g7f', scoreType: 'mate', scoreValue: 7, pv: ['7g7f'], depth: 20 },
      { rank: 2, move: '2g2f', scoreType: 'cp', scoreValue: 10, pv: null, depth: 20 },
    ]);
    expect(decoded[2].candidates).toEqual([]);

    // SQL の計算と TS の計算が揃っている（先手番: 7・5 → 5 / 後手番: 3。-2 と rank 2 は数えない）
    expect({ sente: row.min_mate_sente, gote: row.min_mate_gote }).toEqual(minMateBySide(row.detail));
    expect(minMateBySide(row.detail)).toEqual({ sente: 5, gote: 3 });

    // 旧 2 表は消える
    const { rows: tables } = await client.query<{ name: string }>(
      `select tablename as name from pg_tables where schemaname = 'public' and tablename in ('move_analyses', 'candidate_moves')`,
    );
    expect(tables).toEqual([]);

    // 圧縮の指定が入っている（prd/16 §2）
    const { rows: compression } = await client.query<{ c: string }>(
      `select attcompression as c from pg_attribute where attrelid = 'kifu_analyses'::regclass and attname = 'detail'`,
    );
    expect(compression[0].c).toBe('l');
    await client.end();
  });

  it('🔴 full が先頭からの連続区間でない棋譜があれば止まり、何も変えない', async () => {
    const client = await databaseBeforeTarget();
    const kifuId = await insertKifu(client);
    const T = '2026-09-01T00:00:00.000Z';
    await insertOld(client, kifuId, [
      { moveNumber: 0, profile: 'quick', movetimeMs: 100, createdAt: T, candidates: [['7g7f', 'cp', 0, null]] },
      { moveNumber: 1, profile: 'full', movetimeMs: 1000, createdAt: T, candidates: [['3c3d', 'cp', 0, null]] },
    ]);

    await expect(applyMigration(client, migrations[target])).rejects.toThrow(String(kifuId));

    const { rows } = await client.query<{ n: string }>('select count(*) as n from move_analyses');
    expect(Number(rows[0].n)).toBe(2);
    const { rows: ka } = await client.query(`select to_regclass('kifu_analyses') as t`);
    expect(ka[0].t).toBeNull();
    await client.end();
  });

  it('🔴 局面に隙間がある棋譜があれば止まる', async () => {
    const client = await databaseBeforeTarget();
    const kifuId = await insertKifu(client);
    const T = '2026-09-01T00:00:00.000Z';
    await insertOld(client, kifuId, [
      { moveNumber: 0, profile: 'quick', movetimeMs: 100, createdAt: T, candidates: [] },
      { moveNumber: 2, profile: 'quick', movetimeMs: 100, createdAt: T, candidates: [] },
    ]);
    await expect(applyMigration(client, migrations[target])).rejects.toThrow(String(kifuId));
    await client.end();
  });

  it('🔴 候補手の rank が 1 からの連番でない局面があれば止まり、何も変えない', async () => {
    const client = await databaseBeforeTarget();
    const T = '2026-09-01T00:00:00.000Z';
    const three: OldPosition['candidates'] = [
      ['7g7f', 'cp', 30, null],
      ['2g2f', 'cp', 20, null],
      ['6i7h', 'cp', 10, null],
    ];
    const notFromOne = await insertKifu(client);
    const withGap = await insertKifu(client);
    const fine = await insertKifu(client);
    for (const kifuId of [notFromOne, withGap, fine]) {
      await insertOld(client, kifuId, [
        { moveNumber: 0, profile: 'full', movetimeMs: 1000, createdAt: T, candidates: three },
      ]);
    }
    // rank 2・3 だけ（1 始まりでない）/ rank 1・3（欠番）。詰めるとどちらも rank が書き換わる
    const drop = (kifuId: number, rank: number) =>
      client.query(
        `delete from candidate_moves where rank = $2 and move_analysis_id in
           (select id from move_analyses where kifu_id = $1)`,
        [kifuId, rank],
      );
    await drop(notFromOne, 1);
    await drop(withGap, 2);

    const err = await applyMigration(client, migrations[target]).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('rank');
    expect(err?.message).toContain(String(notFromOne));
    expect(err?.message).toContain(String(withGap));
    expect(err?.message).not.toContain(String(fine));

    const { rows } = await client.query<{ n: string }>('select count(*) as n from candidate_moves');
    expect(Number(rows[0].n)).toBe(7);
    const { rows: ka } = await client.query(`select to_regclass('kifu_analyses') as t`);
    expect(ka[0].t).toBeNull();
    await client.end();
  });
});
