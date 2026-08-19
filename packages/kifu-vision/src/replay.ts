/**
 * 書き出した棋譜を、初期局面から通しで再生して確かめる
 *
 * 走査中も 1 手ごとに合法性は見ている（`legality.ts` / `movegen.ts`）。
 * ⚠ **だがそれは「追跡中の盤面」に対する検査で、その盤面は映像から
 * 再同期される。** 手を 1 つ取りこぼしても、次に読めた絵で盤面が実際の
 * 局面に戻るので、走査中は何事も無かったように進める。
 * **書き出された手の列が初期局面から繋がる保証はどこにも無い。**
 *
 * 実測（2026-08-14・`0 1833 0.5` の出力）:
 *
 * | | 合法 | 手番の抜け | 非合法 |
 * |---|---|---|---|
 * | 1 局目 | 92 / 92 | 1（0:07） | 0 |
 * | 2 局目 | 79 / 80 | 1（20:58） | 1（21:32 `P*4b`） |
 *
 * ⭐ **手番の交互率では `P*4b` を見つけられない。** 交互は保たれたまま
 * 「持っていない歩」を打っているので、指標は満点に近いのに棋譜は間違っている
 * （追記 111 と同じ形）。
 *
 * ⚠ **最初の誤りで打ち切らない。** 打ち切ると「1 か所で崩れた」のか
 * 「何か所も独立に落ちている」のかが区別できない。手番は棋譜に記録された
 * `side` を正とし、非合法な手も**無理やり盤に反映して**続ける。
 * こうすると、後続がそのまま合法に流れるなら誤りは局所的だと分かる。
 *
 * ここで見ないのは打ち歩詰めと千日手だけ（`movegen` と同じ範囲）。
 */

import { applyMove, createInitialState, type BoardState, type PieceKind, type Side } from 'shared';
import { generateMoves } from './movegen.ts';

export interface ReplayMove {
  usi: string;
  side: Side;
  time: number;
}

export type ReplayProblemKind =
  /** 記録された手番が、盤の手番と食い違う＝直前に手を取りこぼしている */
  | 'missing-move'
  /** 駒の動き・打ちとして成立しない（持っていない駒の打ちもここ） */
  | 'impossible'
  /** 動き自体は成立するが、自分の玉が取られる */
  | 'left-in-check'
  /** 非合法なうえ、盤に反映することすらできない（以降の盤面はさらにずれる） */
  | 'unapplicable';

export interface ReplayProblem {
  kind: ReplayProblemKind;
  /** 何手目か（1 始まり） */
  index: number;
  usi: string;
  side: Side;
  time: number;
}

export interface ReplayResult {
  total: number;
  /** そのまま合法に指せた手の数 */
  legal: number;
  problems: ReplayProblem[];
  /** 最後まで再生した盤面（非合法な手も反映した後） */
  final: BoardState;
}

const other = (s: Side): Side => (s === 'sente' ? 'gote' : 'sente');
const parseSquare = (s: string) => ({ row: s.charCodeAt(1) - 97, col: 9 - Number(s[0]) });
const unpromoted = (k: PieceKind): PieceKind => (k.startsWith('+') ? (k.slice(1) as PieceKind) : k);

/**
 * 合法性を無視して盤に反映する。
 *
 * 誤りの後も再生を続けるためだけに使う。移動元に駒が無い・打つ先が埋まっている
 * ような、盤の形として辻褄が合わない手は反映できないので null を返す。
 */
function forceApply(state: BoardState, usi: string, side: Side): BoardState | null {
  const board = state.board.map((row) => [...row]);
  const hand = { sente: { ...state.hand.sente }, gote: { ...state.hand.gote } };

  if (usi[1] === '*') {
    const kind = usi[0] as PieceKind;
    const to = parseSquare(usi.slice(2));
    if (board[to.row][to.col]) return null;
    board[to.row][to.col] = { kind, side };
    // 持っていない駒を打った記録でも負数にはしない（そこは problems に出ている）
    hand[side][kind] = Math.max(0, (hand[side][kind] ?? 0) - 1);
  } else {
    const from = parseSquare(usi.slice(0, 2));
    const to = parseSquare(usi.slice(2, 4));
    const piece = board[from.row][from.col];
    if (!piece) return null;
    const captured = board[to.row][to.col];
    if (captured) {
      const kind = unpromoted(captured.kind);
      hand[side][kind] = (hand[side][kind] ?? 0) + 1;
    }
    board[from.row][from.col] = null;
    board[to.row][to.col] = usi.endsWith('+')
      ? { kind: `+${piece.kind}` as PieceKind, side }
      : { kind: piece.kind, side };
  }
  return { board, hand, sideToMove: other(side) };
}

/**
 * 棋譜を初期局面から通しで再生する。
 *
 * @param moves 書き出した手（`side` を手番の正として扱う）
 */
export function replayGame(moves: ReplayMove[]): ReplayResult {
  let state = createInitialState();
  const problems: ReplayProblem[] = [];
  let legal = 0;

  for (let i = 0; i < moves.length; i++) {
    const { usi, side, time } = moves[i];
    const at: BoardState = { ...state, sideToMove: side };

    if (side !== state.sideToMove) {
      problems.push({ kind: 'missing-move', index: i + 1, usi, side, time });
    }

    if (generateMoves(at, { legalOnly: true }).some((c) => c.usi === usi)) {
      state = applyMove(at, usi);
      legal++;
      continue;
    }

    // 玉が取られる手なら「動き自体は成立している」。原因の切り分けに要る。
    const kind: ReplayProblemKind = generateMoves(at, { legalOnly: false }).some((c) => c.usi === usi)
      ? 'left-in-check'
      : 'impossible';
    const forced = forceApply(at, usi, side);
    problems.push({ kind: forced ? kind : 'unapplicable', index: i + 1, usi, side, time });
    if (forced) state = forced;
  }

  return { total: moves.length, legal, problems, final: state };
}

const PROBLEM_LABEL: Record<ReplayProblemKind, string> = {
  'missing-move': 'この手の前に手を取りこぼしている',
  impossible: '駒の動きとして成立しない',
  'left-in-check': '王手放置',
  unapplicable: '盤に反映することすらできない',
};

export function describeProblem(p: ReplayProblem): string {
  const t = `${Math.floor(p.time / 60)}:${String(Math.floor(p.time % 60)).padStart(2, '0')}`;
  const mark = p.kind === 'missing-move' ? '⚠' : '🔴';
  return `${mark} ${p.index} 手目 ${p.usi}（${p.side === 'sente' ? '先手' : '後手'}・${t}）: ${PROBLEM_LABEL[p.kind]}`;
}
