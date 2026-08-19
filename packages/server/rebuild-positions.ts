/**
 * 局面索引の一括再構築（prd/10 §3.2）。
 *
 * **薄い entry point に徹する。** 局面キーの計算は `shared`、置換は `src/positions.ts`。
 * 局面索引は `kifus.usiMoves` から導く派生値なので、キーの作り方を変えたらここで作り直す。
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*` から取る（`redetect-tactics.ts` と同じ規約）。
 * **ホストにポートを開けない compose 網内からの実行を推奨する**（AGENTS.md）。
 *
 *   docker compose run --rm --no-deps -e REBUILD_POSITIONS_APPLY=1 server pnpm --filter server exec tsx rebuild-positions.ts
 */
import { eq, isNotNull } from 'drizzle-orm';
import { client, db } from './src/db';
import { kifus } from './src/db/schema';
import { replacePositions } from './src/positions';

const APPLY = process.env.REBUILD_POSITIONS_APPLY === '1';

async function main() {
  // ⚠ **ここでは id しか読まない。** 指し手列を先に読み溜めて後から置換すると、その間に
  // 走った `reanalyze`（usiMoves と索引を同一トランザクションで更新する）の結果を、
  // **古い指し手列から作った索引で上書きしてしまう**（redetect-tactics.ts と同じ理由）。
  const ids = await db
    .select({ id: kifus.id })
    .from(kifus)
    .where(isNotNull(kifus.usiMoves));

  console.log(
    `対象 ${ids.length} 局${APPLY ? '' : '（dry-run。REBUILD_POSITIONS_APPLY=1 で実書込）'}`,
  );

  let games = 0;
  let rows = 0;
  for (const { id } of ids) {
    if (APPLY) {
      // **1 局ずつ原子的に置換する**。同じトランザクションで `FOR UPDATE` により
      // kifus の行ロックを取ってから usiMoves を読むので、reanalyze と直列化される
      const n = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ usiMoves: kifus.usiMoves })
          .from(kifus)
          .where(eq(kifus.id, id))
          .for('update');
        if (!row) return 0;
        return replacePositions(tx, id, row.usiMoves);
      });
      if (n > 0) games++;
      rows += n;
    } else {
      const [row] = await db
        .select({ usiMoves: kifus.usiMoves })
        .from(kifus)
        .where(eq(kifus.id, id));
      const n = (row?.usiMoves?.length ?? 0) + (row?.usiMoves?.length ? 1 : 0);
      if (n > 0) games++;
      rows += n;
    }
  }

  console.log(
    `${APPLY ? '書き込んだ' : '書き込む予定の'}棋譜 ${games} 局 / 局面 ${rows} 行`,
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
