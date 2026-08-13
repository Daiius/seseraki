import { describe, expect, it } from 'vitest';
import type { Square } from 'shared';
import type { GrayImage } from './frame.ts';
import { cellImage, type Template } from './template.ts';
import { findUndroppableDrop, readAsDroppable } from './droppable.ts';

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

describe('findUndroppableDrop', () => {
  it('空マスに打てない駒が 1 つ現れた形を拾う', () => {
    const before = emptyBoard();
    const after = emptyBoard();
    put(after, '8f', { kind: '+S', side: 'gote' });

    expect(findUndroppableDrop(before, after)).toEqual({ ...pos('8f'), side: 'gote', kind: '+S' });
  });

  it('打てる駒なら困っていないので拾わない', () => {
    const before = emptyBoard();
    const after = emptyBoard();
    put(after, '8f', { kind: 'G', side: 'gote' });

    expect(findUndroppableDrop(before, after)).toBeNull();
  });

  it('2 マス変わっていれば盤上の移動なので拾わない（成りは正常）', () => {
    const before = emptyBoard();
    put(before, '8g', { kind: 'S', side: 'gote' });
    const after = emptyBoard();
    put(after, '8f', { kind: '+S', side: 'gote' });

    expect(findUndroppableDrop(before, after)).toBeNull();
  });

  it('駒が消えただけの形は拾わない', () => {
    const before = emptyBoard();
    put(before, '8f', { kind: '+S', side: 'gote' });
    const after = emptyBoard();

    expect(findUndroppableDrop(before, after)).toBeNull();
  });

  it('何も変わっていなければ null', () => {
    expect(findUndroppableDrop(emptyBoard(), emptyBoard())).toBeNull();
  });
});

/** マスごとに違う模様を描いた合成盤。1 マス 10x10。 */
function boardWithPatterns(pattern: (row: number, col: number, x: number, y: number) => number): GrayImage {
  const cell = 10;
  const size = cell * 9;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[y * size + x] = pattern(Math.floor(y / cell), Math.floor(x / cell), x % cell, y % cell);
    }
  }
  return { width: size, height: size, data };
}

describe('readAsDroppable', () => {
  // 8f に「横縞」を描く。金のテンプレートを同じ横縞、成銀を似た縞、歩を縦縞にする。
  const img = boardWithPatterns((row, col, x, y) =>
    row === 5 && col === 1 ? (y % 2 === 0 ? 40 : 210) : 128,
  );
  const stripes = boardWithPatterns((_r, _c, _x, y) => (y % 2 === 0 ? 40 : 210));
  const vertical = boardWithPatterns((_r, _c, x) => (x % 2 === 0 ? 40 : 210));

  const templates: Template[] = [
    { kind: '+S', side: 'gote', samples: 1, img: cellImage(stripes, 0, 0) }, // 打てない・よく合う
    { kind: 'G', side: 'gote', samples: 1, img: cellImage(stripes, 0, 0) }, // 打てる・よく合う
    { kind: 'P', side: 'gote', samples: 1, img: cellImage(vertical, 0, 0) }, // 打てる・合わない
    { kind: 'G', side: 'sente', samples: 1, img: cellImage(stripes, 0, 0) }, // 向きが違う
  ];

  it('打てない駒を外して読み直す', () => {
    const read = readAsDroppable(img, 5, 1, 'gote', templates);
    expect(read?.kind).toBe('G');
  });

  it('向きが合わないテンプレートは使わない', () => {
    // 先手側のテンプレートしか無ければ、後手として読むことはできない
    const senteOnly = templates.filter((t) => t.side === 'sente');
    expect(readAsDroppable(img, 5, 1, 'gote', senteOnly)).toBeNull();
  });

  it('2 位と開いていなければ決めない', () => {
    // 打てる駒がどちらも同じ絵なら差が付かない
    const tied: Template[] = [
      { kind: 'G', side: 'gote', samples: 1, img: cellImage(stripes, 0, 0) },
      { kind: 'S', side: 'gote', samples: 1, img: cellImage(stripes, 0, 0) },
    ];
    expect(readAsDroppable(img, 5, 1, 'gote', tied)).toBeNull();
  });

  it('一致度が低ければ決めない', () => {
    const onlyVertical: Template[] = [{ kind: 'P', side: 'gote', samples: 1, img: cellImage(vertical, 0, 0) }];
    expect(readAsDroppable(img, 5, 1, 'gote', onlyVertical)).toBeNull();
  });
});
