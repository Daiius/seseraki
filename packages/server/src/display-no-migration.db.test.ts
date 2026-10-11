/**
 * 棋譜の番号（prd/14 §4.4）のマイグレーションを実 Postgres で確かめる。
 *
 * 実行ごとに専用の DATABASE を作り、**番号のマイグレーションより前だけ**を当てて既存の棋譜を入れ、
 * 番号のマイグレーションを当てて結果を見る（空の DATABASE に全部当てる `postgres.db.test.ts` では
 * 埋め戻しの UPDATE が 1 行も走らないため）。
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const migrations = readdirSync(migrationsFolder).sort();
const target = migrations.findIndex((name) => name.endsWith('_kifu_display_no'));
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

/** 番号のマイグレーションの直前まで当てた DATABASE に繋いだクライアント */
async function databaseBeforeTarget(): Promise<pg.Client> {
  const name = `seseraki_dn_${randomBytes(5).toString('hex')}`;
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

describe('棋譜の番号の埋め戻し（prd/14 §4.4）', () => {
  it('番号のマイグレーションがある', () => {
    expect(target).toBeGreaterThan(0);
  });

  it('既存の棋譜は display_no = id、カウンタは所有者ごとの最大値。updated_at は変えない', async () => {
    const client = await databaseBeforeTarget();
    const kifu = async (ownerId: string) =>
      Number(
        (
          await client.query<{ id: string }>(
            `insert into kifus (title, kif_text, owner_id, created_at, updated_at)
             values ('t', '', $1, $2, $2) returning id`,
            [ownerId, PAST],
          )
        ).rows[0].id,
      );
    const user = async (email: string) =>
      (
        await client.query<{ id: string }>(
          `insert into users (name, email, display_name) values ('n', $1, 'd') returning id`,
          [email],
        )
      ).rows[0].id;

    // 所有者（"1"）の棋譜 3 局。2 局目を消して欠番を作る（今の URL の番号がそのまま残ること）
    const ownerIds = [await kifu('1'), await kifu('1'), await kifu('1')];
    await client.query(`delete from kifus where id = $1`, [ownerIds[1]]);
    // 前提の外（所有者以外の棋譜）が混ざっていても、所有者ごとの一意は崩れない
    const other = await user('other@example.invalid');
    const otherId = await kifu(other);
    const empty = await user('empty@example.invalid');
    await client.query(`update users set updated_at = $1`, [PAST]);

    await applyMigration(client, migrations[target]);

    const rows = await client.query<{ id: string; owner_id: string; display_no: number; updated_at: Date }>(
      `select id, owner_id, display_no, updated_at from kifus order by id`,
    );
    expect(rows.rows.map((r) => [Number(r.id), r.owner_id, r.display_no])).toEqual([
      [ownerIds[0], '1', ownerIds[0]],
      [ownerIds[2], '1', ownerIds[2]],
      [otherId, other, otherId],
    ]);
    expect(rows.rows.every((r) => r.updated_at.toISOString() === PAST)).toBe(true);

    const counters = await client.query<{ id: string; last_kifu_no: number; updated_at: Date }>(
      `select id, last_kifu_no, updated_at from users order by id`,
    );
    expect(Object.fromEntries(counters.rows.map((r) => [r.id, r.last_kifu_no]))).toEqual({
      '1': ownerIds[2],
      [other]: otherId,
      [empty]: 0,
    });
    expect(counters.rows.every((r) => r.updated_at.toISOString() === PAST)).toBe(true);

    // 次の番号は最大値 + 1（消した番号は再利用しない）
    const next = await client.query<{ n: number }>(
      `update users set last_kifu_no = last_kifu_no + 1 where id = '1' returning last_kifu_no as n`,
    );
    expect(next.rows[0].n).toBe(ownerIds[2] + 1);

    // トリガーは戻っている（以後の更新では updated_at が進む）
    await client.query(`update kifus set title = 'u' where id = $1`, [ownerIds[0]]);
    const after = await client.query<{ updated_at: Date }>(`select updated_at from kifus where id = $1`, [
      ownerIds[0],
    ]);
    expect(after.rows[0].updated_at.toISOString()).not.toBe(PAST);

    // 所有者の中で番号は一意・NOT NULL
    await expect(
      client.query(`insert into kifus (title, kif_text, owner_id, display_no) values ('t', '', '1', $1)`, [
        ownerIds[0],
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'kifus_owner_id_display_no_uq' });
    await expect(
      client.query(`insert into kifus (title, kif_text, owner_id) values ('t', '', '1')`),
    ).rejects.toMatchObject({ code: '23502' });
    await client.end();
  });

  it('棋譜が 1 局も無い DATABASE にも当たる', async () => {
    const client = await databaseBeforeTarget();
    await applyMigration(client, migrations[target]);
    const owner = await client.query<{ last_kifu_no: number }>(`select last_kifu_no from users where id = '1'`);
    expect(owner.rows[0].last_kifu_no).toBe(0);
    await client.end();
  });
});
