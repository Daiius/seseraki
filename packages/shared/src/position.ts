/**
 * 局面キー（prd/10 §5.1）。
 *
 * **手順前後を吸収して盤の配置で比べる**ために、局面そのものを識別する値を作る。
 * `7g7f 3c3d 2g2f` と `2g2f 3c3d 7g7f` は同じ局面に至るので、**同じキーになる**
 * （構造は木ではなく DAG）。
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。ハッシュ関数（node の `crypto` /
 * Web Crypto）は使えないし、使わない——**キーは SFEN 文字列そのもの**にする:
 *
 * - **衝突しない**。ハッシュだと、別の局面が同じキーになりうる（確率は小さいが、
 *   起きたときに「検索結果に無関係な棋譜が混ざる」という気づきにくい壊れ方をする）
 * - **URL に載せられる**（`/positions?pos=<sfen>`）
 * - **人が読める**。DB を直接見たときに、それがどの局面か分かる
 */
import type { BoardState, PieceKind, Side, Square } from './board';

/** SFEN の駒文字（先手は大文字・後手は小文字。成りは `+` を前置） */
const SFEN_CHAR: Record<PieceKind, string> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R', K: 'K',
  '+P': '+P', '+L': '+L', '+N': '+N', '+S': '+S', '+B': '+B', '+R': '+R',
};

/**
 * `board` バイト列の値（prd/10 §3.2）。
 * **0 = 空 / 1..14 = 先手 / 17..30 = 後手**（上位ビットが側）。
 *
 * 🔒 **1 マス 1 バイトにする。** マスの状態は空 + 14 駒種 × 2 側 = **29 通り**あり、
 * ニブル（4 ビット = 16 値）では表せない。詰めれば 5 ビットに収まるが、
 * 距離の計算（§5.2）でビット取り出しが要るぶん割に合わない。
 */
const PIECE_CODE: Record<PieceKind, number> = {
  P: 1, L: 2, N: 3, S: 4, G: 5, B: 6, R: 7, K: 8,
  '+P': 9, '+L': 10, '+N': 11, '+S': 12, '+B': 13, '+R': 14,
};

/** 後手の駒は上位ビットを立てる（`1..14` → `17..30`） */
const GOTE_FLAG = 16;

/** 持ち駒に成りうる駒種。**SFEN の慣習の順**（飛 → 角 → 金 → 銀 → 桂 → 香 → 歩） */
const HAND_KINDS: PieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

/** `hands` バイト列の並び。先手 7 種 → 後手 7 種（prd/10 §3.2） */
const HAND_ORDER: { side: Side; kind: PieceKind }[] = [
  ...HAND_KINDS.map((kind) => ({ side: 'sente' as const, kind })),
  ...HAND_KINDS.map((kind) => ({ side: 'gote' as const, kind })),
];

/** 盤の 1 段を SFEN にする（空マスは連続数で圧縮） */
function rankToSfen(row: Square[], only?: Side): string {
  let out = '';
  let empty = 0;
  for (const square of row) {
    const piece = square && (!only || square.side === only) ? square : null;
    if (!piece) {
      empty++;
      continue;
    }
    if (empty > 0) {
      out += String(empty);
      empty = 0;
    }
    const char = SFEN_CHAR[piece.kind];
    out += piece.side === 'sente' ? char : char.toLowerCase();
  }
  if (empty > 0) out += String(empty);
  return out;
}

/** 持ち駒を SFEN にする。無ければ `-` */
function handToSfen(state: BoardState, only?: Side): string {
  let out = '';
  for (const { side, kind } of HAND_ORDER) {
    if (only && side !== only) continue;
    const count = state.hand[side][kind] ?? 0;
    if (count === 0) continue;
    if (count > 1) out += String(count);
    const char = SFEN_CHAR[kind];
    out += side === 'sente' ? char : char.toLowerCase();
  }
  return out === '' ? '-' : out;
}

/**
 * 局面キー（SFEN の先頭 3 フィールド: 盤 / 手番 / 持ち駒）。
 *
 * ⚠ **手数は含めない。** 含めると手順前後の合流が起きず、この索引の目的が消える。
 */
export function positionSfen(state: BoardState): string {
  const board = state.board.map((row) => rankToSfen(row)).join('/');
  const side = state.sideToMove === 'sente' ? 'b' : 'w';
  return `${board} ${side} ${handToSfen(state)}`;
}

/**
 * **片側だけ**の配置（盤 + その側の持ち駒）。相手の駒は空として書く。
 *
 * 「自分の駒の配置が似ている局面」を引くための鍵（prd/10 §3.3）。
 * ⚠ **手番は含めない。** 同じ配置なら、どちらの手番でも同じ形として扱う。
 */
export function sideSfen(state: BoardState, side: Side): string {
  const board = state.board.map((row) => rankToSfen(row, side)).join('/');
  return `${board} ${handToSfen(state, side)}`;
}

/** 盤 81 マスを 1 マス 1 バイトで表す（距離の計算に使う。§5.2） */
export function boardBytes(state: BoardState): Uint8Array {
  const out = new Uint8Array(81);
  let i = 0;
  for (const row of state.board) {
    for (const square of row) {
      out[i++] = square
        ? PIECE_CODE[square.kind] + (square.side === 'gote' ? GOTE_FLAG : 0)
        : 0;
    }
  }
  return out;
}

/**
 * 持ち駒の枚数を 14 バイトで表す（先手 7 種 → 後手 7 種）。
 *
 * 🔒 **側と駒種を区別して持つ。** 盤から駒が消えたとき、それが**どちらの持ち駒に
 * なったか**は盤面だけでは復元できない（prd/10 §5.2）。
 */
export function handBytes(state: BoardState): Uint8Array {
  return Uint8Array.from(
    HAND_ORDER.map(({ side, kind }) => Math.min(state.hand[side][kind] ?? 0, 255)),
  );
}

/** `PIECE_CODE` の逆引き（`boardBytes` から局面を戻すのに使う） */
const CODE_PIECE: PieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K',
  '+P', '+L', '+N', '+S', '+B', '+R',
];

/**
 * `boardBytes` / `handBytes` から局面を戻す。
 *
 * 局面索引が持つのはバイト列だけなので、**盤を描くにはここで戻す**（prd/10 §6.2）。
 * ⚠ 手番はバイト列に入っていないので別に渡す。
 */
export function stateFromBytes(
  board: Uint8Array,
  hands: Uint8Array,
  sideToMove: 'b' | 'w',
): BoardState {
  const rows: Square[][] = [];
  for (let r = 0; r < 9; r++) {
    const row: Square[] = [];
    for (let c = 0; c < 9; c++) {
      const code = board[r * 9 + c];
      if (code === 0) {
        row.push(null);
        continue;
      }
      const side: Side = code >= GOTE_FLAG ? 'gote' : 'sente';
      row.push({ kind: CODE_PIECE[(code % GOTE_FLAG) - 1], side });
    }
    rows.push(row);
  }
  const hand: BoardState['hand'] = { sente: {}, gote: {} };
  HAND_ORDER.forEach(({ side, kind }, i) => {
    if (hands[i] > 0) hand[side][kind] = hands[i];
  });
  return {
    board: rows,
    hand,
    sideToMove: sideToMove === 'b' ? 'sente' : 'gote',
  };
}

/** 局面索引 1 行ぶんの値（`kifuPositions`。prd/10 §3.2） */
export interface PositionKey {
  sfen: string;
  senteSfen: string;
  goteSfen: string;
  board: Uint8Array;
  hands: Uint8Array;
  sideToMove: 'b' | 'w';
}

export function positionKey(state: BoardState): PositionKey {
  return {
    sfen: positionSfen(state),
    senteSfen: sideSfen(state, 'sente'),
    goteSfen: sideSfen(state, 'gote'),
    board: boardBytes(state),
    hands: handBytes(state),
    sideToMove: state.sideToMove === 'sente' ? 'b' : 'w',
  };
}

/**
 * 2 つの局面の距離（prd/10 §5.2）。
 *
 * ```
 * dist = Σ(81 マス)[ 駒種・側が不一致 ] + Σ(側 × 駒種) | 持ち駒枚数の差 |
 * ```
 *
 * 🔒 **持ち駒は側と駒種まで区別して数える。** 相手の持ち駒か自分の持ち駒かは
 * 別の意味を持つので、独立した情報として数える。
 *
 * ⚠ **この定義は初期値**。使ってみて不満が出たら変える前提で、SQL ではなくここに置く。
 */
export function positionDistance(
  a: { board: Uint8Array; hands: Uint8Array },
  b: { board: Uint8Array; hands: Uint8Array },
): number {
  let dist = 0;
  for (let i = 0; i < 81; i++) if (a.board[i] !== b.board[i]) dist++;
  for (let i = 0; i < 14; i++) dist += Math.abs(a.hands[i] - b.hands[i]);
  return dist;
}
