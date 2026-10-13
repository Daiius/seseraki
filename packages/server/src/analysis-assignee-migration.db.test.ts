/**
 * 解析の担当（prd/14 §5.7）のマイグレーションを実 Postgres で確かめる。
 *
 * 実行ごとに専用の DATABASE を作り、**担当のマイグレーションより前だけ**を当ててユーザーを入れ、
 * 担当のマイグレーションを当てて結果を見る（`display-no-migration.db.test.ts` と同じ作法）。
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const migrations = readdirSync(migrationsFolder).sort();
const target = migrations.findIndex((name) => name.endsWith('_analysis_assignee'));
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

/** 担当のマイグレーションの直前まで当てた DATABASE に繋いだクライアント */
async function databaseBeforeTarget(): Promise<pg.Client> {
  const name = `seseraki_aa_${randomBytes(5).toString('hex')}`;
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

const PAST = '2020-01-01T00:00:00.000Z';
const CHECK_VIOLATION = '23514';

describe('解析の担当の埋め戻し（prd/14 §5.7）', () => {
  it('担当のマイグレーションがある', () => {
    expect(target).toBeGreaterThan(0);
  });

  it('既存の所有者だけ worker、ほかは browser。updated_at は変えない', async () => {
    const client = await databaseBeforeTarget();
    const user = async (email: string) =>
      (
        await client.query<{ id: string }>(
          `insert into users (name, email, display_name) values ('n', $1, 'd') returning id`,
          [email],
        )
      ).rows[0].id;
    const other = await user('other@example.invalid');
    await client.query(`update users set updated_at = $1`, [PAST]);

    await applyMigration(client, migrations[target]);

    const rows = await client.query<{ id: string; analysis_assignee: string; updated_at: Date }>(
      `select id, analysis_assignee, updated_at from users order by id`,
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.analysis_assignee]))).toEqual({
      '1': 'worker',
      [other]: 'browser',
    });
    expect(rows.rows.every((r) => r.updated_at.toISOString() === PAST)).toBe(true);

    // 新しいユーザーの既定は browser
    const fresh = await user('fresh@example.invalid');
    const freshRow = await client.query<{ analysis_assignee: string }>(
      `select analysis_assignee from users where id = $1`,
      [fresh],
    );
    expect(freshRow.rows[0].analysis_assignee).toBe('browser');

    // トリガーは戻っている（以後の更新では updated_at が進む）
    await client.query(`update users set analysis_assignee = 'browser' where id = '1'`);
    const after = await client.query<{ updated_at: Date }>(`select updated_at from users where id = '1'`);
    expect(after.rows[0].updated_at.toISOString()).not.toBe(PAST);

    // 🔒 worker を選べるのは所有者だけ・値は 2 つだけ
    await client.query(`update users set analysis_assignee = 'worker' where id = '1'`);
    await expect(
      client.query(`update users set analysis_assignee = 'worker' where id = $1`, [other]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'users_analysis_assignee_worker_owner_only' });
    await expect(
      client.query(`update users set analysis_assignee = 'gpu' where id = $1`, [other]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'users_analysis_assignee_check' });
    await client.end();
  });

  it('所有者の行が無い DATABASE にも当たる（埋め戻しは 0 行）', async () => {
    const client = await databaseBeforeTarget();
    await client.query(`delete from users where id = '1'`);
    await applyMigration(client, migrations[target]);
    const rows = await client.query(`select 1 from users where analysis_assignee = 'worker'`);
    expect(rows.rowCount).toBe(0);
    await client.end();
  });
});
