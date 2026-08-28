import { describe, it, expect } from 'vitest';
import { formatScore, formatScoreShort, formatTurnScore, moveDestination } from './usi';

/**
 * 情報行の評価値表示（prd/05-analysis.md §2.1 / decisions.md 2026-08-27）。
 *
 * 狭い画面向けの短い形は、幅を詰めるために形勢の言葉を落とす。
 * 🔒 **どちらが勝つかは落とさない**ことが要点なので、そこを固定する。
 */
describe('formatScoreShort', () => {
  describe('cp は数字だけにする（勝者は符号が担う）', () => {
    it.each([
      [0, '0'],
      [99, '+99'],
      [-99, '-99'],
      [100, '+100'],
      [-100, '-100'],
      [120, '+120'],
      [300, '+300'],
      [-300, '-300'],
      [800, '+800'],
      [-800, '-800'],
      [31111, '+31111'],
    ])('cp %i → %s', (value, expected) => {
      expect(formatScoreShort('cp', value, 0)).toBe(expected);
    });

    it('後手番のスコアは反転して先手視点にする（長い形と同じ規則）', () => {
      expect(formatScoreShort('cp', -120, 1)).toBe('+120');
      expect(formatScore('cp', -120, 1)).toBe('+120 (先手有利)');
    });
  });

  describe('mate は詰ます側の記号を残す', () => {
    // 🔒 ここが要点。mate は「先手 / 後手」の語だけが勝者を担っており、
    // 手数だけにすると頓死の前後で数字が変わるだけになって勝敗の入れ替わりが出ない。
    it('同じ mate 13 でも、手番が変われば詰ます側が入れ替わる', () => {
      expect(formatScoreShort('mate', 13, 0)).toBe('▲13手詰'); // 先手番の局面
      expect(formatScoreShort('mate', 13, 1)).toBe('△13手詰'); // 後手番の局面
      // 長い形でも同じことが起きている（短い形はその情報を捨てていない）
      expect(formatScore('mate', 13, 0)).toBe('先手勝ち(13手詰)');
      expect(formatScore('mate', 13, 1)).toBe('後手勝ち(13手詰)');
    });

    it('負の mate は相手が詰ます', () => {
      expect(formatScoreShort('mate', -13, 0)).toBe('△13手詰');
      expect(formatScoreShort('mate', -13, 1)).toBe('▲13手詰');
    });

    it('頓死（詰ます側が入れ替わる）が短い形でも読める', () => {
      // 13 手詰で勝っていたのが、次の手で 1 手詰で負けになる
      expect(formatScoreShort('mate', 13, 10)).toBe('▲13手詰');
      expect(formatScoreShort('mate', 1, 11)).toBe('△1手詰');
    });

    it.each([1, 15, 99])('mate %i 手詰も手数をそのまま出す', (moves) => {
      expect(formatScoreShort('mate', moves, 0)).toBe(`▲${moves}手詰`);
    });

    it('0 手詰と値が壊れている場合は勝者を名乗らない（長い形と同じ）', () => {
      expect(formatScoreShort('mate', 0, 0)).toBe('詰み');
      expect(formatScoreShort('mate', NaN, 0)).toBe('詰み');
      expect(formatScore('mate', 0, 0)).toBe('詰み');
      expect(formatScore('mate', NaN, 0)).toBe('詰み');
    });
  });
});

/**
 * 🔒 短い形を足しても**既定の形は変えない**（広い画面・候補手の行・他の呼び出し元がこれを使う）。
 */
describe('formatScore（既定の形は変えない）', () => {
  it.each([
    ['cp', 0, 0, '0 (互角)'],
    ['cp', 99, 0, '+99 (互角)'],
    ['cp', 100, 0, '+100 (先手有利)'],
    ['cp', -100, 0, '-100 (後手有利)'],
    ['cp', 300, 0, '+300 (先手優勢)'],
    ['cp', -800, 0, '-800 (後手勝勢)'],
    ['mate', 15, 0, '先手勝ち(15手詰)'],
    ['mate', -15, 0, '後手勝ち(15手詰)'],
  ])('%s %i (move %i) → %s', (type, value, move, expected) => {
    expect(formatScore(type as string, value as number, move as number)).toBe(expected);
  });
});

/**
 * 検討盤の評価値は**手番側から見た値**（prd/12 §2.3）。
 * 🔴 棋譜側の `formatScore` は手数の parity で先手視点へ直すので使えない
 * （検討局面は手数を持たず、手番トグルで手番だけ変えられる）。
 */
describe('formatTurnScore', () => {
  it.each([
    ['cp', 120, 'sente', '+120 (先手有利)'],
    // 同じ生の値でも、手番が後手なら「後手が +120 有利」＝先手視点では -120
    ['cp', 120, 'gote', '-120 (後手有利)'],
    ['cp', 0, 'sente', '0 (互角)'],
    ['mate', 15, 'sente', '先手勝ち(15手詰)'],
    ['mate', 15, 'gote', '後手勝ち(15手詰)'],
    ['mate', -15, 'gote', '先手勝ち(15手詰)'],
  ])('%s %i (%s 番) → %s', (type, value, side, expected) => {
    expect(
      formatTurnScore(type as string, value as number, side as 'sente' | 'gote'),
    ).toBe(expected);
  });

  it('手数に依存しない（同じ値なら手番だけで決まる）', () => {
    // formatScore は moveNumber の偶奇で結果が変わるが、こちらは変わりようがない
    expect(formatTurnScore('cp', 300, 'sente')).toBe(formatTurnScore('cp', 300, 'sente'));
    expect(formatScore('cp', 300, 0)).not.toBe(formatScore('cp', 300, 1));
  });
});

describe('moveDestination', () => {
  it.each([
    ['7g7f', [5, 2]],
    ['7g7f+', [5, 2]],
    ['B*5c', [2, 4]],
    ['1a1a', [0, 8]],
  ])('%s → %j', (move, expected) => {
    expect(moveDestination(move as string)).toEqual(expected);
  });

  it('読めない手は null', () => {
    expect(moveDestination('')).toBeNull();
    expect(moveDestination('resign')).toBeNull();
    expect(moveDestination('K*5e')).toBeNull();
  });
});
