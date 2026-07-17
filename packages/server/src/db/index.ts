import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';
import { relations } from './schema.js';

export const client = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  // 既定 3306。cloudflared tunnel やローカル検証用 DB を別ポートに立てたときに
  // DB_PORT で差し替える（未設定なら 3306）。
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'seseraki',
});

export const db = drizzle({
  client,
  schema,
  relations,
  mode: 'default',
});
