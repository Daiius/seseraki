import { describe, expect, it } from 'vitest';
import { composeKif, composeKifVerified, verifyRoundTrip } from './compose';
import { parseKif } from './parser';

/** 合成 → parse で USI 列が戻ることを確かめる（このファイルの主張はほぼ全部これ） */
function roundTrip(usiMoves: string[]): string[] {
  const kifText = composeKif(usiMoves);
  const parsed = parseKif(kifText);
  expect(parsed.errors).toEqual([]);
  return parsed.moves.map((m) => m.usi);
}

describe('composeKif', () => {
  it('平手の指し始めを KIF の指し手行にする', () => {
    const kif = composeKif(['7g7f', '3c3d', '2g2f']);
    expect(kif).toContain('手合割：平手');
    expect(kif).toContain('   1 ７六歩(77)');
    expect(kif).toContain('   2 ３四歩(33)');
    expect(kif).toContain('   3 ２六歩(27)');
  });

  it('対局者名・開始日時を書かない（動画解析では読み取れていない）', () => {
    const kif = composeKif(['7g7f']);
    expect(kif).not.toContain('先手：');
    expect(kif).not.toContain('後手：');
    expect(kif).not.toContain('開始日時');
    // 実在しない値が対局者名として保存されないこと
    expect(parseKif(kif).header.sente).toBeNull();
    expect(parseKif(kif).header.gote).toBeNull();
  });

  it('合成した KIF は平手として解釈される（usiMoves が null に落ちない）', () => {
    const parsed = parseKif(composeKif(['7g7f', '3c3d']));
    expect(parsed.header.handicap).toBe('平手');
  });
});

describe('往復（合成 → parse）', () => {
  it('成りは「成」サフィックスで往復する', () => {
    // 角交換から角成り
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b'];
    expect(composeKif(moves)).toContain('２二角成(88)');
    expect(roundTrip(moves)).toEqual(moves);
  });

  it('駒打ちは「打」で往復する', () => {
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e'];
    expect(composeKif(moves)).toContain('４五角打');
    expect(roundTrip(moves)).toEqual(moves);
  });

  it('成駒の移動は成駒名で書かれ、再び成りにならない', () => {
    // 5 手目で馬（+B）が動く。KIF では駒名が「馬」になるため、
    // parser 側が「この手で成った」と誤読しないことを確かめる。
    // ⚠ 4 手目で馬を取ってしまうと 5 手目が銀の移動になり、この検査にならない
    const moves = ['7g7f', '3c3d', '8h2b+', '5a4b', '2b3c'];
    const kif = composeKif(moves);
    expect(kif).toContain('   3 ２二角成(88)');
    expect(kif).toContain('   5 ３三馬(22)');
    expect(roundTrip(moves)).toEqual(moves);
  });

  it('と金になった歩が、次の手では成駒名で書かれる', () => {
    const moves = [
      '7g7f', '3c3d', '7f7e', '3d3e', '7e7d', '3e3f', '7d7c+', '3f3g+',
      '7c7b', '3g3h',
    ];
    const kif = composeKif(moves);
    // 成る手は「歩成」、成った駒が動く手は「と」
    expect(kif).toContain('   7 ７三歩成(74)');
    expect(kif).toContain('   9 ７二と(73)');
    expect(roundTrip(moves)).toEqual(moves);
  });

  it('空の指し手列でも壊れない', () => {
    expect(roundTrip([])).toEqual([]);
  });
});

describe('verifyRoundTrip', () => {
  it('正しい合成では ok を返す', () => {
    const moves = ['7g7f', '3c3d'];
    expect(verifyRoundTrip(moves, composeKif(moves))).toEqual({ ok: true });
  });

  it('手が食い違えば、何手目かを添えて落とす', () => {
    const kif = composeKif(['7g7f', '3c3d']);
    const result = verifyRoundTrip(['7g7f', '8c8d'], kif);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('2 手目');
  });

  it('KIF が読めなければ落とす', () => {
    const result = verifyRoundTrip(['7g7f'], '   1 ９九歩(99)\n');
    expect(result.ok).toBe(false);
  });

  it('composeKifVerified は往復しない指し手列で例外を投げる', () => {
    // 盤上に無い駒を動かす手は日本語表記の駒名が空になり、KIF として読めない
    expect(() => composeKifVerified(['5e5d'])).toThrow();
  });
});

/**
 * 実際に動画から復元された棋譜（prd/10）。
 * 手で作った例では踏まない組み合わせ（成香・成桂の移動、連続する駒打ち、
 * 同じマスへの取り返し）が入っているため、**復元器の実出力そのもの**で往復を確かめる。
 */
describe('動画解析で復元された実データ', () => {
  /** 1 本目 1 局目 — 92 手 */
  const GAME_A = [
    '7g7f', '3c3d', '2g2f', '4a3b', '6g6f', '7a6b', '4i5h', '6c6d', '5h6g', '6b6c', '3i4h',
    '6c5d', '5g5f', '8b6b', '4h5g', '3a4b', '6i7h', '5a4a', '5i6i', '6a5a', '7i6h', '7c7d',
    '6i7i', '8a7c', '2f2e', '2b3c', '3g3f', '4a3a', '1g1f', '1c1d', '2i3g', '9c9d', '9g9f',
    '6d6e', '2e2d', '2c2d', '3f3e', '3d3e', '2h2f', '9d9e', '9f9e', 'P*9g', 'P*2e', '9a9e',
    '2e2d', '9g9h+', '2d2c+', '9h8h', '7i8h', '6e6f', '5g6f', '9e9i+', '8h9i', 'P*9g',
    '9i8h', 'B*6i', 'P*9i', '6i4g+', 'L*3d', '4g3g', '2f2d', 'P*2b', '3d3c+', '4b3c',
    '2d5d', '5c5d', 'B*5c', '6b4b', '2c3b', '3a3b', 'P*3d', '3c3d', 'G*2d', '3d2c', 'P*3c',
    '2a3c', '2d2c', '3b2c', '5c3e+', 'G*2d', '3e5c', 'R*2i', '6h7i', '4b9b', '8g8f', 'L*9a',
    'S*8g', 'L*9c', '8h7g', '9g9h+', '9i9h', '9c9h+',
  ];

  /** 2 本目 2 局目 — 105 手 */
  const GAME_B = [
    '7g7f', '8c8d', '2g2f', '3c3d', '6i7h', '4a3b', '2f2e', '8d8e', '2e2d', '2c2d', '2h2d',
    '8e8f', '8g8f', '8b8f', '2d2f', '8f8b', 'P*8g', 'P*2c', '3i3h', '7a7b', '5i5h', '7c7d',
    '3g3f', '7b7c', '2i3g', '7c6d', '2f2e', '2b8h+', '7i8h', '5a5b', '4i4h', '3a2b', '8h7g',
    '2b3c', '4g4f', '3d3e', '3h4g', '3e3f', '4g3f', '7d7e', '7f7e', 'B*5d', 'B*4g', '8b8d',
    '7g8f', '9c9d', '2e2i', '6a7b', '9g9f', '6d5e', '3g4e', '3c4d', '4h3g', 'P*3e', '3f2e',
    '4d4e', '4f4e', '5d4e', '7h6h', '2a3c', 'P*4f', '3c2e', '4g2e', '4e5d', '5g5f', '5e4d',
    '6h7h', 'S*3f', '3g3f', '5d3f', '2e3f', '3e3f', 'N*7f', '8d8b', 'P*3c', '4d3c', 'B*5e',
    'P*7c', '5e3c+', '3b3c', 'P*3d', '3c3b', 'S*3c', '3b3a', 'S*3b', '3f3g+', '3b3a',
    'N*6e', '5h6i', 'B*5g', 'S*6h', 'B*4g', '6i7i', '4g2i+', '3c4b+', '5b6b', '6h5g',
    '6e5g+', '7i8h', 'R*2h', 'B*5b', '7b7a', '7f6d', '7c7d', '7e7d',
  ];

  it('1 本目 1 局目（92 手）が往復する', () => {
    expect(GAME_A).toHaveLength(92);
    expect(roundTrip(GAME_A)).toEqual(GAME_A);
  });

  it('2 本目 2 局目（105 手）が往復する', () => {
    expect(GAME_B).toHaveLength(105);
    expect(roundTrip(GAME_B)).toEqual(GAME_B);
  });

  it('成りの手が KIF でも成りとして書かれている', () => {
    const kif = composeKif(GAME_A);
    // 46 手目 9g9h+ は打った歩が成る。63 手目 3d3c+ は 59 手目に打った香が成る
    // （成った駒の種類は、その手の USI だけでは決まらず盤面が要る）
    expect(kif).toContain('  46 ９八歩成(97)');
    expect(kif).toContain('  63 ３三香成(34)');
  });
});
