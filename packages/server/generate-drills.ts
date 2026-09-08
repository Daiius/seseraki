/**
 * 出題の一括生成（prd/13 §8）。
 *
 * **薄い entry point に徹する。** 抽出は `shared`（CPL・詰み筋の分類）と `src/drills.ts`。
 * 出題は解析結果から導く派生値なので、**抽出規則や閾値を変えたらここで作り直す**。
 *
 * 🔴 **マイグレーションは空の `drills` を作るだけ**なので、**本番でも一度は流す**。
 * 流し忘れると出題が 1 問も出ない（`kifu_positions` で踏んだのと同じ罠。AGENTS.md）。
 *
 * 🔒 **upsert なので、既に解いた問題の解答履歴は作り直しでも消えない**（prd/13 §6.1）。
 * 条件から外れた問題だけが履歴ごと消える。
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*` から取る（`rebuild-positions.ts` と同じ規約）。
 * **ホストにポートを開けない compose 網内からの実行を推奨する**（AGENTS.md）。
 *
 *   docker compose run --rm --no-deps -e GENERATE_DRILLS_APPLY=1 server pnpm --filter server exec tsx generate-drills.ts
 */
import { eq, isNotNull } from 'drizzle-orm';
import { client, db } from './src/db';
import { kifus } from './src/db/schema';
import {
  drillConfigFromEnv,
  extractDrills,
  loadFullAnalyses,
  syncDrills,
} from './src/drills';

const APPLY = process.env.GENERATE_DRILLS_APPLY === '1';

async function main() {
  const config = drillConfigFromEnv();
  // ⚠ **ここでは id しか読まない。** 解析結果を先に読み溜めて後から書くと、その間に
  // 走った解析報告・`reanalyze` の結果を古い材料で上書きしてしまう（rebuild-positions.ts と同じ理由）
  const ids = await db
    .select({ id: kifus.id })
    .from(kifus)
    .where(isNotNull(kifus.usiMoves));

  console.log(
    `対象 ${ids.length} 局 / 悪手 ${config.thresholds.blunder}cp・詰み ${config.mateMaxPlies} plies まで` +
      `${APPLY ? '' : '（dry-run。GENERATE_DRILLS_APPLY=1 で実書込）'}`,
  );

  const byReason = { missed_mate: 0, own_blunder: 0 };
  let games = 0;
  let removed = 0;
  for (const { id } of ids) {
    if (APPLY) {
      // **1 局ずつ原子的に**。同じトランザクションで kifus の行ロックを取ってから
      // 材料を読むので、解析の報告と直列化される
      const n = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: kifus.id })
          .from(kifus)
          .where(eq(kifus.id, id))
          .for('update');
        if (!row) return { upserted: 0, removed: 0 };
        return syncDrills(tx, id, config);
      });
      if (n.upserted > 0) games++;
      removed += n.removed;
      // 内訳は dry-run と同じ経路で数える（書き込み結果からは理由が読めない）
      continue;
    }
    const [row] = await db
      .select({
        usiMoves: kifus.usiMoves,
        subjectSide: kifus.subjectSide,
        source: kifus.source,
      })
      .from(kifus)
      .where(eq(kifus.id, id));
    if (!row || row.source === 'video') continue;
    const drills = extractDrills({
      usiMoves: row.usiMoves,
      subjectSide: row.subjectSide,
      analyses: await loadFullAnalyses(db, id),
      config,
    });
    if (drills.length > 0) games++;
    for (const d of drills) byReason[d.reason]++;
  }

  if (APPLY) {
    console.log(`書き込んだ棋譜 ${games} 局 / 条件から外れて消した問題 ${removed} 問`);
  } else {
    const total = byReason.missed_mate + byReason.own_blunder;
    console.log(
      `書き込む予定の棋譜 ${games} 局 / 問題 ${total} 問` +
        `（逃した詰み ${byReason.missed_mate} / 自分の悪手 ${byReason.own_blunder}）`,
    );
    console.log('※ 変更は行っていない');
  }
}

main()
  .then(() => client.end())
  .catch(async (e) => {
    console.error(e);
    await client.end();
    // 本番のランナーが失敗を検知できるよう非ゼロで落とす
    process.exit(1);
  });
