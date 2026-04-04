import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';
import { relations } from './schema.js';

export const client = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE ?? 'shogi',
});

export const db = drizzle({
  client,
  schema,
  relations,
  mode: 'default',
});
