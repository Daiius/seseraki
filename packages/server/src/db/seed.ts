import { readFileSync } from 'fs';
// 「表が空か」は全員ぶんを見る問いなので、RLS を迂回する system ロールで繋ぐ（prd/15 §2）
import { endSystemDb, systemDb } from './system.js';
import { eq } from 'drizzle-orm';
import { kifus, users } from './schema.js';
import { OWNER_USER_ID } from '../users.js';
import { insertKifu } from '../kifu-number.js';

const sampleKifPath = process.argv[2];
if (!sampleKifPath) {
  console.log('Usage: tsx seed.ts <kif-file>');
  process.exit(1);
}

const kifText = readFileSync(sampleKifPath, 'utf-8');

// タイトルを KIF ヘッダから抽出（先手 vs 後手）
const sente = kifText.match(/先手：(.+)/)?.[1] ?? '不明';
const gote = kifText.match(/後手：(.+)/)?.[1] ?? '不明';
const title = `${sente} vs ${gote}`;

const db = systemDb();

const [existing] = await db
  .select({ id: kifus.id })
  .from(kifus)
  .limit(1);

if (existing) {
  console.log('Seed skipped: kifus table already has data');
} else {
  // 所有者はマイグレーションが作った行（prd/11 §6.1・prd/07 §3.1。ID は "1"）
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, OWNER_USER_ID));
  if (!owner) throw new Error('所有者の行が無い。マイグレーションを先に流す');
  // 番号（prd/14 §4.4）を振って入れる
  const result = await db.transaction((tx) => insertKifu(tx, { title, kifText, ownerId: owner.id }));
  console.log(`Seed inserted: id=${result.id} no=${result.displayNo} "${title}"`);
}

await endSystemDb();
