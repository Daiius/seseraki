import { describe, it, expect } from 'vitest';
import { applyMove, parseSfen, type MateLine } from 'shared';
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
      expect(formatScoreShort('mate', 13, 0)).toBe('▲13手で詰'); // 先手番の局面
      expect(formatScoreShort('mate', 13, 1)).toBe('△13手で詰'); // 後手番の局面
      // 長い形でも同じことが起きている（短い形はその情報を捨てていない）
      expect(formatScore('mate', 13, 0)).toBe('先手勝ち(13手で詰み)');
      expect(formatScore('mate', 13, 1)).toBe('後手勝ち(13手で詰み)');
    });

    it('負の mate は相手が詰ます', () => {
      expect(formatScoreShort('mate', -13, 0)).toBe('△13手で詰');
      expect(formatScoreShort('mate', -13, 1)).toBe('▲13手で詰');
    });

    it('頓死（詰ます側が入れ替わる）が短い形でも読める', () => {
      // 13 手で詰みだったのが、次の手で 1 手詰で負けになる
      expect(formatScoreShort('mate', 13, 10)).toBe('▲13手で詰');
      expect(formatScoreShort('mate', 1, 11)).toBe('△1手で詰');
    });

    it.each([1, 15, 99])('mate %i も手数をそのまま出す', (moves) => {
      expect(formatScoreShort('mate', moves, 0)).toBe(`▲${moves}手で詰`);
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
    matedSideInCheck: false,
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

  it('途中に静かな手が混ざる（forced）も、王手中でなければ「必至」', () => {
    // 🔴 「受けが無い」ことは mate スコアが保証しており、**読み筋の形は条件ではない**。
    //    `hisshi` と `forced` を表示で分ける理由が無い
    expect(formatScore('mate', 9, 0, line({ kind: 'forced' }))).toBe('先手勝ち(必至・9手で詰み)');
    expect(formatScoreShort('mate', 9, 0, line({ kind: 'forced' }))).toBe('▲必至(9)');
    expect(formatScoreShort('mate', 9, 0, line({ kind: 'forced' }))).toBe(
      formatScoreShort('mate', 9, 0, line({ kind: 'hisshi' })),
    );
  });

  it('詰まされる側が王手中なら「必至」を名乗らない（形を問わず）', () => {
    // 🔴 必至は「受けられない詰めろが掛かっている」状態を指す語で、**詰まされる側に今まさに王手が
    //    掛かっている局面には使わない**（王手中は詰めろの段階ではなく詰まし合いの最中）。
    //    ⚠ 見るのは**詰まされる側**であって手番側ではない。勝つ側が王手されていることは必至かどうかと
    //    関係が無い（レビュー `OCL-2C1FDEAD`）。
    //    ⚠ 分類だけでは弾けない——王手された側が玉を逃げる手は王手ではないので、形の上では
    //    `hisshi` にも `forced` にもなりうる
    for (const kind of ['hisshi', 'forced'] as const) {
      const checked = line({ kind, matedSideInCheck: true });
      expect(formatScore('mate', 9, 0, checked)).toBe('先手勝ち(9手で詰み)');
      expect(formatScoreShort('mate', 9, 0, checked)).toBe('▲9手で詰');
      expect(formatTurnScore('mate', 9, 'gote', checked)).toBe('後手勝ち(9手で詰み)');
    }
  });

  it('詰まされる側が王手中でも checkmate は「N手詰」のまま', () => {
    // 🔒 王手を解除しながら王手を掛ける手から詰ますことはある。正真正銘の即詰みなので
    //    除外の対象にしない（除外するのは必至を名乗る側だけ）
    const checked = line({ kind: 'checkmate', matedSideInCheck: true });
    expect(formatScore('mate', 9, 0, checked)).toBe('先手勝ち(9手詰)');
    expect(formatScoreShort('mate', 9, 0, checked)).toBe('▲9手詰');
  });

  it('unknown は line を省略したときと同じで、「必至」を名乗らない', () => {
    // 🔒 形を追えなかった以上、盤面の状態そのものを信用しきれない（pv が読めない / 短い）
    expect(formatScore('mate', 9, 0, line({}))).toBe(formatScore('mate', 9, 0));
    expect(formatScoreShort('mate', 9, 0, line({}))).toBe(formatScoreShort('mate', 9, 0));
    expect(formatScore('mate', 9, 0, line({}))).toBe('先手勝ち(9手で詰み)');
    // 🔒 `▲詰(9)` は「詰んでいる」と読めるので綴りを変える（広い形と同じ読み下し）
    expect(formatScoreShort('mate', 9, 0, line({}))).toBe('▲9手で詰');
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
      '先手勝ち(必至・5手で詰み)',
    );
    // 短い形は幅が要るので添えない
    expect(formatScoreShort('mate', 5, 0, line({ kind: 'checkmate', plies: 5, interposes: 1 }))).toBe(
      '▲5手詰',
    );
  });

  it('投了（gameover）は手数を出さず「詰み」。ただし勝者は残す', () => {
    // 🔴 dev DB の kifu 1 の 106 手目（`mate -1` / pv `["resign"]`）が `△詰(1)` と出ていた。
    //    手数に意味が無い局面なので「詰み」にするが、**勝者は mate の符号から判る**ので落とさない
    const over = line({ kind: 'gameover', plies: 1 });
    expect(formatScore('mate', -1, 0, over)).toBe('後手勝ち(詰み)');
    expect(formatScoreShort('mate', -1, 0, over)).toBe('△詰み');
    expect(formatTurnScore('mate', 1, 'gote', over)).toBe('後手勝ち(詰み)');
    // 先手が詰ます側なら ▲
    expect(formatScoreShort('mate', -1, 1, over)).toBe('▲詰み');
    // ⚠ 分類が付かなければ従来どおり「N手で詰み」（本当に pv が壊れている場合と混ぜない）
    expect(formatScoreShort('mate', -1, 0)).toBe('△1手で詰');
  });

  it('勝者不明の「詰み」は mate 0 の側だけ', () => {
    expect(formatScore('mate', 0, 0, line({ kind: 'gameover', plies: 0 }))).toBe('詰み');
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
      matedSideInCheck: false,
    });
  });

  it('王手されている手番側の resign は gameover（表示は勝者付きの「詰み」）', () => {
    // `R*5b` は王手。指した後は手番側（後手）が王手されている
    const checked = applyMove(state, 'R*5b');
    const l = mateLineOf(checked, 'mate', -1, ['resign']);
    expect(l?.kind).toBe('gameover');
    expect(formatScoreShort('mate', -1, 0, l)).toBe('△詰み');
  });

  it('王手されていない resign と win は gameover にしない', () => {
    // 🔒 `resign` は「engine が指す手を持たない」表明でしかなく、盤面の状態を証明しない
    expect(mateLineOf(state, 'mate', -1, ['resign'])?.kind).toBe('unknown');
    expect(mateLineOf(applyMove(state, 'R*5b'), 'mate', -1, ['win'])?.kind).toBe('unknown');
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

  it('手番側が王手されていても、詰まされる側が王手中でなければ必至（kifu1 #103・回帰）', () => {
    /*
      🔴 dev DB の実データ。**「手番側は王手されているが、詰まされる側は王手されていない」**ケース。
      - 後手番 / 後手玉に王手あり / 先手玉に王手なし / `mate 5`（後手が 5 手で詰ます）
      - 詰まされるのは**先手**で、先手玉に王手は掛かっていない ＝ **必至**

      手番側を見ていた実装（#114）は、勝つ側（後手）の王手を理由に必至を取り下げ、
      `△5手で詰` と表示していた。必至かどうかは**詰まされる側**の王手で決まる。
    */
    const state103 = parseSfen(
      '1l1+P1k1nl/s2+N1sg2/nL2Np1p1/KPPpr3p/2+b3PP1/8P/3s1P3/1+p4SR1/5G2L w 4Pb2g2p 1',
    )!;
    const l = mateLineOf(state103, 'mate', 5, ['4a3a', '5c4a+', '3a2b', '4a4b', '7e8e']);
    expect(l).toMatchObject({ kind: 'forced', matedSideInCheck: false });
    // 103 手目（後手番）なので先手視点では -5 ＝ 後手が詰ます
    expect(formatScoreShort('mate', 5, 103, l)).toBe('△必至(5)');
    expect(formatScore('mate', 5, 103, l)).toBe('後手勝ち(必至・5手で詰み)');
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
