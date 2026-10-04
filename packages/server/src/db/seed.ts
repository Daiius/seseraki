import { readFileSync } from 'fs';
import { db } from './index.js';
import { eq } from 'drizzle-orm';
import { kifus, users } from './schema.js';
import { OWNER_USER_ID } from '../users.js';

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
  const [result] = await db
    .insert(kifus)
    .values({ title, kifText, ownerId: owner.id })
    .returning({ id: kifus.id });
  console.log(`Seed inserted: id=${result.id} "${title}"`);
}

await db.$client.end();
