// 自分（本人）判定。
// 将棋アプリごとに自分の対局者名が異なる（例: "Daiius" と "daiius"）ため、
// 複数の名前候補のいずれかに一致すれば自分とみなす。
//
// - 判定候補 = VITE_SELF_NAMES（カンマ区切り）∪ {VITE_SWARS_USER_ID}
//   VITE_SWARS_USER_ID は swars 取得の対象アカウント ID（単一）だが、
//   swars 由来の棋譜では自分名でもあるため候補に含める。
// - 対局者名はアプリをまたぐと衝突しうるため、両対局者とも候補に一致した場合は
//   自分の側を確定できない（ambiguous）。呼び出し側は警告表示に用いる。

/** env から自分の名前候補一覧を取得（重複除去・空白/空文字除外）。 */
export function getSelfNames(): string[] {
  const raw = [
    import.meta.env.VITE_SELF_NAMES,
    import.meta.env.VITE_SWARS_USER_ID,
  ]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(raw)];
}

export type UserSide = 'sente' | 'gote' | null;

export interface ResolvedUserSide {
  /** 自分の側。未設定・不一致・両者一致（ambiguous）のときは null。 */
  side: UserSide;
  /** 両対局者とも自分の名前候補に一致し、側を確定できなかった。 */
  ambiguous: boolean;
}

/**
 * 対局者名から自分の側を判定する。
 * sente/gote の一方だけが候補に一致すればその側、両方一致なら ambiguous。
 */
export function resolveUserSide(
  sente: string | null | undefined,
  gote: string | null | undefined,
  names: string[] = getSelfNames(),
): ResolvedUserSide {
  if (names.length === 0) return { side: null, ambiguous: false };
  const set = new Set(names);
  const senteIsSelf = sente != null && set.has(sente);
  const goteIsSelf = gote != null && set.has(gote);
  if (senteIsSelf && goteIsSelf) return { side: null, ambiguous: true };
  if (senteIsSelf) return { side: 'sente', ambiguous: false };
  if (goteIsSelf) return { side: 'gote', ambiguous: false };
  return { side: null, ambiguous: false };
}
