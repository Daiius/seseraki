/**
 * 駒の定義（駒種・成り・総数）。
 *
 * 🔒 **駒種・成りの対応・駒の総数の定義はここ 1 か所。** 盤面の追跡（`board.ts`）・盤面編集
 * （`position-edit.ts`）・局面の検証（`position-validation.ts`）はすべてここから引く。
 *
 * ⚠ **駒名の表記はここに集めない。** 成香を `board.ts` は `杏`（KIF の指し手の表記。KIF の往復で
 * 読み書きする）、`position-validation.ts` は `成香`（画面・LLM に出す説明文）と書く。
 * 用途が違うので意図的に別に持つ。
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。
 */

/** 駒の種類 */
export type PieceKind =
  | 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R' | 'K'   // 生駒
  | '+P' | '+L' | '+N' | '+S' | '+B' | '+R';           // 成駒

export type Side = 'sente' | 'gote';

export interface Piece {
  kind: PieceKind;
  side: Side;
}

/** 持ち駒に置ける駒種（玉と成駒は入らない）。USI の打ちに現れる駒文字と同じ */
export type HandPieceKind = 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R';

/** 生駒（玉を含む）。成駒を数えるときはここに戻して数える */
export type BasePieceKind = HandPieceKind | 'K';

/** 生駒の一覧（玉を含む） */
export const BASE_PIECE_KINDS: readonly BasePieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K',
];

/** 駒種ごとの総数（盤上 + 双方の持ち駒 + 駒箱）。成駒は生駒として数える */
export const PIECE_TOTALS: Readonly<Record<BasePieceKind, number>> = {
  P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
};

/** 成り: 生駒 → 成駒 */
export const PROMOTE_MAP: Readonly<Partial<Record<PieceKind, PieceKind>>> = {
  P: '+P', L: '+L', N: '+N', S: '+S', B: '+B', R: '+R',
};

/** 成駒 → 生駒（持ち駒にするとき・枚数を数えるとき） */
export const UNPROMOTE_MAP: Readonly<Partial<Record<PieceKind, BasePieceKind>>> = {
  '+P': 'P', '+L': 'L', '+N': 'N', '+S': 'S', '+B': 'B', '+R': 'R',
};

/**
 * その駒種は成れるか（金・玉・既に成った駒は成れない）。
 * 🔒 **「成れる駒」の定義はここ 1 か所**（`PROMOTE_MAP` から導く）。盤面編集・局面の検証・
 * 出題の「成れる手」の判定はすべてこれを使う。
 */
export function canPromote(kind: PieceKind): boolean {
  return PROMOTE_MAP[kind] !== undefined;
}

/** 成駒なら生駒に戻す。生駒はそのまま */
export function unpromoted(kind: PieceKind): BasePieceKind {
  return UNPROMOTE_MAP[kind] ?? (kind as BasePieceKind);
}

/**
 * 成り状態を指定した駒種。
 * `promote` を省くと元のまま。`true` で成る（成れない駒種は変わらない）、`false` で生駒に戻す。
 */
export function withPromotion(kind: PieceKind, promote?: boolean): PieceKind {
  if (promote === undefined) return kind;
  return promote ? (PROMOTE_MAP[kind] ?? kind) : unpromoted(kind);
}

/** 持ち駒に置ける駒種か（USI の打ちの駒文字の検査にも使う） */
export function isHandPieceKind(kind: string): kind is HandPieceKind {
  return (
    kind === 'P' || kind === 'L' || kind === 'N' || kind === 'S' ||
    kind === 'G' || kind === 'B' || kind === 'R'
  );
}

/** 相手の側 */
export function opponentOf(side: Side): Side {
  return side === 'sente' ? 'gote' : 'sente';
}
