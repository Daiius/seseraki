/**
 * 所有者の埋め戻し（prd/14 §4.1）のマイグレーションを実 Postgres で確かめる。
 *
 * 実行ごとに専用の DATABASE を作り、**埋め戻しより前のマイグレーションだけ**を当てて既存の行を入れ、
 * 埋め戻しのマイグレーションを当てて結果を見る（空の DATABASE に全部当てる `postgres.db.test.ts` では
 * 埋め戻しの UPDATE が 1 行も走らないため）。
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const migrations = readdirSync(migrationsFolder).sort();
const target = migrations.findIndex((name) => name.endsWith('_owner_scope'));
const sqlOf = (name: string) => readFileSync(`${migrationsFolder}/${name}/migration.sql`, 'utf8');

const base = new URL(inject('testAdminUrl'));
let admin: pg.Client;
const created: string[] = [];

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

/** 埋め戻しの直前まで当てた DATABASE に繋いだクライアント */
async function databaseBeforeTarget(): Promise<pg.Client> {
  const name = `seseraki_os_${randomBytes(5).toString('hex')}`;
  await admin.query(`create database "${name}"`);
  created.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  for (const m of migrations.slice(0, target)) await applyMigration(client, m);
  return client;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
});

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

describe('所有者の埋め戻し（prd/14 §4.1）', () => {
  it('埋め戻しのマイグレーションがある', () => {
    expect(target).toBeGreaterThan(0);
  });

  it('既存の子の行に親の所有者を埋め、updated_at は変えない（レビュー OCL-03235CFA）', async () => {
    const client = await databaseBeforeTarget();
    const PAST = '2020-01-01T00:00:00.000Z';
    const other = (
      await client.query<{ id: string }>(
        `insert into users (name, email, display_name) values ('n', 'other@example.invalid', 'd') returning id`,
      )
    ).rows[0].id;
    const kifuId = Number(
      (
        await client.query<{ id: string }>(
          `insert into kifus (title, kif_text, owner_id, source) values ('t', '', $1, 'video') returning id`,
          [other],
        )
      ).rows[0].id,
    );
    await client.query(
      `insert into video_kifu_sources (kifu_id, video_id, game_index, started_at_sec, ended_at_sec,
         bottom_is_sente, extractor_rev, raw, created_at, updated_at)
       values ($1, 'v', 1, 0, 5, true, 'r', '{}', $2, $2)`,
      [kifuId, PAST],
    );
    await client.query(
      `insert into kifu_analyses (kifu_id, full_count, runs, detail, created_at, updated_at)
       values ($1, 0, '[]', '[]', $2, $2)`,
      [kifuId, PAST],
    );
    const drillId = (
      await client.query<{ id: string }>(
        `insert into drills (kifu_id, move_number, kind, reason, answer_move, answer_score_type,
           answer_score_value, candidates, analysis_revision, blunder_cp, mate_max_plies, generator_rev,
           created_at, updated_at)
         values ($1, 0, 'best', 'own_blunder', '2g2f', 'cp', 100, '[]', 0, 600, 10, 't', $2, $2)
         returning id`,
        [kifuId, PAST],
      )
    ).rows[0].id;
    await client.query(`insert into drill_attempts (drill_id, excluded) values ($1, true)`, [drillId]);
    await client.query(
      `insert into kifu_tactics (kifu_id, side, label, turn) values ($1, 'sente', '四間飛車', 1)`,
      [kifuId],
    );
    await client.query(
      `insert into kifu_positions (kifu_id, move_number, move, sfen_hash, sente_sfen_hash, gote_sfen_hash,
         board, hands, side_to_move)
       values ($1, 0, null, $2, $2, $2, $3, $4, 'b')`,
      [kifuId, Buffer.alloc(8, 1), Buffer.alloc(81, 1), Buffer.alloc(14, 0)],
    );

    await applyMigration(client, migrations[target]);

    const owners = await client.query<{ t: string; owner_id: string }>(`
      select 'video_kifu_sources' as t, owner_id from video_kifu_sources
      union all select 'kifu_analyses', owner_id from kifu_analyses
      union all select 'drills', owner_id from drills
      union all select 'drill_attempts', owner_id from drill_attempts
      union all select 'kifu_tactics', owner_id from kifu_tactics
      union all select 'kifu_positions', owner_id from kifu_positions
      order by t`);
    expect(owners.rows).toEqual(
      ['drill_attempts', 'drills', 'kifu_analyses', 'kifu_positions', 'kifu_tactics', 'video_kifu_sources']
        .map((t) => ({ t, owner_id: other })),
    );

    const stamps = await client.query<{ t: string; updated_at: Date }>(`
      select 'video_kifu_sources' as t, updated_at from video_kifu_sources
      union all select 'kifu_analyses', updated_at from kifu_analyses
      union all select 'drills', updated_at from drills
      order by t`);
    expect(stamps.rows.map((r) => [r.t, r.updated_at.toISOString()])).toEqual([
      ['drills', PAST],
      ['kifu_analyses', PAST],
      ['video_kifu_sources', PAST],
    ]);

    // トリガーは戻っている（以後の更新では updated_at が進む）
    await client.query(`update video_kifu_sources set extractor_rev = 'r2' where kifu_id = $1`, [kifuId]);
    const after = await client.query<{ updated_at: Date }>(
      `select updated_at from video_kifu_sources where kifu_id = $1`,
      [kifuId],
    );
    expect(after.rows[0].updated_at.toISOString()).not.toBe(PAST);
    await client.end();
  });
});
