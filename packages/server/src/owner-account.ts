/**
 * 既存アカウント（所有者 `"1"`）へのログイン手段の付け替え（prd/07 §4）。
 *
 * 所有者が初めて Google でログインすると、Better Auth は新しい user（X）と account（sub → X）を作る。
 * **account を X → `"1"` に付け替え、X の Google の値を `"1"` に写し、X を消す。**
 * 棋譜・出題・名前候補は `"1"` のまま一切動かさない。
 *
 * 🔒 **本番の同梱エントリ（`link-owner-account.ts`）と dev ログイン（`dev-login.ts`）が同じ関数を使う。**
 * 本番で一度しか流さないコードが、dev で毎回通る（prd/07 §4.1・§6.1）。
 */
import { and, eq, ne } from 'drizzle-orm';
import type { db as Db } from './db/index.js';
import { account, users } from './db/schema.js';
import { OWNER_USER_ID } from './users.js';

export interface LinkCandidate {
  userId: string;
  email: string;
  name: string;
}

export type LinkDecision =
  /** 付け替えてよい（対象がちょうど 1 行・`"1"` にその provider の account が無い） */
  | { kind: 'ready'; candidate: LinkCandidate }
  /** `"1"` には既にその provider の account がある（付け替え済み） */
  | { kind: 'already-linked'; candidates: LinkCandidate[] }
  /** 付け替える account が無い（まだログインしていない） */
  | { kind: 'none' }
  /** 対象が 2 行以上。**どれが所有者か機械的に決めない** */
  | { kind: 'ambiguous'; candidates: LinkCandidate[] };

/**
 * 手順 0 の確認（prd/07 §4）を**コードで強制する**。満たさなければ `ready` を返さない。
 */
export function decideOwnerLink(
  candidates: LinkCandidate[],
  ownerHasProvider: boolean,
): LinkDecision {
  if (ownerHasProvider) return { kind: 'already-linked', candidates };
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'ready', candidate: candidates[0]! };
}

export interface LinkOptions {
  /** 本番は 'google'（dev ログインは 'credential'） */
  provider: string;
  /** false なら判定だけして書き込まない（dry-run） */
  apply: boolean;
  /** 対象をメールで絞る（窓の間に他人が入り込んで対象が複数になったとき用） */
  email?: string;
}

export interface LinkResult {
  decision: LinkDecision;
  applied: boolean;
}

/**
 * 付け替える。**1 トランザクション**で判定から書き込みまで行う（判定と書き込みの間に行が変わらない）。
 *
 * ⚠ **呼ぶ前に（dry-run の出力で）メールが所有者のものか目で確かめる**（prd/07 §4）。
 * 窓の間に他人が先にログインしていた場合、その X を付け替えると他人に全データを渡す。
 */
export async function linkOwnerAccount(
  database: typeof Db,
  { provider, apply, email }: LinkOptions,
): Promise<LinkResult> {
  return database.transaction(async (tx) => {
    const candidates = await tx
      .select({ userId: account.userId, email: users.email, name: users.name })
      .from(account)
      .innerJoin(users, eq(users.id, account.userId))
      .where(
        and(
          eq(account.providerId, provider),
          ne(account.userId, OWNER_USER_ID),
          email ? eq(users.email, email.toLowerCase()) : undefined,
        ),
      )
      .for('update');
    const owned = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.providerId, provider),
          eq(account.userId, OWNER_USER_ID),
        ),
      )
      .for('update');
    const decision = decideOwnerLink(candidates, owned.length > 0);
    if (decision.kind !== 'ready' || !apply)
      return { decision, applied: false };

    const x = decision.candidate.userId;
    const [from] = await tx
      .select({
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        image: users.image,
      })
      .from(users)
      .where(eq(users.id, x));
    if (!from) throw new Error(`付け替え元の user が無い: ${x}`);
    // 1. account を "1" に付け替える
    await tx
      .update(account)
      .set({ userId: OWNER_USER_ID })
      .where(and(eq(account.providerId, provider), eq(account.userId, x)));
    // 2. X を消す（session は CASCADE で消える。account は付け替え済みなので残る）。
    //    ⚠ kifus.ownerId は CASCADE でないので、X が棋譜を持っていればここで FK に止められる
    await tx.delete(users).where(eq(users.id, x));
    // 3. X の値を "1" に写す（email は UNIQUE なので X を消した後）。displayName は触らない
    await tx
      .update(users)
      .set({
        name: from.name,
        email: from.email,
        emailVerified: from.emailVerified,
        image: from.image,
      })
      .where(eq(users.id, OWNER_USER_ID));
    return { decision, applied: true };
  });
}

/** dry-run / 実行結果を人が読む形にする（エントリの出力） */
export function describeLink(provider: string, result: LinkResult): string {
  const { decision, applied } = result;
  const list = (cs: LinkCandidate[]) =>
    cs
      .map((c) => `  - user=${c.userId} email=${c.email} name=${c.name}`)
      .join('\n');
  switch (decision.kind) {
    case 'ready':
      return [
        `付け替え対象（provider=${provider}）:`,
        list([decision.candidate]),
        applied
          ? `→ "${OWNER_USER_ID}" に付け替えた`
          : '※ dry-run。メールが所有者のものか確かめてから LINK_OWNER_APPLY=1 で実行する',
      ].join('\n');
    case 'already-linked':
      return [
        `"${OWNER_USER_ID}" には既に ${provider} の account がある。付け替えない`,
        decision.candidates.length > 0
          ? `他の user の ${provider} account:\n${list(decision.candidates)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'none':
      return `付け替える ${provider} の account が無い（所有者がまだログインしていない）`;
    case 'ambiguous':
      return [
        `対象が ${decision.candidates.length} 行ある。どれが所有者か決められないので止める`,
        list(decision.candidates),
        '→ 所有者のものを --email で指定するか、他人の行を消してからやり直す',
      ].join('\n');
  }
}
