import { readFileSync } from 'fs';
import { db } from './index.js';
import { kifus } from './schema.js';

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
  const [result] = await db.insert(kifus).values({ title, kifText }).$returningId();
  console.log(`Seed inserted: id=${result.id} "${title}"`);
}

await db.$client.end();
