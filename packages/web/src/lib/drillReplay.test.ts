import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState } from 'shared';
import {
  answerMovesOf,
  cursorState,
  initialCursor,
  linePositions,
  missLine,
  moveCursor,
  revealLines,
  selectLine,
  startPositionOf,
} from './drillReplay';

const base = createInitialState();

describe('answerMovesOf（正解手順）', () => {
  it('読み筋が正解手から始まればそのまま', () => {
    expect(answerMovesOf('7g7f', ['7g7f', '3c3d'])).toEqual(['7g7f', '3c3d']);
  });
  it('読み筋が無い・正解手から始まらなければ正解手 1 手', () => {
    expect(answerMovesOf('7g7f', null)).toEqual(['7g7f']);
    expect(answerMovesOf('7g7f', [])).toEqual(['7g7f']);
    expect(answerMovesOf('7g7f', ['2g2f', '3c3d'])).toEqual(['7g7f']);
  });
});

describe('startPositionOf（盤が飛ばない位置）', () => {
  it('盤の手順が先頭と一致すればその手数', () => {
    expect(startPositionOf(['7g7f', '3c3d', '2g2f'], ['7g7f'])).toBe(1);
    expect(startPositionOf(['7g7f', '3c3d'], [])).toBe(0);
    expect(startPositionOf(['7g7f', '3c3d'], ['7g7f', '3c3d'])).toBe(2);
  });
  it('一致しない・手順より長ければ 0', () => {
    expect(startPositionOf(['7g7f', '3c3d'], ['2g2f'])).toBe(0);
    expect(startPositionOf(['7g7f'], ['7g7f', '3c3d'])).toBe(0);
  });
});

describe('revealLines（解答後の手順）', () => {
  it('次の一手で正解: 正解手順だけ・答えた局面から始まる', () => {
    const lines = revealLines({
      kind: 'best',
      base,
      played: ['7g7f'],
      answerMove: '7g7f',
      answerPv: ['7g7f', '3c3d', '2g2f'],
      refutation: undefined,
    });
    expect(lines.map((l) => l.label)).toEqual(['正解手順']);
    expect(lines[0].start).toBe(1);
    expect(initialCursor(lines, ['7g7f'])).toEqual({ line: 0, position: 1 });
  });

  it('次の一手で不正解: 咎め筋は答えた手から始まり、最初はそれを選ぶ（盤は答えた局面のまま）', () => {
    const lines = revealLines({
      kind: 'best',
      base,
      played: ['2g2f'],
      answerMove: '7g7f',
      answerPv: ['7g7f', '3c3d'],
      refutation: ['8c8d', '2f2e'],
    });
    expect(lines.map((l) => l.label)).toEqual(['正解手順', '咎め筋']);
    expect(lines[1].moves).toEqual(['2g2f', '8c8d', '2f2e']);
    expect(lines[0].start).toBe(0);
    expect(lines[1].start).toBe(1);
    expect(initialCursor(lines, ['2g2f'])).toEqual({ line: 1, position: 1 });
  });

  it('詰将棋は「詰み手順」。正解手順と違う手順で答えたら最初は再生に入らない', () => {
    const lines = revealLines({
      kind: 'mate',
      base,
      played: ['2g2f', '8c8d', '2f2e'],
      answerMove: '7g7f',
      answerPv: ['7g7f', '3c3d', '2g2f'],
      refutation: [],
    });
    expect(lines.map((l) => l.label)).toEqual(['詰み手順']);
    expect(initialCursor(lines, ['2g2f', '8c8d', '2f2e'])).toBeNull();
  });

  it('答えを見た（盤に手が無い）: 正解手順を始める局面から', () => {
    const lines = revealLines({
      kind: 'mate',
      base,
      played: [],
      answerMove: '7g7f',
      answerPv: ['7g7f', '3c3d'],
      refutation: undefined,
    });
    expect(initialCursor(lines, [])).toEqual({ line: 0, position: 0 });
  });
});

describe('missLine（詰将棋の途中の咎め筋）', () => {
  it('解いている局面から、間違えた手 + 受けの手。始める位置は 0', () => {
    const line = missLine(base, '2g2f', ['8c8d']);
    expect(line).toEqual({ label: '咎め筋', base, moves: ['2g2f', '8c8d'], start: 0 });
    expect(initialCursor([line!], [])).toEqual({ line: 0, position: 0 });
  });
  it('受けの手が無ければ出さない', () => {
    expect(missLine(base, '2g2f', [])).toBeNull();
  });
});

describe('カーソルの操作と局面', () => {
  const lines = revealLines({
    kind: 'best',
    base,
    played: ['2g2f'],
    answerMove: '7g7f',
    answerPv: ['7g7f', '3c3d'],
    refutation: ['8c8d'],
  });

  it('端で止める', () => {
    expect(moveCursor(lines, { line: 0, position: 1 }, 5)).toEqual({ line: 0, position: 2 });
    expect(moveCursor(lines, { line: 0, position: 1 }, -1)).toEqual({ line: 0, position: 0 });
  });

  it('違う手順を選んだらその手順の始める位置へ。同じ手順なら位置はそのまま', () => {
    expect(selectLine(lines, { line: 1, position: 2 }, 0)).toEqual({ line: 0, position: 0 });
    expect(selectLine(lines, { line: 1, position: 2 }, 1)).toEqual({ line: 1, position: 2 });
  });

  it('局面と直前の手', () => {
    const at = cursorState(lines, { line: 1, position: 2 });
    expect(at?.state).toEqual(applyMove(applyMove(base, '2g2f'), '8c8d'));
    expect(at?.lastMove).toBe('8c8d');
    expect(cursorState(lines, { line: 0, position: 0 })).toEqual({ state: base, lastMove: null });
  });

  it('1 手ずつの表記', () => {
    const { texts, states } = linePositions(lines[0]);
    expect(texts).toEqual(['７六歩(77)', '３四歩(33)']);
    expect(states).toHaveLength(3);
  });
});
