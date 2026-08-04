/**
 * 戦型ラベルの一括再判定（prd/01 §6.4「判定ロジックを更新したら一括再判定する」）。
 *
 * **薄い entry point に徹する。** 判定は `shared`、置換は `src/tactics.ts` が持つ。
 * 将来この配置を「本番 server イメージへ同梱し、使い捨てコンテナで実行する」形へ移しても、
 * ここを esbuild のエントリに足すだけで中身は変わらない。
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*` から取る（`migrate.ts` と同じ規約）。
 *
 *   pnpm tactics:redetect                 # 既定 dry-run（変更の要約を出すだけ）
 *   REDETECT_APPLY=1 pnpm tactics:redetect  # 実書込
 *   pnpm tactics:redetect:dev             # dev DB（db-forward.sh 経由）
 */
import { isNotNull } from 'drizzle-orm';
import { detectTactics } from 'shared';
import { client, db } from './src/db';
import { kifus } from './src/db/schema';
import { replaceTactics } from './src/tactics';

const APPLY = process.env.REDETECT_APPLY === '1';

async function main() {
  const rows = await db
    .select({ id: kifus.id, title: kifus.title, usiMoves: kifus.usiMoves })
    .from(kifus)
    .where(isNotNull(kifus.usiMoves));

  console.log(`対象 ${rows.length} 局${APPLY ? '' : '（dry-run。REDETECT_APPLY=1 で実書込）'}`);

  let changed = 0;
  let labels = 0;
  for (const row of rows) {
    const detected = detectTactics(row.usiMoves ?? []);
    labels += detected.length;
    if (APPLY) {
      // **1 局ずつ原子的に置換する**（prd/03 §2.1）。全体を 1 トランザクションにはしない
      const n = await db.transaction((tx) => replaceTactics(tx, row.id, row.usiMoves));
      if (n > 0) changed++;
    } else if (detected.length > 0) {
      changed++;
    }
  }

  console.log(
    `${APPLY ? '書き込んだ' : '書き込む予定の'}棋譜 ${changed} 局 / ラベル ${labels} 行`,
  );
  if (!APPLY) console.log('※ 変更は行っていない');
}

main()
  .then(() => client.end())
  .catch(async (e) => {
    console.error(e);
    await client.end();
    // 本番のランナーが失敗を検知できるよう非ゼロで落とす
    process.exit(1);
  });
