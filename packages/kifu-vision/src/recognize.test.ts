import { describe, expect, it } from 'vitest';
import { createInitialState, type Square } from 'shared';
import { carryUnknowns, boardsEqual, boardDiff } from './recognize.ts';
import { inferMove } from './moves.ts';

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

function pos(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

function put(board: Square[][], usi: string, piece: Square): void {
  const p = pos(usi);
  board[p.row][p.col] = piece;
}

describe('carryUnknowns', () => {
  it('読めなかったマスに直前の駒を戻す', () => {
    const previous = emptyBoard();
    put(previous, '5e', { kind: 'S', side: 'sente' });

    // ポインタに覆われて銀が金と誤読された
    const read = emptyBoard();
    put(read, '5e', { kind: 'G', side: 'sente' });

    const carried = carryUnknowns(read, [pos('5e')], previous);
    expect(carried[pos('5e').row][pos('5e').col]).toEqual({ kind: 'S', side: 'sente' });
  });

  it('読めなかったマスが無ければ元の配置をそのまま返す', () => {
    const board = createInitialState().board;
    expect(carryUnknowns(board, [], emptyBoard())).toBe(board);
  });

  it('元の配置を書き換えない', () => {
    const previous = emptyBoard();
    put(previous, '5e', { kind: 'S', side: 'sente' });
    const read = emptyBoard();
    put(read, '5e', { kind: 'G', side: 'sente' });

    carryUnknowns(read, [pos('5e')], previous);
    expect(read[pos('5e').row][pos('5e').col]).toEqual({ kind: 'G', side: 'sente' });
  });

  it('ポインタが作った偽の駒を消して、本来の 1 手が読めるようになる', () => {
    // 7g の歩が 7f へ動いた。同時に 3e にポインタが重なって偽の駒が湧いた。
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    const read = emptyBoard();
    put(read, '7f', { kind: 'P', side: 'sente' });
    put(read, '3e', { kind: 'N', side: 'gote' }); // 偽物

    // そのままでは 3 マス動いたことになって読めない
    expect(inferMove(before, read).move).toBeNull();

    // 偽物のマスは一致度が低いので「読めなかったマス」に入る。引き継げば消える。
    const carried = carryUnknowns(read, [pos('3e')], before);
    const result = inferMove(before, carried);
    expect(result.move?.usi).toBe('7g7f');
  });

  it('駒が取られて消えた場合は引き継いでも辻褄が合わない（別経路に落ちる）', () => {
    // 8八の角が 2b の角を取った。2b が読めなかったとする。
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });
    const read = emptyBoard();
    put(read, '2b', { kind: 'P', side: 'sente' }); // 誤読

    // 引き継ぐと 2b が後手の角のままになり、先手の角だけが消えた形になる
    const carried = carryUnknowns(read, [pos('2b')], before);
    expect(inferMove(before, carried).failure).toBe('piece-vanished');

    // 素の読みなら（駒種は誤っていても）移動として形は取れる
    expect(inferMove(before, read).changedCells).toBe(2);
  });
});

describe('boardsEqual / boardDiff', () => {
  it('同じ配置を同じと判定する', () => {
    expect(boardsEqual(createInitialState().board, createInitialState().board)).toBe(true);
  });

  it('食い違うマスを挙げる', () => {
    const a = emptyBoard();
    const b = emptyBoard();
    put(b, '5e', { kind: 'G', side: 'sente' });
    const diff = boardDiff(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ row: 4, col: 4, before: null });
  });
});
