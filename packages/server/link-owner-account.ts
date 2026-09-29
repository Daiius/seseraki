/**
 * 所有者のログイン手段の付け替え（prd/07 §4・§4.1）。**移行のときに 1 回だけ実行する。**
 *
 * 所有者が初めて Google でログインして作られた user（X）の account を所有者（"1"）へ付け替え、
 * X を消す。**既定は dry-run**（対象の X のメール・名前を表示して止まる）、`LINK_OWNER_APPLY=1` で実書込。
 *
 *   docker compose run --rm --no-deps <server サービス> /app/link-owner-account.js
 *   docker compose run --rm --no-deps -e LINK_OWNER_APPLY=1 <server サービス> /app/link-owner-account.js
 *   （開発時: pnpm --filter server exec tsx link-owner-account.ts [--provider credential] [--email <メール>]）
 *
 * - `--provider` 既定 `google`（dev の練習では `credential`。prd/07 §6.3）
 * - `--email` 対象をメールで絞る（窓の間に他人が入り込んで対象が複数になったとき）
 *
 * 🔒 確認（対象がちょうど 1 行・"1" にその provider の account が無い）は**コードで強制する**。
 * ⚠ **dry-run の出力でメールが所有者のものか必ず目で確かめる。** 他人の X を付け替えると全データを渡す。
 */
import { client, db } from './src/db';
import { describeLink, linkOwnerAccount } from './src/owner-account';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.env.LINK_OWNER_APPLY === '1';
const provider = arg('provider') ?? 'google';
const email = arg('email');

async function main(): Promise<number> {
  const result = await linkOwnerAccount(db, { provider, apply: APPLY, email });
  console.log(describeLink(provider, result));
  // 付け替えられる状態でなければ非 0 で終わる（dry-run の ready は 0）
  return result.decision.kind === 'ready' ? 0 : 1;
}

main()
  .then(async (code) => {
    await client.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e);
    await client.end();
    process.exit(1);
  });
