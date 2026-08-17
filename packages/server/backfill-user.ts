/**
 * ユーザーの表示名と名前候補を設定する（prd/11 §6.2）。**移行のときに 1 回だけ実行する。**
 *
 * 🔒 **名前は env にもコードにも置かない。** env に置くと消し忘れ、そちらが正だと読まれる。
 * コードに埋めると公開リポにアカウント名が乗る（prd/README §秘匿方針）。だから引数で渡す。
 *
 * ⚠ **マイグレーション（prd/11 §6.1）の後に実行する。** `users` の行と `kifus.ownerId` は
 * そちらが作っているので、ここは**名前に関わることだけ**を扱う。
 *
 *   pnpm db:backfill-user --display "<表示名>" --names "<名前1>,<名前2>" [--apply]
 *
 * 接続先は呼び出し環境の `DB_HOST` / `DB_PORT` / `MYSQL_*`（`migrate.ts` と同じ規約）。
 * **ホストにポートを開けない compose 網内からの実行を推奨する**（AGENTS.md）。
 */
import { eq } from 'drizzle-orm';
import { client, db } from './src/db';
import { userAliases, users } from './src/db/schema';
import { aliasesOf, currentUserId, rebuildSubjectSides } from './src/users';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const display = arg('display');
const namesRaw = arg('names');

if (!display || !namesRaw) {
  console.error(
    '使い方: tsx backfill-user.ts --display "<表示名>" --names "<名前1>,<名前2>" [--apply]',
  );
  process.exit(1);
}

const names = [
  ...new Set(
    namesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
if (names.length === 0) {
  console.error('--names が空');
  process.exit(1);
}

async function main() {
  const userId = await currentUserId();
  const existing = await aliasesOf(db, userId);
  const existingNames = new Set(existing.map((a) => a.name));
  const toAdd = names.filter((n) => !existingNames.has(n));

  console.log(`ユーザー #${userId}`);
  console.log(`  表示名: ${display}`);
  console.log(`  既存の名前候補: ${existing.length} 件`);
  console.log(`  追加する名前候補: ${toAdd.length} 件`);
  if (!APPLY) {
    console.log('\n※ dry-run。--apply で書き込む');
    return;
  }

  const updated = await db.transaction(async (tx) => {
    await tx.update(users).set({ displayName: display! }).where(eq(users.id, userId));
    if (toAdd.length > 0) {
      await tx
        .insert(userAliases)
        .values(toAdd.map((name) => ({ userId, name })));
    }
    // 🔒 名前候補を変えたら同じトランザクションで主体側を引き直す（prd/11 §4.2）
    return rebuildSubjectSides(tx, userId);
  });
  console.log(`\n主体側を導出し直した棋譜: ${updated} 局`);
}

main()
  .then(() => client.end())
  .catch(async (e) => {
    console.error(e);
    await client.end();
    process.exit(1);
  });
