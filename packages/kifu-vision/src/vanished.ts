/**
 * 「駒が消えただけ」に見える絵を、未確定のマスで説明し直す
 *
 * `inferMove` は「移動元が空いたのに移動先が埋まっていない」形を
 * `piece-vanished` と呼び、**駒のスライド途中の絵**として捨てる。
 * 「駒が盤から消えるだけの手は将棋に存在しない」という正しい理屈に基づく。
 *
 * ⚠ **だが、消えて見える理由はもう一つある。移動先が読めていない場合。**
 * 移動先が未確定なら直前の配置を引き継ぐので、そこは「前のまま」になり、
 * 変化として現れない。結果、移動元が空いただけの絵になる。
 *
 * 実測（14:06 の 7g）:
 *
 * - 後手の香が 7g へ動いて成った（▽杏）。**その駒のテンプレートを持っていない**
 * - 7g は NCC 0.198 で未確定 → 前の配置（▲角）を引き継ぐ
 * - 移動元の 7f は正しく「空」と読める
 * - 差分は 1 マスだけ、しかも「駒が消えた」形 → **アニメーションとして破棄**
 * - 数秒後に銀が取り返して 7g が読めた瞬間、差分が 3 マスに膨れて追跡が切れる
 *
 * ⭐ **移動先が未確定なら、「そこへ動いた」と考えるのが自然。**
 * スライド途中の絵なら移動先も移動元も空で、未確定ではない。**両者は区別できる。**
 *
 * 駒種までは決められない（成ったかどうかは絵が読めないと分からない）ので、
 * 呼び出し側で確定待ちに積み、後の場面で読めたら直す。
 */

import type { PieceKind, Square, Side } from 'shared';
import { canMove, canPromote, mustPromote } from './legality.ts';
import { toUsiSquare } from './moves.ts';
import { checkBoard } from './sanity.ts';
import { isUnknown, type VisionSquare } from './uncertain.ts';

export interface VanishRescue {
  usi: string;
  side: Side;
  from: { row: number; col: number };
  to: { row: number; col: number };
  /** 成ったかどうかは絵が読めていないので決めきれない。後の場面で確かめる。 */
  promotionUncertain: boolean;
  board: Square[][];
}

function promoted(kind: PieceKind): PieceKind {
  return kind.startsWith('+') ? kind : (`+${kind}` as PieceKind);
}

/**
 * 消えた駒の行き先を、未確定のマスの中から探す。
 *
 * @param before 追跡中の盤面
 * @param after 未確定を引き継いで埋めた盤面（`before` と 1 マスだけ違う）
 * @param read 読みそのもの（どこが未確定かが分かる）
 * @returns 行き先が一意に決まったときだけ返す。決まらなければ null。
 */
export function rescueVanished(
  before: Square[][],
  after: Square[][],
  read: VisionSquare[][],
): VanishRescue | null {
  // 「駒が消えただけ」の形かを確かめる
  let from: { row: number; col: number; piece: Square } | null = null;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const b = before[row][col];
      const a = after[row][col];
      const same = (!b && !a) || (b && a && b.kind === a.kind && b.side === a.side);
      if (same) continue;
      if (b && !a && !from) {
        from = { row, col, piece: b };
        continue;
      }
      return null; // 消える以外の変化があるなら、この経路ではない
    }
  }
  if (!from || !from.piece) return null;

  const moving = from.piece;
  const candidates: VanishRescue[] = [];

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      // 行き先は**読めていないマス**に限る。読めているのにそこへ動いたのなら、
      // 差分に現れているはずで、この経路には来ない。
      if (!isUnknown(read[row][col])) continue;
      const target = before[row][col];
      if (target && target.side === moving.side) continue; // 自分の駒は取れない
      if (target && target.kind === 'K') continue; // 玉は取られない
      if (!canMove(before, from, { row, col }, moving.kind, moving.side)) continue;

      const board = before.map((r) => r.slice());
      board[from.row][from.col] = null;

      // 成ったかどうかは絵が読めないので決められない。成らずを既定にして、
      // 成らねばならない形だけは成りにする。後の場面で読めたら直す。
      const forced = mustPromote(moving.kind, { row }, moving.side);
      const kind = forced ? promoted(moving.kind) : moving.kind;
      board[row][col] = { kind, side: moving.side };
      if (!checkBoard(board).ok) continue;

      const mayPromote =
        !forced && !moving.kind.startsWith('+') && canPromote(from, { row, col }, moving.side);
      candidates.push({
        usi: `${toUsiSquare(from.row, from.col)}${toUsiSquare(row, col)}${forced ? '+' : ''}`,
        side: moving.side,
        from: { row: from.row, col: from.col },
        to: { row, col },
        promotionUncertain: mayPromote,
        board,
      });
    }
  }

  // ⚠ 行き先が 2 つ以上あるなら決められない。**当てずっぽうで選ばない。**
  return candidates.length === 1 ? candidates[0] : null;
}
