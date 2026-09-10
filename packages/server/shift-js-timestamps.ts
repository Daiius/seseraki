// 接続のセッションを UTC に固定した（`src/db/index.ts`）ことに伴う、**一度きり**の是正。
//
// 背景（prd/03 / AGENTS.md「日時の落とし穴」）:
//   drizzle は DB の壁時計を無条件に UTC として読み書きする（`new Date(value + "+0000")` /
//   `toISOString()`）。ところが MySQL の `time_zone` は `SYSTEM`（＝ JST）だったため、
//   書き手によって DB の中身の意味が食い違っていた。
//
//   | 書き手 | 保存されていた値 | 保存されている instant |
//   |---|---|---|
//   | MySQL の `now()`（`createdAt` / `updatedAt`） | JST の壁時計 | **正しい** |
//   | JS の `Date`（`playedAt` / `analysisCompletedAt`） | UTC の壁時計 | **9h 手前にずれている** |
//
//   セッションを UTC にすると `now()` 由来の列は**既存行も含めて**正しくなる
//   （`TIMESTAMP` は内部 UTC 保持で、セッションの時刻帯で読み書き変換されるため。backfill 不要）。
//   一方 JS が書いた列は、読み書きの誤解釈が打ち消し合って画面上だけ正しく見えていたので、
//   **切替と同時に instant を +9h 戻す**必要がある。それがこのスクリプト。
//
// 🔴 **二度流すと 18h ずれる。** 冪等に書けない（絶対値を再計算できない）ので、
//   `maintenance_marks` に印を打って二重適用を防ぐ。印があれば APPLY は必ず中止する。
//
// 対象列: `kifus.playedAt` / `kifus.analysisCompletedAt`（JS の `Date` を書く TIMESTAMP は
//   この 2 本だけ。ほかの日時は `now()` 由来か、JSON 内の ISO 文字列で影響を受けない）。
//
// 実行: 接続先は DB_HOST / DB_PORT / MYSQL_* 環境変数。
//   pnpm db:shift-timestamps                          # dry-run（確認）
//   SHIFT_TIMESTAMPS_APPLY=1 pnpm db:shift-timestamps # 実適用
//   SHIFT_TIMESTAMPS_UNDO=1 SHIFT_TIMESTAMPS_APPLY=1 pnpm db:shift-timestamps  # 切り戻し
// ずらす時間は既定 +9（JST）。別の時刻帯の DB を直すときだけ SHIFT_HOURS で変える。

import { isNotNull, sql } from 'drizzle-orm';
// 一発限りの CLI。処理は完了時点で確定しているので、プールの終了待ちに頼らず
// 明示的に exit する（cloudflared tunnel 越しだと client.end() が返らないことがある。migrate.ts と同じ）。
import { db } from './src/db/index.js';
import { kifus, maintenanceMarks } from './src/db/schema.js';

/** 印の識別子。**変えないこと**——変えると二重適用の防止が効かなくなる */
const MARK_KEY = 'shift-js-timestamps-to-utc';

const APPLY = process.env.SHIFT_TIMESTAMPS_APPLY === '1';
const UNDO = process.env.SHIFT_TIMESTAMPS_UNDO === '1';
const DEFAULT_HOURS = 9;

type MarkNote = { hours: number; playedAt: number; analysisCompletedAt: number };

function parseHours(): number {
  const raw = process.env.SHIFT_HOURS;
  if (raw === undefined) return DEFAULT_HOURS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 23) {
    throw new Error(`SHIFT_HOURS が不正です: ${raw}（0 以外の整数・絶対値 23 まで）`);
  }
  return n;
}

/** 既存の印。無ければ null */
async function readMark(): Promise<{ note: MarkNote | null; appliedAt: Date } | null> {
  const rows = await db
    .select({ note: maintenanceMarks.note, appliedAt: maintenanceMarks.appliedAt })
    .from(maintenanceMarks)
    .where(sql`${maintenanceMarks.markKey} = ${MARK_KEY}`);
  const row = rows[0];
  if (!row) return null;
  let note: MarkNote | null = null;
  try {
    note = row.note ? (JSON.parse(row.note) as MarkNote) : null;
  } catch {
    note = null;
  }
  return { note, appliedAt: row.appliedAt };
}

try {
  const mark = await readMark();
  const hours = UNDO ? -(mark?.note?.hours ?? parseHours()) : parseHours();
  const label = `${hours > 0 ? '+' : ''}${hours}h`;

  console.log(
    `=== ${UNDO ? '切り戻し' : '是正'} ${label} / ${APPLY ? 'APPLY モード（書き込みます）' : 'dry-run（SHIFT_TIMESTAMPS_APPLY=1 で実適用）'} ===`,
  );

  // --- 二重適用の防止 ---------------------------------------------------
  if (!UNDO && mark) {
    console.log(
      `適用済みです（${mark.appliedAt.toISOString()} / ${JSON.stringify(mark.note)}）。何もしません。`,
    );
    console.log('もう一度流すと二重にずれます。切り戻すなら SHIFT_TIMESTAMPS_UNDO=1。');
    process.exit(APPLY ? 1 : 0);
  }
  if (UNDO && !mark) {
    console.log('適用の印がありません。切り戻す対象がないので何もしません。');
    process.exit(APPLY ? 1 : 0);
  }

  // --- 対象の把握 -------------------------------------------------------
  const [counts] = await db
    .select({
      playedAt: sql<number>`sum(case when ${kifus.playedAt} is not null then 1 else 0 end)`,
      analysisCompletedAt: sql<number>`sum(case when ${kifus.analysisCompletedAt} is not null then 1 else 0 end)`,
    })
    .from(kifus);
  const playedAtRows = Number(counts?.playedAt ?? 0);
  const completedRows = Number(counts?.analysisCompletedAt ?? 0);

  // 変更の見え方を数件だけ出す（dry-run で「本当に 9h 動くのか」を目で確かめるため）
  const samples = await db
    .select({ id: kifus.id, playedAt: kifus.playedAt })
    .from(kifus)
    .where(isNotNull(kifus.playedAt))
    .limit(5);
  for (const s of samples) {
    const before = s.playedAt!;
    const after = new Date(before.getTime() + hours * 3_600_000);
    console.log(`kifu #${s.id}: playedAt ${before.toISOString()} -> ${after.toISOString()}`);
  }
  console.log(
    `対象: kifus.playedAt=${playedAtRows} 行 / kifus.analysisCompletedAt=${completedRows} 行`,
  );

  if (!APPLY) {
    console.log('[dry-run: 未書込]');
    process.exit(0);
  }

  // --- 適用 -------------------------------------------------------------
  // 🔒 **印と本体を同じトランザクションで書く。** 片方だけ残ると、次の実行が
  // 「適用済みなのか途中で落ちたのか」を判断できない。
  const note: MarkNote = {
    hours: UNDO ? -hours : hours,
    playedAt: playedAtRows,
    analysisCompletedAt: completedRows,
  };
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`update ${kifus} set ${kifus.playedAt} = ${kifus.playedAt} + interval ${sql.raw(String(hours))} hour where ${kifus.playedAt} is not null`,
    );
    await tx.execute(
      sql`update ${kifus} set ${kifus.analysisCompletedAt} = ${kifus.analysisCompletedAt} + interval ${sql.raw(String(hours))} hour where ${kifus.analysisCompletedAt} is not null`,
    );
    if (UNDO) {
      await tx.execute(
        sql`delete from ${maintenanceMarks} where ${maintenanceMarks.markKey} = ${MARK_KEY}`,
      );
    } else {
      await tx.insert(maintenanceMarks).values({ markKey: MARK_KEY, note: JSON.stringify(note) });
    }
  });

  console.log(
    UNDO
      ? `done: 切り戻しました（印を削除。再適用するには SHIFT_TIMESTAMPS_APPLY=1 で流し直す）`
      : `done: ${label} 適用・印 ${MARK_KEY} を記録しました`,
  );
  process.exit(0);
} catch (err) {
  // ⚠ `err.message` だけを出さない。drizzle の DrizzleQueryError は message が
  // 「Failed query: <SQL>」で、本当の失敗理由は cause 側にある。
  console.error(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error('cause:', cause);
  process.exit(1);
}
