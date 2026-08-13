import { describe, expect, it } from 'vitest';
import { createInitialState, type Square } from 'shared';
import { carryUnknowns, boardsEqual, boardDiff, recognizeBoard } from './recognize.ts';
import { inferMove } from './moves.ts';
import { cellImage, type Template } from './template.ts';
import { isUnknown } from './uncertain.ts';
import type { GrayImage } from './frame.ts';

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

  it('読めなかったマスが無ければ元の配置と同じものを返す', () => {
    const board = createInitialState().board;
    expect(carryUnknowns(board, [], emptyBoard())).toEqual(board);
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

/** 各マスの標準偏差を指定して合成した盤画像（`occupancy.test.ts` と同じ作り） */
function boardWithSd(sds: number[][]): GrayImage {
  const cell = 10;
  const size = cell * 9;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sd = sds[Math.floor(y / cell)][Math.floor(x / cell)];
      data[y * size + x] = y % cell < cell / 2 ? 128 - sd : 128 + sd;
    }
  }
  return { width: size, height: size, data };
}

describe('recognizeBoard の駒の有無（3 値）', () => {
  const sds = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 5));
  sds[3][4] = 20; // 覆われて平らになった帯（12 < sd <= 30）
  sds[8][0] = 60; // 駒がはっきり見えている
  const img = boardWithSd(sds);
  const templates: Template[] = [{ kind: 'P', side: 'sente', samples: 1, img: cellImage(img, 8, 0) }];
  const r = recognizeBoard(img, templates);

  it('帯の中のマスは未確定になる（「空」と断定しない）', () => {
    expect(isUnknown(r.board[3][4])).toBe(true);
  });

  it('未確定にした理由が「覆われていた」として残る', () => {
    const covered = r.lowConfidence.filter((c) => c.covered);
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ row: 3, col: 4, guess: null });
  });

  it('覆われたマスに当てずっぽうの駒を置かない（fillGuesses で偽の駒にしない）', () => {
    expect(r.guesses[3][4]).toBeNull();
  });

  it('通常の空マスは空のまま', () => {
    expect(r.board[0][0]).toBeNull();
  });

  it('はっきり見えている駒はそのまま読める', () => {
    expect(r.board[8][0]).toEqual({ kind: 'P', side: 'sente' });
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
