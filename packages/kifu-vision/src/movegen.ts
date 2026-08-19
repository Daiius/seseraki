/**
 * その局面で指せる手を全部並べる
 *
 * いままでの読み方は「81 マスを読む → 差分を 1 手として説明できるか」だった。
 * これは**開いた集合に問いを投げている**——マスごとに「20 種のどれか」を
 * 当てにいくので、読めないマスが 1 つあると手が決まらない。
 *
 * 向きを逆にすると閉じる。**起こりうる盤面を先に列挙して、どれが画素と
 * いちばん整合するかを選ぶ**なら、
 *
 *   - 読むべきマスが 2 つで済む（候補ごとに変わるのは移動元と移動先だけ）
 *   - 移動先が読めなくても「候補のどれと矛盾しないか」を決めればよい
 *   - ⭐ **成/不成が、成駒のテンプレートが無くても決まる。** 候補は必ず
 *     「X か +X」の 2 つで、生駒のテンプレートは必ず持っているので、
 *     「生駒に見えないなら成っている」という消去法が使える
 *   - 持ち駒を追えば「持っていない駒を打つ」偽手が原理的に消える。
 *     マウスポインタによる偽の駒出現は「打ち」に化けるので、ここが効く
 *
 * ⚠ **これは読みを置き換えるものではない。** 追跡中の盤面が間違っていれば
 * 候補も丸ごと間違う（誤りが自己強化する）。読みで決まらないときの
 * second opinion として足す。
 *
 * ⚠ **打ち歩詰めは判定しない。** 実戦でほぼ現れないうえ、判定には詰み探索が
 * 要る。候補が 1 手多いだけなので、second opinion としては困らない。
 */

import type { BoardState, PieceKind, Side, Square } from 'shared';
import { canDrop, canMove, canPromote, mustPromote } from './legality.ts';
import { toUsiSquare } from './moves.ts';

export interface CandidateMove {
  usi: string;
  /** 打つ手なら null */
  from: { row: number; col: number } | null;
  to: { row: number; col: number };
  /** 動かす前の駒種（打つ手なら打つ駒） */
  kind: PieceKind;
  /** 動いた後にそのマスに載る駒種。成れば成駒になる。 */
  becomes: PieceKind;
  promotes: boolean;
  /** 取った駒（取らなければ null） */
  captures: PieceKind | null;
  side: Side;
}

const PROMOTES_TO: Partial<Record<PieceKind, PieceKind>> = {
  P: '+P', L: '+L', N: '+N', S: '+S', B: '+B', R: '+R',
};

/** 打てる駒種（玉と金は成らないので、持ち駒も生駒のまま） */
const DROPPABLE: PieceKind[] = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];

const inBoard = (r: number, c: number) => r >= 0 && r < 9 && c >= 0 && c < 9;

/** 玉のいるマス。取られていれば null（読み違えた盤面ではあり得る）。 */
export function findKing(board: Square[][], side: Side): { row: number; col: number } | null {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (p && p.kind === 'K' && p.side === side) return { row, col };
    }
  }
  return null;
}

/**
 * その側の玉が今すぐ取られる形か。
 *
 * ⚠ 玉が盤上に無ければ false を返す。**認識が壊れた盤面では起こりうる**ので、
 * ここで例外を投げると走査全体が止まる。おかしな盤面は `sanity.ts` の仕事。
 */
export function isInCheck(board: Square[][], side: Side): boolean {
  const king = findKing(board, side);
  if (!king) return false;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (!p || p.side === side) continue;
      if (canMove(board, { row, col }, king, p.kind, p.side)) return true;
    }
  }
  return false;
}

function withMove(
  board: Square[][],
  from: { row: number; col: number } | null,
  to: { row: number; col: number },
  piece: { kind: PieceKind; side: Side },
): Square[][] {
  const next = board.map((r) => r.slice());
  if (from) next[from.row][from.col] = null;
  next[to.row][to.col] = piece;
  return next;
}

/**
 * 二歩になるか。**成っていない歩**だけが対象（と金は何枚あってもよい）。
 */
function wouldDoublePawn(board: Square[][], col: number, side: Side): boolean {
  for (let row = 0; row < 9; row++) {
    const p = board[row][col];
    if (p && p.side === side && p.kind === 'P') return true;
  }
  return false;
}

export interface GenerateOptions {
  /**
   * 自分の玉が取られる手を除くか。既定は除く。
   *
   * ⚠ 追跡中の盤面が壊れていると、王手放置の判定まで壊れて**正しい手まで
   * 消える**。候補が空になったときに呼び出し側が false で引き直せるように
   * 開けてある。
   */
  legalOnly?: boolean;
}

/**
 * `state.sideToMove` の側が指せる手を全部返す。
 *
 * 1 局面あたり 80〜120 手程度なので、素直に総当たりして構わない。
 */
export function generateMoves(state: BoardState, options: GenerateOptions = {}): CandidateMove[] {
  const legalOnly = options.legalOnly ?? true;
  const side = state.sideToMove;
  const board = state.board;
  const out: CandidateMove[] = [];

  const push = (m: CandidateMove) => {
    if (legalOnly) {
      const after = withMove(board, m.from, m.to, { kind: m.becomes, side });
      if (isInCheck(after, side)) return;
    }
    out.push(m);
  };

  // --- 盤上の駒を動かす ---
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (!piece || piece.side !== side) continue;
      const from = { row, col };

      for (let tr = 0; tr < 9; tr++) {
        for (let tc = 0; tc < 9; tc++) {
          if (!inBoard(tr, tc)) continue;
          const target = board[tr][tc];
          if (target && target.side === side) continue; // 自分の駒は取れない
          // 🔒 **玉を取る手は合法手ではない。** ここを開けておくと、認識がずれた局面で
          // 「相手玉を消す手」が候補に入り、絵といちばん整合すれば採用されてしまう。
          // 通し再生も同じ生成器を使うので、その誤りを「合法」と数えてしまう。
          if (target && target.kind === 'K') continue;
          const to = { row: tr, col: tc };
          if (!canMove(board, from, to, piece.kind, side)) continue;

          const usiBase = `${toUsiSquare(row, col)}${toUsiSquare(tr, tc)}`;
          const captures = target ? target.kind : null;
          const promoted = PROMOTES_TO[piece.kind];
          const mayPromote = promoted !== undefined && canPromote(from, to, side);
          const forced = mustPromote(piece.kind, to, side);

          // 成らずに動く手。行き所が無くなるなら指せない。
          if (!forced) {
            push({
              usi: usiBase, from, to, kind: piece.kind, becomes: piece.kind,
              promotes: false, captures, side,
            });
          }
          if (mayPromote) {
            push({
              usi: `${usiBase}+`, from, to, kind: piece.kind, becomes: promoted,
              promotes: true, captures, side,
            });
          }
        }
      }
    }
  }

  // --- 持ち駒を打つ ---
  const hand = state.hand[side];
  for (const kind of DROPPABLE) {
    if (!hand[kind]) continue;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        if (board[row][col]) continue;
        const to = { row, col };
        if (!canDrop(kind, to, side)) continue;
        if (kind === 'P' && wouldDoublePawn(board, col, side)) continue;
        push({
          usi: `${kind}*${toUsiSquare(row, col)}`, from: null, to,
          kind, becomes: kind, promotes: false, captures: null, side,
        });
      }
    }
  }

  return out;
}

/**
 * 候補手のうち、**移動先と移動元だけ**を見れば区別が付く形にまとめる。
 *
 * 画素と突き合わせるとき、盤面全体を作り直す必要は無い。同じ (from, to) を
 * 持つ候補は「成るか成らないか」しか違わないので、**そのマスに載る駒種が
 * 生駒か成駒か**さえ決まれば選べる。生駒のテンプレートは必ず持っているので、
 * **成駒のテンプレートが 1 枚も無くてもここは決まる。**
 */
export function groupByDestination(
  moves: CandidateMove[],
): Map<string, CandidateMove[]> {
  const groups = new Map<string, CandidateMove[]>();
  for (const m of moves) {
    const key = `${m.from ? `${m.from.row},${m.from.col}` : 'drop'}->${m.to.row},${m.to.col}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}
