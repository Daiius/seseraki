import { describe, expect, it } from 'vitest';
import { buildPositions, createInitialState, type Square } from 'shared';
import { inferMove, verifyMove, toUsiSquare, initialBoard } from './moves.ts';

/** 空の盤面 */
function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

/** USI 座標 ("7g") → [row, col] */
function at(usi: string): [number, number] {
  return [usi.charCodeAt(1) - 97, 9 - Number(usi[0])];
}

function put(board: Square[][], usi: string, piece: Square): void {
  const [row, col] = at(usi);
  board[row][col] = piece;
}

describe('toUsiSquare', () => {
  it('col 0 は 9 筋、row 0 は一段目', () => {
    expect(toUsiSquare(0, 0)).toBe('9a');
    expect(toUsiSquare(8, 8)).toBe('1i');
    expect(toUsiSquare(6, 2)).toBe('7g');
  });
});

describe('inferMove', () => {
  it('駒を取らない移動を読み取る', () => {
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    const after = emptyBoard();
    put(after, '7f', { kind: 'P', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move?.usi).toBe('7g7f');
    expect(result.move?.type).toBe('move');
    expect(result.move?.side).toBe('sente');
    expect(result.move?.promoted).toBe(false);
    expect(result.changedCells).toBe(2);
  });

  it('駒を取る移動を読み取り、取った駒も分かる', () => {
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });
    const after = emptyBoard();
    put(after, '2b', { kind: 'B', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move?.usi).toBe('8h2b');
    expect(result.move?.captured).toEqual({ kind: 'B', side: 'gote' });
  });

  it('成る手を読み取る', () => {
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });
    const after = emptyBoard();
    put(after, '2b', { kind: '+B', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move?.usi).toBe('8h2b+');
    expect(result.move?.promoted).toBe(true);
  });

  it('駒打ちを読み取る', () => {
    const before = emptyBoard();
    const after = emptyBoard();
    put(after, '4e', { kind: 'B', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move?.usi).toBe('B*4e');
    expect(result.move?.type).toBe('drop');
    expect(result.changedCells).toBe(1);
  });

  it('変化がなければ no-change を返す', () => {
    const board = initialBoard();
    const result = inferMove(board, board);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('no-change');
  });

  it('2 手ぶんが重なっていたら too-many-changes を返す', () => {
    // 1 手目 7g7f、2 手目 3c3d が 1 つの差分に合成された状態
    const positions = buildPositions(['7g7f', '3c3d']);
    const result = inferMove(positions[0].board, positions[2].board);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('too-many-changes');
    expect(result.changedCells).toBe(4);
  });

  it('成駒が湧いて見えたら undroppable として弾く（打てない駒だから）', () => {
    const before = emptyBoard();
    const after = emptyBoard();
    put(after, '5e', { kind: '+P', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('undroppable');
  });

  it('移動元と移動先で駒種が繋がらなければ promotion-mismatch を返す', () => {
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    const after = emptyBoard();
    put(after, '7f', { kind: 'G', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('promotion-mismatch');
  });

  it('敵陣に掛かっていない成りは promotion-mismatch（読みの誤りが 2 つ重なった形）', () => {
    // 実測: 4i の金を「銀」、3h の金を「全」と読むと、自陣での成りとして
    // 差分の辻褄が合ってしまう。敵陣を見れば弾ける。
    const before = emptyBoard();
    put(before, '4i', { kind: 'S', side: 'sente' });
    const after = emptyBoard();
    put(after, '3h', { kind: '+S', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('promotion-mismatch');
  });

  it('敵陣に掛かる成りはそのまま通る', () => {
    const before = emptyBoard();
    put(before, '4d', { kind: 'S', side: 'sente' });
    const after = emptyBoard();
    put(after, '3c', { kind: '+S', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move?.usi).toBe('4d3c+');
  });

  it('駒が消えるだけの差分は piece-vanished（スライド途中の絵）', () => {
    // 移動元が空いてから移動先が埋まるまでの間、駒はマスの間にあってどこにも属さない。
    // 「駒が盤から消える手」は存在しないので、この形は必ずアニメーション途中と分かる。
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    const after = emptyBoard();

    const result = inferMove(before, after);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('piece-vanished');
    expect(result.changedCells).toBe(1);
  });

  it('打ちと piece-vanished を取り違えない', () => {
    // 「1 マスだけ変わる」点は同じだが、埋まるのが打ち、空くのがスライド途中。
    const empty = emptyBoard();
    const withPiece = emptyBoard();
    put(withPiece, '5e', { kind: 'G', side: 'sente' });

    expect(inferMove(empty, withPiece).move?.type).toBe('drop');
    expect(inferMove(withPiece, empty).failure).toBe('piece-vanished');
  });

  it('自分の駒を取る形は弾く', () => {
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'P', side: 'sente' });
    const after = emptyBoard();
    put(after, '2b', { kind: 'B', side: 'sente' });

    const result = inferMove(before, after);
    expect(result.move).toBeNull();
    expect(result.failure).toBe('illegal-shape');
  });
});

describe('手列との往復', () => {
  // 移動・取る・成る・打ちを一通り含む手順
  const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e'];

  it('局面列の隣どうしから元の手をすべて復元できる', () => {
    const positions = buildPositions(moves);
    const restored: string[] = [];
    for (let i = 0; i < moves.length; i++) {
      const result = inferMove(positions[i].board, positions[i + 1].board);
      expect(result.failure).toBeUndefined();
      expect(result.move).not.toBeNull();
      restored.push(result.move!.usi);
    }
    expect(restored).toEqual(moves);
  });

  it('復元した手の指し手側が先後交互になっている', () => {
    const positions = buildPositions(moves);
    const sides = moves.map((_, i) => inferMove(positions[i].board, positions[i + 1].board).move!.side);
    expect(sides).toEqual(['sente', 'gote', 'sente', 'gote', 'sente']);
  });

  it('verifyMove が正しい手を通し、違う手を落とす', () => {
    const positions = buildPositions(moves);
    expect(verifyMove(positions[0].board, '7g7f', 'sente', positions[1].board)).toBe(true);
    expect(verifyMove(positions[0].board, '2g2f', 'sente', positions[1].board)).toBe(false);
  });

  it('verifyMove は applyMove が読み飛ばす不正な手も落とす', () => {
    // 駒のないマスからの移動。applyMove は例外を投げず、盤面を変えないまま手番だけ進める。
    // だから「呼べたこと」を成功と見なしてはいけない。実際の配置変化と突き合わせて初めて落とせる。
    const positions = buildPositions(['7g7f']);
    expect(verifyMove(positions[0].board, '5e5d', 'sente', positions[1].board)).toBe(false);
  });

  it('盤面が変わらない手では検証が働かない（no-change を先に弾く必要がある）', () => {
    // applyMove が読み飛ばす手は盤面を変えないので、変化前後が同じなら一致してしまう。
    // inferMove が no-change を返す差分を verifyMove に渡してはいけない、という戒め。
    const start = createInitialState();
    expect(verifyMove(start.board, '5e5d', 'sente', start.board)).toBe(true);
  });
});
