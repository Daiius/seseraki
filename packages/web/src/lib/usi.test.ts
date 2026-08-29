import { describe, it, expect } from 'vitest';
import { parseSfen, type MateLine } from 'shared';
import {
  formatScore,
  formatScoreShort,
  formatTurnScore,
  mateLineOf,
  moveDestination,
} from './usi';

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
      expect(formatScoreShort('mate', 13, 0)).toBe('▲詰(13)'); // 先手番の局面
      expect(formatScoreShort('mate', 13, 1)).toBe('△詰(13)'); // 後手番の局面
      // 長い形でも同じことが起きている（短い形はその情報を捨てていない）
      expect(formatScore('mate', 13, 0)).toBe('先手勝ち(13手で詰み)');
      expect(formatScore('mate', 13, 1)).toBe('後手勝ち(13手で詰み)');
    });

    it('負の mate は相手が詰ます', () => {
      expect(formatScoreShort('mate', -13, 0)).toBe('△詰(13)');
      expect(formatScoreShort('mate', -13, 1)).toBe('▲詰(13)');
    });

    it('頓死（詰ます側が入れ替わる）が短い形でも読める', () => {
      // 13 手で詰みだったのが、次の手で 1 手詰で負けになる
      expect(formatScoreShort('mate', 13, 10)).toBe('▲詰(13)');
      expect(formatScoreShort('mate', 1, 11)).toBe('△詰(1)');
    });

    it.each([1, 15, 99])('mate %i も手数をそのまま出す', (moves) => {
      expect(formatScoreShort('mate', moves, 0)).toBe(`▲詰(${moves})`);
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
    // 🔴 `line` が無ければ「N手詰」を名乗らない（`score mate N` は plies・応手込み）
    ['mate', 15, 0, '先手勝ち(15手で詰み)'],
    ['mate', -15, 0, '後手勝ち(15手で詰み)'],
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
    ['mate', 15, 'sente', '先手勝ち(15手で詰み)'],
    ['mate', 15, 'gote', '後手勝ち(15手で詰み)'],
    ['mate', -15, 'gote', '先手勝ち(15手で詰み)'],
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

/**
 * 🔴 **`score mate N` は「詰みまでの手数（plies）」**で、受方の応手・逆王手・合駒が全部入る。
 * 詰将棋の「N手詰」（初手から王手の連続）とは意味が違うので、**読み筋を辿って形が判ったときだけ
 * 「N手詰」を名乗る**（`classifyMateLine`。設計 Phase A）。
 */
describe('mate の表記は読み筋の形で決まる', () => {
  const line = (over: Partial<MateLine>): MateLine => ({
    kind: 'unknown',
    plies: 9,
    checks: 0,
    interposes: 0,
    ...over,
  });

  it('攻方の手が全て王手（checkmate）のときだけ「N手詰」を名乗る', () => {
    expect(formatScore('mate', 9, 0, line({ kind: 'checkmate' }))).toBe('先手勝ち(9手詰)');
    expect(formatScoreShort('mate', 9, 0, line({ kind: 'checkmate' }))).toBe('▲9手詰');
  });

  it('初手だけ静かな手（hisshi）は必至として出す', () => {
    expect(formatScore('mate', 9, 0, line({ kind: 'hisshi' }))).toBe('先手勝ち(必至・9手で詰み)');
    expect(formatScoreShort('mate', 9, 0, line({ kind: 'hisshi' }))).toBe('▲必至(9)');
  });

  it('途中に静かな手が混ざる（forced）は既定と同じ「N手で詰み」', () => {
    expect(formatScore('mate', 9, 0, line({ kind: 'forced' }))).toBe('先手勝ち(9手で詰み)');
    expect(formatScoreShort('mate', 9, 0, line({ kind: 'forced' }))).toBe('▲詰(9)');
  });

  it('unknown は line を省略したときと同じ', () => {
    expect(formatScore('mate', 9, 0, line({}))).toBe(formatScore('mate', 9, 0));
    expect(formatScoreShort('mate', 9, 0, line({}))).toBe(formatScoreShort('mate', 9, 0));
  });

  it('手番側視点（検討盤）でも同じ語彙になる', () => {
    expect(formatTurnScore('mate', 9, 'gote', line({ kind: 'checkmate' }))).toBe('後手勝ち(9手詰)');
    expect(formatTurnScore('mate', 9, 'gote', line({ kind: 'hisshi' }))).toBe(
      '後手勝ち(必至・9手で詰み)',
    );
  });

  it('合駒は「N手詰」を名乗るときだけ添える（設計 §1.4）', () => {
    // 「N手で詰み」は詰将棋の手数を騙っていないので、添えても情報が増えない
    expect(formatScore('mate', 5, 0, line({ kind: 'checkmate', plies: 5, interposes: 1 }))).toBe(
      '先手勝ち(5手詰・合駒1)',
    );
    expect(formatScore('mate', 5, 0, line({ kind: 'forced', plies: 5, interposes: 1 }))).toBe(
      '先手勝ち(5手で詰み)',
    );
    // 短い形は幅が要るので添えない
    expect(formatScoreShort('mate', 5, 0, line({ kind: 'checkmate', plies: 5, interposes: 1 }))).toBe(
      '▲5手詰',
    );
  });

  it('終局マーカー（gameover）は「詰み」に倒す', () => {
    // 🔴 dev DB の kifu 1 の 106 手目（`mate -1` / pv `["resign"]`）が `△詰(1)` と出ていた。
    //    もう詰んでいる局面なので `mate 0` と同じ扱いにする
    const over = line({ kind: 'gameover', plies: 1 });
    expect(formatScore('mate', -1, 0, over)).toBe('詰み');
    expect(formatScoreShort('mate', -1, 0, over)).toBe('詰み');
    expect(formatTurnScore('mate', -1, 'gote', over)).toBe('詰み');
    // ⚠ 分類が付かなければ従来どおり「N手で詰み」（本当に pv が壊れている場合と混ぜない）
    expect(formatScoreShort('mate', -1, 0)).toBe('△詰(1)');
  });

  it('0 手詰は line があっても「詰み」', () => {
    expect(formatScore('mate', 0, 0, line({ kind: 'checkmate' }))).toBe('詰み');
    expect(formatScoreShort('mate', 0, 0, line({ kind: 'checkmate' }))).toBe('詰み');
  });
});

/**
 * `mateLineOf` は表示側の入口。**mate 以外・盤面や pv が無いときは分類しない**。
 */
describe('mateLineOf', () => {
  // kifu3 #52 rank3（dev DB の実データ）: 全手王手 + 合駒 1 枚
  const SFEN = 'ln5nl/9/p1pp1+B1p1/3s1Pp1p/1p2k4/2P2bPPP/PP1P2N2/3G5/LNK2G2L b R2GSPr2s2p 1';
  const PV = ['R*5b', '6d5c', '5b5c+', 'P*5d', '5c5d'];
  const state = parseSfen(SFEN)!;

  it('mate なら読み筋を分類する', () => {
    expect(mateLineOf(state, 'mate', 5, PV)).toEqual({
      kind: 'checkmate',
      plies: 5,
      checks: 3,
      interposes: 1,
    });
  });

  it('pv が resign なら gameover（表示は「詰み」）', () => {
    const l = mateLineOf(state, 'mate', -1, ['resign']);
    expect(l?.kind).toBe('gameover');
    expect(formatScoreShort('mate', -1, 0, l)).toBe('詰み');
  });

  it('cp・盤面なし・pv なしは undefined', () => {
    expect(mateLineOf(state, 'cp', 120, PV)).toBeUndefined();
    expect(mateLineOf(null, 'mate', 5, PV)).toBeUndefined();
    expect(mateLineOf(state, 'mate', 5, [])).toBeUndefined();
    expect(mateLineOf(state, 'mate', 5, undefined)).toBeUndefined();
  });

  it('分類した結果がそのまま表示に効く', () => {
    const l = mateLineOf(state, 'mate', 5, PV);
    expect(formatScore('mate', 5, 0, l)).toBe('先手勝ち(5手詰・合駒1)');
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
