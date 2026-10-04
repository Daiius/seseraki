/**
 * 実 DB テスト（`pnpm --filter server test:db`。prd/15 §8.2）の準備と後片付け。
 *
 * `TEST_DATABASE_URL`（CREATE DATABASE できるロール）に繋ぎ、**実行ごとにランダム名の DATABASE を作って
 * マイグレーションを当て、終わったら DROP する**。並行して流しても名前が衝突しない。
 * マイグレーションは本番と同じ `drizzle/` を同じ migrator で当てる（手書きのトリガーも含めて確かめるため）。
 *
 * テスト側（`setup.ts`）へは `provide` で接続先を渡す。
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
    /** CREATE DATABASE / CREATE ROLE できる接続（ロール分離のテストが自分で DATABASE を作る） */
    testAdminUrl: string;
  }
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL が未設定です（例: postgres://test:test@127.0.0.1:55433/test。CREATE DATABASE できるロール）',
    );
  }
  const name = `seseraki_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database "${name}"`);

  const url = new URL(base);
  url.pathname = `/${name}`;
  const testUrl = url.toString();

  try {
    const pool = new pg.Pool({ connectionString: testUrl, max: 1 });
    await migrate(drizzle({ client: pool }), { migrationsFolder });
    await pool.end();
  } catch (err) {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
    throw err;
  }

  project.provide('testDatabaseUrl', testUrl);
  project.provide('testAdminUrl', base);

  return async () => {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  };
}
