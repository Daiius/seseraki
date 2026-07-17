// 既存棋譜（sourceTz 未設定＝この機能より前に投入された行）の playedAt を
// KIF 署名の TZ 判定で再導出し、sourceTz カラムを埋める一回限りのバックフィル。
//
// 背景: 従来パーサは開始日時を JST 決め打ちで解釈していたため、開始日時を UTC で
// 書き出すアプリの棋譜が 9h 手前にずれて保存されていた。kifText から再パースして直す。
//
// 安全策:
//  - 対象は sourceTz IS NULL の行だけ（投入時に TZ を明示選択した行は上書きしない）。
//  - 既定は **dry-run**（変更内容を表示するだけ）。実際に書き込むには BACKFILL_APPLY=1。
//  - 妥当性ガード: UTC 補正で playedAt が createdAt を超える（対局が登録より未来）行は
//    署名の誤検出を疑い、従来値を維持して SKIP・報告する。
//  - 冪等: playedAt は kifText から絶対値を再計算するので複数回流しても安全。
//
// 実行: 接続先は DB_HOST / DB_PORT / MYSQL_* 環境変数（本番は prod 資格情報を export）。
//   pnpm db:backfill-tz                 # dry-run（確認）
//   BACKFILL_APPLY=1 pnpm db:backfill-tz  # 実適用
// dev DB へ試すときは db:backfill-tz:dev（.env.database を読む）。

import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from './src/db/index.js';
import { kifus } from './src/db/schema.js';
import { parseKif } from './src/kif/parser.js';

const APPLY = process.env.BACKFILL_APPLY === '1';

try {
  console.log(APPLY ? '=== APPLY モード（書き込みます）===' : '=== dry-run（BACKFILL_APPLY=1 で実適用）===');

  // 手動貼り付け（swarsGameKey なし）かつ sourceTz 未設定の行だけ再導出
  const manual = await db
    .select({
      id: kifus.id,
      kifText: kifus.kifText,
      playedAt: kifus.playedAt,
      createdAt: kifus.createdAt,
    })
    .from(kifus)
    .where(and(isNull(kifus.swarsGameKey), isNull(kifus.sourceTz)));

  let changed = 0;
  let skipped = 0;
  for (const row of manual) {
    const { header } = parseKif(row.kifText);
    const implausible =
      header.playedAt != null && header.playedAt.getTime() > row.createdAt.getTime();
    if (implausible) {
      skipped++;
      console.warn(
        `manual #${row.id}: SKIP (tz=${header.sourceTz} → playedAt ${header.playedAt?.toISOString()} > createdAt ${row.createdAt.toISOString()}; 誤検出の疑い。従来値維持)`,
      );
      continue;
    }
    const before = row.playedAt?.toISOString() ?? 'null';
    const after = header.playedAt?.toISOString() ?? 'null';
    if (before !== after) changed++;
    console.log(
      `manual #${row.id}: tz=${header.sourceTz} playedAt ${before} -> ${after}`,
    );
    if (APPLY) {
      await db
        .update(kifus)
        .set({ playedAt: header.playedAt, sourceTz: header.sourceTz })
        .where(eq(kifus.id, row.id));
    }
  }

  // swars 経路（sourceTz 未設定）: playedAt は gameKey 由来で正しいので JST ラベルのみ
  const swarsTargets = await db
    .select({ id: kifus.id })
    .from(kifus)
    .where(and(isNotNull(kifus.swarsGameKey), isNull(kifus.sourceTz)));
  if (APPLY && swarsTargets.length > 0) {
    await db
      .update(kifus)
      .set({ sourceTz: 'JST' })
      .where(and(isNotNull(kifus.swarsGameKey), isNull(kifus.sourceTz)));
  }

  console.log(
    `done: manual=${manual.length} (playedAt changed=${changed}, skipped=${skipped}), swars labeled=JST x${swarsTargets.length}${APPLY ? '' : ' [dry-run: 未書込]'}`,
  );
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
