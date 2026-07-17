// 既存棋譜の playedAt を、新しい KIF タイムゾーン判定（署名で UTC/JST を検出）で
// 再導出し、sourceTz カラムを埋める一回限りのバックフィル。
//
// 背景: 従来パーサは開始日時を JST 決め打ちで解釈していたため、開始日時を UTC で
// 書き出すアプリ（署名 = 柿木形式コメント + 持ち時間）の棋譜が 9h 手前にずれて保存
// されていた。kifText から再パースして正しい絶対時刻へ直す。
//
// 冪等: playedAt は毎回 kifText から絶対値を再計算するので、複数回流しても安全。
// swars 経路（swarsGameKey あり）は playedAt が gameKey 由来で正しいため触らず、
// sourceTz を "JST" で埋めるだけ。
//
// 実行: 接続先は DB_HOST / DB_PORT / MYSQL_* 環境変数（本番は prod 資格情報を export）。
//   pnpm --filter server exec tsx backfill-source-tz.ts
// dev DB へ試すときは db:migrate:dev と同様に .env.database を読ませて実行する。

import { eq, isNull, isNotNull } from 'drizzle-orm';
import { db, client } from './src/db/index.js';
import { kifus } from './src/db/schema.js';
import { parseKif } from './src/kif/parser.js';

try {
  // 手動貼り付け（swarsGameKey なし）: kifText から playedAt / sourceTz を再導出
  const manual = await db
    .select({ id: kifus.id, kifText: kifus.kifText, playedAt: kifus.playedAt })
    .from(kifus)
    .where(isNull(kifus.swarsGameKey));

  let changed = 0;
  for (const row of manual) {
    const { header } = parseKif(row.kifText);
    await db
      .update(kifus)
      .set({ playedAt: header.playedAt, sourceTz: header.sourceTz })
      .where(eq(kifus.id, row.id));
    const before = row.playedAt?.toISOString() ?? 'null';
    const after = header.playedAt?.toISOString() ?? 'null';
    if (before !== after) changed++;
    console.log(
      `manual #${row.id}: tz=${header.sourceTz} playedAt ${before} -> ${after}`,
    );
  }

  // swars 経路: playedAt は正しいので sourceTz のラベルだけ埋める
  const swars = await db
    .update(kifus)
    .set({ sourceTz: 'JST' })
    .where(isNotNull(kifus.swarsGameKey));

  console.log(
    `done: manual=${manual.length} (playedAt changed=${changed}), swars labeled=JST`,
  );
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
