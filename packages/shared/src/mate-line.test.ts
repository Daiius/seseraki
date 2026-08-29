import { describe, it, expect } from 'vitest';
import { applyMove } from './board';
import { parseSfen } from './sfen';
import { classifyMateLine } from './mate-line';

/**
 * フィクスチャは dev DB の実データ（`candidate_moves` の SFEN + PV）。
 * 「N手詰」表示の是正のきっかけになった 3 例を含む。
 */
const FIXTURES = {
  /** kifu2 #80 rank1: 初手 `N*7d` が王手でない（必至を掛ける手） */
  quietFirst: {
    sfen: 'lnkgg2nl/p8/1+Pprl2pp/P2ps1S2/+B1P1p1B2/3P1p2P/2NSP1PP1/2KGG4/1R6L b SN3p 1',
    mate: 9,
    pv: ['N*7d', '6a6b', 'S*7b', '6b7b', '8c7b', '7a7b', '8i8b+', '7b6a', 'G*7a'],
  },
  /** kifu2 #72 rank1: 攻方の手が全て王手（詰将棋の「詰み」と同じ形） */
  allChecks: {
    sfen: 'lnngg2nl/pks6/2pr3pp/PP1ps1S2/+B1P1p1B2/3P1p2P/2NSP1PP1/2KGG4/1R6L b LP2p 1',
    mate: 9,
    pv: ['L*8c', '7a8c', '8d8c+', '7b8c', '8i8c+', '8b8c', 'P*8d', '8c7b', 'S*8c'],
  },
  /** kifu1 #103 rank1: 途中に静かな手（玉の早逃げ）が混ざり、受方の逆王手も入る */
  quietMiddle: {
    sfen: '1l1+P1k1nl/s2+N1sg2/nL2Np1p1/KPPpr3p/2+b3PP1/8P/3s1P3/1+p4SR1/5G2L w 4Pb2g2p 1',
    mate: 5,
    pv: ['4a3a', '5c4a+', '3a2b', '4a4b', '7e8e'],
  },
  /** kifu1 #103 rank2: 同じ局面の別候補。静かな手が 3 手ある */
  quietMiddleLong: {
    sfen: '1l1+P1k1nl/s2+N1sg2/nL2Np1p1/KPPpr3p/2+b3PP1/8P/3s1P3/1+p4SR1/5G2L w 4Pb2g2p 1',
    mate: 7,
    pv: ['4b5c', '6b5a', '4a3a', '5a4a', '3a2b', '8c8a+', '7e8e'],
  },
  /** kifu3 #52 rank3: 全手王手 + 受方の合駒 `P*5d` が 1 枚（直後に取られる） */
  interpose: {
    sfen: 'ln5nl/9/p1pp1+B1p1/3s1Pp1p/1p2k4/2P2bPPP/PP1P2N2/3G5/LNK2G2L b R2GSPr2s2p 1',
    mate: 5,
    pv: ['R*5b', '6d5c', '5b5c+', 'P*5d', '5c5d'],
  },
} as const;

function classify(f: { sfen: string; mate: number; pv: readonly string[] }) {
  const state = parseSfen(f.sfen);
  expect(state).not.toBeNull();
  return classifyMateLine(state!, f.pv, f.mate);
}

describe('classifyMateLine', () => {
  it('初手が王手でなく以降が全て王手なら hisshi（kifu2 #80 mate 9）', () => {
    expect(classify(FIXTURES.quietFirst)).toEqual({
      kind: 'hisshi',
      plies: 9,
      checks: 4,
      interposes: 0,
    });
  });

  it('攻方の手が全て王手なら checkmate（kifu2 #72 mate 9）', () => {
    expect(classify(FIXTURES.allChecks)).toEqual({
      kind: 'checkmate',
      plies: 9,
      checks: 5,
      interposes: 0,
    });
  });

  it('途中に静かな手を挟むなら forced（kifu1 #103 mate 5）', () => {
    expect(classify(FIXTURES.quietMiddle)).toEqual({
      kind: 'forced',
      plies: 5,
      checks: 1,
      interposes: 0,
    });
  });

  it('静かな手が複数あっても forced（kifu1 #103 mate 7）', () => {
    expect(classify(FIXTURES.quietMiddleLong)).toEqual({
      kind: 'forced',
      plies: 7,
      checks: 1,
      interposes: 0,
    });
  });

  it('王手中に打たれ直後に取られた駒を合駒として数える（kifu3 #52 mate 5）', () => {
    expect(classify(FIXTURES.interpose)).toEqual({
      kind: 'checkmate',
      plies: 5,
      checks: 3,
      interposes: 1,
    });
  });

  describe('受方手番（mate が負）', () => {
    it('現局面が既に王手なら checkmate（1 手進めた kifu3 #52）', () => {
      const f = FIXTURES.interpose;
      const state = applyMove(parseSfen(f.sfen)!, f.pv[0]);
      expect(classifyMateLine(state, f.pv.slice(1), -(f.mate - 1))).toEqual({
        kind: 'checkmate',
        plies: 4,
        checks: 2,
        interposes: 1,
      });
    });

    it('現局面が王手でなく以降が全て王手なら hisshi（1 手進めた kifu2 #80）', () => {
      const f = FIXTURES.quietFirst;
      const state = applyMove(parseSfen(f.sfen)!, f.pv[0]);
      expect(classifyMateLine(state, f.pv.slice(1), -(f.mate - 1))).toEqual({
        kind: 'hisshi',
        plies: 8,
        checks: 4,
        interposes: 0,
      });
    });
  });

  describe('投了（gameover）', () => {
    /*
      dev DB の実データ: kifu 1 の 106 手目は `mate -1` / pv `["resign"]`（王手されていて詰み）。
      🔒 **`unknown` に落とさない**——落とすと既定の「N手で詰み」が出て `△1手で詰` になる（実際に踏んだ）。
      ⚠ ただし `resign` は「engine が指す手を持たない」表明でしかないので、
      **手番側が王手されていること**まで盤面で確かめてから `gameover` にする（レビュー `OCL-DA238CEA`）。
    */
    // `R*5b` は王手なので、指した後の局面は「手番側（後手）が王手されている」
    const checkedState = applyMove(parseSfen(FIXTURES.interpose.sfen)!, 'R*5b');
    // 攻め手番の局面。手番側（先手）は王手されていない
    const quietState = parseSfen(FIXTURES.allChecks.sfen)!;

    it('王手されている手番側の resign（mate が負）は gameover', () => {
      expect(classifyMateLine(checkedState, ['resign'], -1)).toEqual({
        kind: 'gameover',
        plies: 1,
        checks: 0,
        interposes: 0,
      });
    });

    it('手数の検査より先に判定する（pv が mate 距離より短くても gameover）', () => {
      expect(classifyMateLine(checkedState, ['resign'], -5).kind).toBe('gameover');
    });

    it('王手されていない resign（見切り投了）は unknown', () => {
      expect(classifyMateLine(quietState, ['resign'], -1).kind).toBe('unknown');
    });

    it('mate が正（手番側が勝っている）の resign は unknown', () => {
      // 「手番側が詰まされている」の根拠にならない
      expect(classifyMateLine(checkedState, ['resign'], 1).kind).toBe('unknown');
    });

    it('win（入玉宣言勝ち）は gameover にしない', () => {
      // 🔒 手番側が**勝つ**手なので意味が正反対
      expect(classifyMateLine(checkedState, ['win'], -1).kind).toBe('unknown');
      expect(classifyMateLine(checkedState, ['win'], 1).kind).toBe('unknown');
    });

    it('読めない指し手一般は gameover にしない（unknown のまま）', () => {
      expect(classifyMateLine(checkedState, ['bestmove'], -1).kind).toBe('unknown');
      // 2 手目以降に混ざった resign も投了局面ではない（読み筋が壊れている）
      expect(classifyMateLine(quietState, ['L*8c', 'resign'], 2).kind).toBe('unknown');
    });
  });

  describe('unknown', () => {
    const f = FIXTURES.allChecks;

    it('pv が mate 距離より短い', () => {
      const state = parseSfen(f.sfen)!;
      expect(classifyMateLine(state, f.pv.slice(0, 5), f.mate).kind).toBe('unknown');
    });

    it('pv が空', () => {
      const state = parseSfen(f.sfen)!;
      expect(classifyMateLine(state, [], f.mate).kind).toBe('unknown');
    });

    it('mate 0（既に詰み）は分類しない', () => {
      const state = parseSfen(f.sfen)!;
      expect(classifyMateLine(state, f.pv, 0)).toEqual({
        kind: 'unknown',
        plies: 0,
        checks: 0,
        interposes: 0,
      });
    });

    it('読めない指し手が混ざる', () => {
      const state = parseSfen(f.sfen)!;
      const pv: string[] = [...f.pv];
      pv[2] = 'resign';
      expect(classifyMateLine(state, pv, f.mate).kind).toBe('unknown');
    });

    it('移動元に手番側の駒が無い（盤面が追えない）', () => {
      const state = parseSfen(f.sfen)!;
      const pv: string[] = [...f.pv];
      pv[2] = '9i9h'; // 空マスからの移動
      expect(classifyMateLine(state, pv, f.mate).kind).toBe('unknown');
    });

    it('玉が盤上に無い', () => {
      const state = parseSfen('9/9/9/9/9/9/9/9/8K b - 1')!;
      expect(classifyMateLine(state, ['9i9h'], 1).kind).toBe('unknown');
    });
  });
});
