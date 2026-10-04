/**
 * ロール分離（prd/15 §2）を実 Postgres で確かめる。
 *
 * dev の初期化スクリプト（`scripts/postgres-init/10-server-role.sh`）の **SQL そのもの**を読んで流し、
 * 「管理ロールがマイグレーションで作った表を、server ロールが DML だけで扱える」ことを見る。
 * ロールはクラスタ全体の名前なので、実行ごとにランダムな名前で作って最後に消す。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { kifus } from './db/schema.js';
import { OWNER_USER_ID } from './users.js';

const initScript = fileURLToPath(
  new URL('../../../scripts/postgres-init/10-server-role.sh', import.meta.url),
);
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** 初期化スクリプトの heredoc（psql に渡す SQL）に psql 変数を埋めて返す */
function initSql(vars: Record<string, string>): string {
  const script = readFileSync(initScript, 'utf8');
  const body = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)?.[1];
  if (!body) throw new Error('初期化スクリプトから SQL を取り出せない');
  return body
    .replace(/:"(\w+)"/g, (_, k: string) => `"${vars[k]}"`)
    .replace(/:'(\w+)'/g, (_, k: string) => `'${vars[k]}'`);
}

const suffix = randomBytes(5).toString('hex');
const names = {
  admin_user: `seseraki_admin_${suffix}`,
  server_user: `seseraki_server_${suffix}`,
  server_password: `pw_${suffix}`,
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

beforeAll(async () => {
  superuser = new pg.Client({ connectionString: base.toString() });
  await superuser.connect();
  await superuser.query(`create role "${names.admin_user}" login password '${names.server_password}'`);
  await superuser.query(`create database "${names.db_name}" owner "${names.admin_user}"`);

  // 公式イメージと同じ順: 初期化スクリプト（スーパーユーザー）→ マイグレーション（管理ロール）
  const init = new pg.Client({ connectionString: urlFor(decodeURIComponent(base.username), decodeURIComponent(base.password)) });
  await init.connect();
  await init.query(initSql(names));
  await init.end();

  const adminPool = new pg.Pool({ connectionString: urlFor(names.admin_user, names.server_password), max: 1 });
  await migrate(drizzle({ client: adminPool }), { migrationsFolder });
  await adminPool.end();

  serverPool = new pg.Pool({ connectionString: urlFor(names.server_user, names.server_password) });
});

afterAll(async () => {
  await serverPool?.end();
  await superuser.query(`drop database if exists "${names.db_name}" with (force)`);
  await superuser.query(`drop role if exists "${names.server_user}"`);
  await superuser.query(`drop role if exists "${names.admin_user}"`);
  await superuser.end();
});

describe('server ロール（DML のみ）', () => {
  it('管理ロールが作った表に挿入・更新・削除できる（identity・トリガーを含む）', async () => {
    const db = drizzle({ client: serverPool });
    const [row] = await db
      .insert(kifus)
      .values({ title: 't', kifText: '', ownerId: OWNER_USER_ID })
      .returning({ id: kifus.id });
    await db.update(kifus).set({ title: 'u' }).where(eq(kifus.id, row.id));
    await db.delete(kifus).where(eq(kifus.id, row.id));
  });

  it('表を作れない（DDL は管理ロールだけ）', async () => {
    await expect(serverPool.query('create table "should_fail" (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('表を消せない', async () => {
    await expect(serverPool.query('drop table "kifus"')).rejects.toMatchObject({ code: '42501' });
  });
});
