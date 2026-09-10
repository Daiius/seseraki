// `kifus.playedAt` を**出どころから作り直す**。接続のセッションを UTC に固定した
// （`src/db/index.ts`）あと、既存行が正しい絶対時刻を持っているかを確かめ、ずれていれば直す。
//
// 背景（prd/03 §1.1）:
//   drizzle は DB の壁時計を無条件に UTC として読み書きする。MySQL の `time_zone` が
//   `SYSTEM`（＝ JST）だった間、`now()` 由来の列（`createdAt` / `updatedAt`）は
//   **読むと +9h 未来に見え**（保存されている instant は正しい）、JS が `Date` を書く
//   `playedAt` は逆に**保存される instant が 9h 手前**にずれていた（読み出しの誤解釈と
//   打ち消し合うので、画面上は正しく見えていた）。
//   セッションを UTC にすると前者は既存行も含めて直り、後者は**ずれが表に出てくる**。
//
// 🔴 **一律に `+9h` する形にはしない。** 「何時間ずらすか」は行がいつ・どの経路で書かれたかに
//   依存し、外から見分けられない。取り違えると**正しい行を壊す**（しかも二度流せば 18h ずれる）。
//   `playedAt` は**出どころから絶対値を計算できる**ので、そちらを使う:
//     - swars 経路 … `swarsGameKey` の日時（常に JST）
//     - 手動貼り付け … `kifText` の開始日時を、保存済みの `sourceTz` で解釈
//   絶対値の再計算なので**何度流しても同じ**（冪等）。適用済みの印も要らない。
//
// 🔎 **dry-run の出力がそのまま「ずれているのか」の答えになる。**
//   変更 0 件なら既存行は元から正しい。全行が同じ幅（例 +9h）で動くなら、その幅だけずれていた。
//
// ⚠ **`sourceTz` 未設定の行は触らない。** 何 tz で解釈すべきかが決まらないため。
//   先に `db:backfill-tz` を流して `sourceTz` を埋めること。
// ⚠ `analysisCompletedAt` は出どころが無いので再計算できない（解析の完了時刻。表示にも
//   並べ替えにも使っていない ―― 解析済みかどうかの有無だけを見る）。ここでは触らない。
//
// 実行: 接続先は DB_HOST / DB_PORT / MYSQL_* 環境変数。
//   pnpm db:rederive-played-at                              # dry-run（確認）
//   REDERIVE_PLAYED_AT_APPLY=1 pnpm db:rederive-played-at   # 実適用
// dev DB へ試すときは db:rederive-played-at:dev（.env.database を読む）。

import { eq, isNotNull, sql } from 'drizzle-orm';
// 一発限りの CLI。処理は完了時点で確定しているので、プールの終了待ちに頼らず
// 明示的に exit する（cloudflared tunnel 越しだと client.end() が返らないことがある。migrate.ts と同じ）。
import { db } from './src/db/index.js';
import { kifus } from './src/db/schema.js';
import { parseKif, type KifTimezone } from './src/kif/parser.js';
import { parsePlayedAt } from './src/swars/csa-to-kif.js';

const APPLY = process.env.REDERIVE_PLAYED_AT_APPLY === '1';
/** 出力が長くなりすぎないよう、明細はこの件数まで */
const DETAIL_LIMIT = 20;

/** ずれ幅（時間）ごとの件数。**ここが答え合わせになる** */
const deltaHistogram = new Map<string, number>();

function noteDelta(before: Date | null, after: Date | null): string {
  if (before === null || after === null) return before === after ? 'same' : 'null が絡む変化';
  const hours = (after.getTime() - before.getTime()) / 3_600_000;
  return hours === 0 ? 'same' : `${hours > 0 ? '+' : ''}${hours}h`;
}

try {
  console.log(
    APPLY
      ? '=== APPLY モード（書き込みます）==='
      : '=== dry-run（REDERIVE_PLAYED_AT_APPLY=1 で実適用）===',
  );

  const rows = await db
    .select({
      id: kifus.id,
      kifText: kifus.kifText,
      swarsGameKey: kifus.swarsGameKey,
      sourceTz: kifus.sourceTz,
      playedAt: kifus.playedAt,
    })
    .from(kifus)
    .where(isNotNull(kifus.sourceTz));

  // sourceTz 未設定＝解釈が決まらない行。触らずに件数だけ報告する
  const [counts] = await db.select({ all: sql<number>`count(*)` }).from(kifus);
  const untypedCount = Number(counts?.all ?? 0) - rows.length;

  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let shown = 0;

  for (const row of rows) {
    // 出どころから絶対値を作り直す
    const derived = row.swarsGameKey
      ? parsePlayedAt(row.swarsGameKey)
      : parseKif(row.kifText, row.sourceTz as KifTimezone).header.playedAt;

    if (derived === null) {
      // 開始日時が読めない棋譜。**既存値を消さない**（null で上書きしない）
      skipped++;
      continue;
    }

    const delta = noteDelta(row.playedAt, derived);
    deltaHistogram.set(delta, (deltaHistogram.get(delta) ?? 0) + 1);

    if (row.playedAt !== null && row.playedAt.getTime() === derived.getTime()) {
      unchanged++;
      continue;
    }

    changed++;
    if (shown < DETAIL_LIMIT) {
      shown++;
      console.log(
        `kifu #${row.id} (${row.swarsGameKey ? 'swars' : `manual/${row.sourceTz}`}): ` +
          `${row.playedAt?.toISOString() ?? 'null'} -> ${derived.toISOString()} [${delta}]`,
      );
    }
    if (APPLY) {
      await db.update(kifus).set({ playedAt: derived }).where(eq(kifus.id, row.id));
    }
  }
  if (changed > shown) console.log(`… ほか ${changed - shown} 件`);

  console.log('--- ずれ幅の内訳（再計算値 − 現在値）---');
  for (const [delta, count] of [...deltaHistogram].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${delta}: ${count} 件`);
  }
  console.log(
    `done: 対象=${rows.length} 件（変更=${changed} / 一致=${unchanged} / 日時を読めず据置=${skipped}）` +
      `${untypedCount > 0 ? ` / sourceTz 未設定で対象外=${untypedCount} 件（先に db:backfill-tz）` : ''}` +
      `${APPLY ? '' : ' [dry-run: 未書込]'}`,
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
