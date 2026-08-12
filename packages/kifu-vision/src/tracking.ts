/**
 * 盤面だけでなく持ち駒も追う
 *
 * これまで追跡していたのは `Square[][]`（盤の 81 マス）だけだった。それでも
 * 手は復元できるが、**「持っていない駒を打つ」という偽の手を弾けない**。
 * マウスポインタや演出で駒が湧いて見えると、差分は「空 → 駒」になり、
 * これはちょうど「打ち」の形なので、そのまま通ってしまう。
 *
 * `BoardState`（盤＋持ち駒＋手番）ごと進めれば、偽の打ちは原理的に消える。
 *
 * ⚠ **困るのは仕切り直しのとき。** 途中の局面から追跡を始めると、盤に無い駒が
 * どちらの持ち駒かは**盤面からは決して分からない**（取った側にしか分からない）。
 * そこは「どちらも持っているかもしれない」として扱う。候補が増えるだけで、
 * 正しい手が消えることはない。
 */

import type { BoardState, PieceKind, Side, Square } from 'shared';
import { createInitialState } from 'shared';

/** 将棋の駒は全部でこれだけある。盤に無いぶんは誰かの持ち駒。 */
export const TOTAL_PIECES: Record<PieceKind, number> = {
  P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
  '+P': 0, '+L': 0, '+N': 0, '+S': 0, '+B': 0, '+R': 0,
};

/** 成駒は元の駒として数える（持ち駒に戻れば生駒に戻る） */
const UNPROMOTE: Record<PieceKind, PieceKind> = {
  P: 'P', L: 'L', N: 'N', S: 'S', G: 'G', B: 'B', R: 'R', K: 'K',
  '+P': 'P', '+L': 'L', '+N': 'N', '+S': 'S', '+B': 'B', '+R': 'R',
};

/**
 * 盤に載っていない駒を数える。
 *
 * これが**持ち駒の総量**（両者ぶんの合計）。どちらが持っているかは分からない。
 */
export function offBoardPieces(board: Square[][]): Partial<Record<PieceKind, number>> {
  const onBoard = new Map<PieceKind, number>();
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      const base = UNPROMOTE[sq.kind];
      onBoard.set(base, (onBoard.get(base) ?? 0) + 1);
    }
  }
  const out: Partial<Record<PieceKind, number>> = {};
  for (const [kind, total] of Object.entries(TOTAL_PIECES) as [PieceKind, number][]) {
    if (total === 0) continue;
    const left = total - (onBoard.get(kind) ?? 0);
    if (left > 0) out[kind] = left;
  }
  return out;
}

/**
 * 途中の局面から追跡を始めるための状態を作る。
 *
 * ⚠ **持ち駒は「両者がすべて持っているかもしれない」として渡す。** これは
 * 嘘だが、**候補を広げる方向の嘘**なので正しい手を落とさない。狭める方向に
 * 間違えると（例えば「持ち駒は無い」と決めつけると）本当に指された打ちが
 * 候補から消え、そこで追跡が切れる。**分からないときは広い方へ倒す。**
 */
export function startFromBoard(board: Square[][], sideToMove: Side): BoardState {
  const off = offBoardPieces(board);
  return {
    board: board.map((r) => r.slice()),
    hand: { sente: { ...off }, gote: { ...off } },
    sideToMove,
  };
}

/** 盤面が平手の初期配置とまったく同じか */
export function isInitialBoard(board: Square[][]): boolean {
  const initial = createInitialState().board;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const a = board[row][col];
      const b = initial[row][col];
      if (!a || !b) {
        if (a !== b) return false;
        continue;
      }
      if (a.kind !== b.kind || a.side !== b.side) return false;
    }
  }
  return true;
}

/**
 * 読めなかった穴を除けば初期配置と言えるか。言えるなら**穴を埋めた盤**を返す。
 *
 * ⭐ 起点の絵で 1 マス読めないことは珍しくない（ポインタは常に盤上のどこかにいる）。
 * そのせいで初期局面と見なされないと、**持ち駒が「不明」になって偽の打ちが
 * 通ってしまう**。実際、1 局目の 1 手目が `P*1c` になっていた——起点で 1c が
 * 読めず、次の時点で歩が現れたので「打った」ことにされていた。
 *
 * ⚠ **判定は「足りない」だけを許し、「余分」「別物」は許さない。** 実戦の途中の
 * 局面は必ず初期配置に無いマスへ駒が出るので、取り違える余地は小さい。
 *
 * @param maxHoles 許す穴の数。ここを大きくすると、序盤の局面まで初期局面と
 *   見なしてしまう。数マスに留める。
 */
export function completeIfInitial(board: Square[][], maxHoles = 3): Square[][] | null {
  const initial = createInitialState().board;
  let holes = 0;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const seen = board[row][col];
      const want = initial[row][col];
      if (!seen && !want) continue;
      if (seen && !want) return null; // 初期配置に無いマスに駒がある＝途中の局面
      if (!seen && want) { holes++; continue; }
      if (seen!.kind !== want!.kind || seen!.side !== want!.side) return null;
    }
  }
  return holes <= maxHoles ? initial.map((r) => r.slice()) : null;
}

/**
 * 起点の状態を決める。
 *
 * 初期局面から始められるなら**持ち駒も手番も分かっている**ので、そちらを使う。
 * 追跡が続く限り正確なままなので、偽の打ちを完全に弾ける。
 */
export function startState(board: Square[][], sideToMove: Side): BoardState {
  const completed = completeIfInitial(board);
  if (completed) return { ...createInitialState(), board: completed };
  return startFromBoard(board, sideToMove);
}

/**
 * その手を本当に指せるか。
 *
 * ⚠ **`shared` の `applyMove` は検証しない。** 既知の棋譜を再生するための道具なので、
 * 持っていない駒の打ちも黙って通す（持ち駒の数が負になって消えるだけ）。
 * 復元の側では、そこを通してしまうと**偽の打ちが棋譜に残る**。
 *
 * 見るのは打ちだけでよい。盤上の移動は `legality.ts` と差分の側で既に絞られている。
 */
export function canPlay(state: BoardState, usi: string, side: Side): boolean {
  const drop = usi.match(/^([PLNSGBR])\*/);
  if (!drop) return true;
  return (state.hand[side][drop[1] as PieceKind] ?? 0) > 0;
}

/** 持ち駒が「分からないので両者に持たせた」状態か */
export function handsAreGuessed(state: BoardState): boolean {
  const off = offBoardPieces(state.board);
  const same = (h: Partial<Record<PieceKind, number>>) =>
    Object.keys(off).length === Object.keys(h).length &&
    (Object.entries(off) as [PieceKind, number][]).every(([k, v]) => h[k] === v);
  return Object.keys(off).length > 0 && same(state.hand.sente) && same(state.hand.gote);
}
