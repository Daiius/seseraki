/**
 * 戦型ラベルの一括再判定（prd/01 §6.4「判定ロジックを更新したら一括再判定する」）。
 *
 * **薄い entry point に徹する。** 判定は `shared`、置換は `src/tactics.ts` が持つ。
 * 将来この配置を「本番 server イメージへ同梱し、使い捨てコンテナで実行する」形へ移しても、
 * ここを esbuild のエントリに足すだけで中身は変わらない。
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*` から取る（`migrate.ts` と同じ規約）。
 * **ホストにポートを開けない compose 網内からの実行を推奨する**（AGENTS.md）。
 *
 *   docker compose run --rm --no-deps -e REDETECT_APPLY=1 server pnpm --filter server exec tsx redetect-tactics.ts
 */
import { eq, isNotNull } from 'drizzle-orm';
import { detectTactics } from 'shared';
import { client, db } from './src/db';
import { kifus } from './src/db/schema';
import { replaceTactics } from './src/tactics';

const APPLY = process.env.REDETECT_APPLY === '1';

async function main() {
  // ⚠ **ここでは id しか読まない。** 指し手列を先に読み溜めて後から置換すると、その間に
  // 走った `reanalyze`（usiMoves とラベルを同一トランザクションで更新する）の結果を、
  // **古い指し手列から作ったラベルで上書きしてしまう**。正である kifus.usiMoves と
  // kifuTactics がずれ、絞り込みと集計が静かに誤る。
  const ids = await db
    .select({ id: kifus.id })
    .from(kifus)
    .where(isNotNull(kifus.usiMoves));

  console.log(`対象 ${ids.length} 局${APPLY ? '' : '（dry-run。REDETECT_APPLY=1 で実書込）'}`);

  let changed = 0;
  let labels = 0;
  for (const { id } of ids) {
    if (APPLY) {
      // **1 局ずつ原子的に置換する**（prd/03 §2.1）。全体を 1 トランザクションにはしない。
      // 同じトランザクションの中で `FOR UPDATE` により kifus の行ロックを取ってから
      // usiMoves を読むので、reanalyze と直列化される（あちらも kifus の UPDATE を先に置いて
      // 行ロックを取る）。取得順が揃うのでデッドロックしない。
      const n = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ usiMoves: kifus.usiMoves })
          .from(kifus)
          .where(eq(kifus.id, id))
          .for('update');
        // ロック取得までに消えた / usiMoves が null になった場合は空に置換して終わり
        if (!row) return 0;
        return replaceTactics(tx, id, row.usiMoves);
      });
      if (n > 0) changed++;
      labels += n;
    } else {
      const [row] = await db
        .select({ usiMoves: kifus.usiMoves })
        .from(kifus)
        .where(eq(kifus.id, id));
      const detected = detectTactics(row?.usiMoves ?? []);
      labels += detected.length;
      if (detected.length > 0) changed++;
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
