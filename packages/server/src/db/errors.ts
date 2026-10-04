/**
 * DB のエラーの判定（Postgres の SQLSTATE を見る）。
 *
 * ⚠ **メッセージの文字列で判定しない。** drizzle はドライバのエラーを `DrizzleQueryError` で包み、
 * `message` は「Failed query: <SQL>」になる——**本当の理由は `cause` に連なっている**。
 * MySQL の頃の `message.includes('Duplicate')` は方言の文言に依存していた。
 */
const UNIQUE_VIOLATION = '23505';

/** `err` かその `cause` の連なりに、指定の SQLSTATE を持つものがあるか */
function hasSqlState(err: unknown, code: string): boolean {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === code) return true;
  }
  return false;
}

/** 一意制約違反（UNIQUE / PK の重複） */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, UNIQUE_VIOLATION);
}
