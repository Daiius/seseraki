/**
 * ロール分離（prd/15 §2）と RLS（prd/14 §4「RLS の形」）を実 Postgres で確かめる。
 *
 * dev の初期化スクリプト（`scripts/postgres-init/10-server-role.sh` / `20-system-role.sh`）の **SQL そのもの**を
 * 読んで流し、本番と同じ形——**表の所有者は非 superuser の管理ロール、アプリは非 superuser の server ロール
 * （RLS が効く）と system ロール（BYPASSRLS）**——を作る。テストの接続ロールは superuser のことが多く、
 * superuser と表の所有者には RLS が効かないので、他の実 DB テストでは RLS の振る舞いを確かめられない。
 * ロールはクラスタ全体の名前なので、実行ごとにランダムな名前で作って最後に消す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { kifus } from './db/schema.js';
import { OWNER_USER_ID } from './users.js';

const scriptPath = (name: string) =>
  fileURLToPath(new URL(`../../../scripts/postgres-init/${name}`, import.meta.url));
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * 初期化スクリプトの heredoc（psql に渡す SQL）のうち `marker` を含むものに psql 変数を埋めて返す
 * （`20-system-role.sh` は `--check` の heredoc も持つ）。
 * psql のメタコマンドの行（`\getenv` / `\o` / `\set` など）は落とす——変数はここで埋め、出力の切り替えは要らない
 */
function initSql(script: string, marker: string, vars: Record<string, string>): string {
  const source = readFileSync(scriptPath(script), 'utf8');
  const body = [...source.matchAll(/<<'SQL'\n([\s\S]*?)\nSQL\n/g)]
    .map((m) => m[1])
    .find((b) => b.includes(marker));
  if (!body) throw new Error(`${script} から SQL を取り出せない`);
  return body
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n')
    .replace(/:"(\w+)"/g, (_, k: string) => `"${vars[k]}"`)
    .replace(/:'(\w+)'/g, (_, k: string) => `'${vars[k]}'`);
}

const suffix = randomBytes(5).toString('hex');
const names = {
  admin_user: `seseraki_admin_${suffix}`,
  server_user: `seseraki_server_${suffix}`,
  server_password: `pw_${suffix}`,
  system_user: `seseraki_system_${suffix}`,
  system_password: `pw_sys_${suffix}`,
  db_name: `seseraki_roles_${suffix}`,
};

const base = new URL(inject('testAdminUrl'));
const urlFor = (user: string, password: string) => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${names.db_name}`;
  return url.toString();
};

let superuser: pg.Client;
let serverPool: pg.Pool;
let systemPool: pg.Pool;

beforeAll(async () => {
  superuser = new pg.Client({ connectionString: base.toString() });
  await superuser.connect();
  await superuser.query(`create role "${names.admin_user}" login password '${names.server_password}'`);
  await superuser.query(`create database "${names.db_name}" owner "${names.admin_user}"`);

  // 公式イメージと同じ順: 初期化スクリプト（スーパーユーザー）→ マイグレーション（管理ロール）
  const init = new pg.Client({
    connectionString: urlFor(decodeURIComponent(base.username), decodeURIComponent(base.password)),
  });
  await init.connect();
  await init.query(initSql('10-server-role.sh', 'CREATE ROLE', names));
  await init.query(initSql('20-system-role.sh', 'DO $do$', names));
  await init.end();

  const adminPool = new pg.Pool({ connectionString: urlFor(names.admin_user, names.server_password), max: 1 });
  await migrate(drizzle({ client: adminPool }), { migrationsFolder });
  await adminPool.end();

  serverPool = new pg.Pool({ connectionString: urlFor(names.server_user, names.server_password) });
  systemPool = new pg.Pool({ connectionString: urlFor(names.system_user, names.system_password) });
});

afterAll(async () => {
  await serverPool?.end();
  await systemPool?.end();
  await superuser.query(`drop database if exists "${names.db_name}" with (force)`);
  for (const role of [names.system_user, names.server_user, names.admin_user]) {
    await superuser.query(`drop role if exists "${role}"`);
  }
  await superuser.end();
});

/** server ロールの接続 1 本で、`app.user_id` を設定したトランザクションの中で流す（`user-tx.ts` と同じ形） */
async function asUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await serverPool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    c.release();
  }
}

/** 失敗した pg のエラーコード（成功したら throw） */
async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  throw new Error('失敗するはずの文が通った');
}

const INSUFFICIENT_PRIVILEGE = '42501';

describe('server ロール（DML のみ）', () => {
  it('管理ロールが作った表に挿入・更新・削除できる（identity・トリガーを含む。所有者として）', async () => {
    await asUser(OWNER_USER_ID, async (c) => {
      const db = drizzle({ client: c });
      const [row] = await db
        .insert(kifus)
        .values({ title: 't', kifText: '', ownerId: OWNER_USER_ID })
        .returning({ id: kifus.id });
      await db.update(kifus).set({ title: 'u' }).where(eq(kifus.id, row.id));
      await db.delete(kifus).where(eq(kifus.id, row.id));
    });
  });

  it('表を作れない（DDL は管理ロールだけ）', async () => {
    await expect(serverPool.query('create table "should_fail" (id int)')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('表を消せない', async () => {
    await expect(serverPool.query('drop table "kifus"')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });
});

describe('RLS（prd/14 §4「RLS の形」）', () => {
  let userA: string;
  let userB: string;
  let kifuA: number;
  let kifuB: number;

  beforeAll(async () => {
    // 準備は system ロール（RLS を迂回する）で入れる
    const user = async () =>
      (
        await systemPool.query<{ id: string }>(
          `insert into users (name, email, display_name) values ('n', $1, 'd') returning id`,
          [`${randomUUID()}@example.invalid`],
        )
      ).rows[0].id;
    userA = await user();
    userB = await user();
    const kifu = async (ownerId: string) => {
      const id = Number(
        (
          await systemPool.query<{ id: string }>(
            `insert into kifus (title, kif_text, owner_id) values ('t', '', $1) returning id`,
            [ownerId],
          )
        ).rows[0].id,
      );
      await systemPool.query(
        `insert into kifu_tactics (kifu_id, owner_id, side, label, turn) values ($1, $2, 'sente', '四間飛車', 1)`,
        [id, ownerId],
      );
      await systemPool.query(`insert into user_aliases (user_id, name) values ($1, $2)`, [
        ownerId,
        `alias-${ownerId}`,
      ]);
      return id;
    };
    kifuA = await kifu(userA);
    kifuB = await kifu(userB);
  });

  const idsOf = async (c: pg.ClientBase | pg.Pool, table: string, column = 'kifu_id') =>
    (await c.query<{ id: string }>(`select ${column} as id from ${table}`)).rows.map((r) => String(r.id));

  it('🔒 app.user_id が未設定なら、どの表も 0 件（fail-closed）', async () => {
    for (const table of ['kifus', 'kifu_tactics', 'user_aliases']) {
      expect((await serverPool.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    }
  });

  it('🔒 tx で設定した接続でも、tx の後は 0 件に戻る（空文字は owner_id と一致しない）', async () => {
    const c = await serverPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [userA]);
      expect((await c.query('select count(*)::int as n from kifus')).rows[0].n).toBe(1);
      await c.query('commit');
      expect((await c.query('select count(*)::int as n from kifus')).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it('A として読むと A の行だけが見える（子の表・名前候補も）', async () => {
    await asUser(userA, async (c) => {
      expect(await idsOf(c, 'kifus', 'id')).toEqual([String(kifuA)]);
      expect(await idsOf(c, 'kifu_tactics')).toEqual([String(kifuA)]);
      expect(await idsOf(c, 'user_aliases', 'user_id')).toEqual([userA]);
    });
  });

  it('A として B の行を更新・削除しても 0 行（USING）', async () => {
    await asUser(userA, async (c) => {
      expect((await c.query(`update kifus set title = 'x' where id = $1`, [kifuB])).rowCount).toBe(0);
      expect((await c.query(`delete from kifu_tactics where kifu_id = $1`, [kifuB])).rowCount).toBe(0);
      expect((await c.query(`delete from user_aliases where user_id = $1`, [userB])).rowCount).toBe(0);
      expect((await c.query(`delete from kifus where id = $1`, [kifuB])).rowCount).toBe(0);
    });
    const [row] = (await systemPool.query(`select title from kifus where id = $1`, [kifuB])).rows;
    expect(row.title).toBe('t');
  });

  it('A として B の所有者で挿入できない・自分の行を B へ付け替えられない（WITH CHECK）', async () => {
    expect(
      await errorCode(
        asUser(userA, (c) =>
          c.query(`insert into kifus (title, kif_text, owner_id) values ('t', '', $1)`, [userB]),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        asUser(userA, (c) =>
          c.query(`insert into user_aliases (user_id, name) values ($1, 'stolen')`, [userB]),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        asUser(userA, (c) => c.query(`update kifus set owner_id = $1 where id = $2`, [userB, kifuA])),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('A として自分の行は書ける', async () => {
    await asUser(userA, async (c) => {
      expect((await c.query(`update kifus set title = 'mine' where id = $1`, [kifuA])).rowCount).toBe(1);
    });
  });

  it('system ロール（BYPASSRLS）は app.user_id なしで全員ぶんが見える', async () => {
    const ids = await idsOf(systemPool, 'kifus', 'id');
    expect(ids).toEqual(expect.arrayContaining([String(kifuA), String(kifuB)]));
    const aliases = await idsOf(systemPool, 'user_aliases', 'user_id');
    expect(aliases).toEqual(expect.arrayContaining([userA, userB]));
  });

  it('system ロールは BYPASSRLS だが superuser ではない。server ロールは BYPASSRLS を持たない', async () => {
    const { rows } = await superuser.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolname, rolbypassrls, rolsuper from pg_roles where rolname = any($1) order by rolname`,
      [[names.server_user, names.system_user]],
    );
    expect(rows).toEqual([
      { rolname: names.server_user, rolbypassrls: false, rolsuper: false },
      { rolname: names.system_user, rolbypassrls: true, rolsuper: false },
    ]);
  });

  it('system ロールのスクリプトは冪等（もう一度流しても落ちない）', async () => {
    const init = new pg.Client({
      connectionString: urlFor(decodeURIComponent(base.username), decodeURIComponent(base.password)),
    });
    await init.connect();
    try {
      await init.query(initSql('20-system-role.sh', 'DO $do$', names));
    } finally {
      await init.end();
    }
    expect((await systemPool.query('select count(*)::int as n from kifus')).rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
