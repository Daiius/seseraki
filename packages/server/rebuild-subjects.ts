/**
 * 主体側（`kifus.subjectSide`）の一括再導出（prd/11 §4.2）。
 *
 * **薄い entry point に徹する。** 導出は `src/users.ts` が持つ。
 * **導出規則そのものを直したとき**に流す（名前候補を変えたときは、その操作の中で
 * 同じトランザクションで引き直されるので、これは要らない）。
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*`（`redetect-tactics.ts` と同じ規約）。
 * **ホストにポートを開けない compose 網内からの実行を推奨する**（AGENTS.md）。
 *
 *   docker compose run --rm --no-deps -e REBUILD_SUBJECTS_APPLY=1 server pnpm --filter server exec tsx rebuild-subjects.ts
 */
import { eq } from 'drizzle-orm';
import { client, db } from './src/db';
import { kifus, users } from './src/db/schema';
import {
  aliasesOf,
  computeSubjectSide,
  replaceSubjectSide,
  subjectInputOf,
} from './src/users';

const APPLY = process.env.REBUILD_SUBJECTS_APPLY === '1';

async function main() {
  const owners = await db.select({ id: users.id }).from(users);
  console.log(
    `ユーザー ${owners.length} 人${APPLY ? '' : '（dry-run。REBUILD_SUBJECTS_APPLY=1 で実書込）'}`,
  );

  let games = 0;
  let resolved = 0;
  for (const owner of owners) {
    const aliases = await aliasesOf(db, owner.id);
    const rows = await db
      .select({ id: kifus.id })
      .from(kifus)
      .where(eq(kifus.ownerId, owner.id));
    games += rows.length;

    if (!APPLY) {
      // 🔒 **これから何になるかを出す。** 現在の保存値を数えるだけでは、導出規則を
      // 直したときに**適用後と違う要約**が出る（dry-run の意味が無い）
      for (const { id } of rows) {
        const input = await subjectInputOf(db, id);
        if (input && computeSubjectSide(input, aliases)) resolved++;
      }
      continue;
    }

    // ⚠ 1 局ずつ原子的に置き換える。全体を 1 トランザクションにはしない
    for (const { id } of rows) {
      const side = await db.transaction((tx) => replaceSubjectSide(tx, id, aliases));
      if (side) resolved++;
    }
  }

  console.log(
    `対象 ${games} 局 / 主体側が決まる ${resolved} 局 / 決まらない ${games - resolved} 局` +
      `${APPLY ? '' : '（この規則を適用したときの見込み）'}`,
  );
  // 🔒 決まらない件数を必ず出す。ambiguous（両対局者とも候補に一致）や
  // 名前候補が未設定の棋譜がここに落ちる（prd/11 §4.1）
  if (!APPLY) console.log('※ 変更は行っていない');
}

main()
  .then(() => client.end())
  .catch(async (e) => {
    console.error(e);
    await client.end();
    process.exit(1);
  });
