import { describe, expect, it } from 'vitest';
import {
  attributionOf,
  deriveRelationLabels,
  detectTactics,
  suppressForDisplay,
  type TacticLabel,
} from './index';

/** 見やすさ用。`side/label` だけを取り出す */
const names = (ls: TacticLabel[]) => ls.map((l) => `${l.side}:${l.label}`).sort();
const turnOf = (ls: TacticLabel[], label: string) => ls.find((l) => l.label === label)?.turn;

describe('detectTactics', () => {
  it('指し手が無ければ何も立たない', () => {
    expect(detectTactics([])).toEqual([]);
  });

  it('振り先の戦法と上位の振り飛車が同時に立つ（経由形も含めて全部返す）', () => {
    // ▲7六歩 △3四歩 ▲6八飛(四間) △8四歩 ▲8八飛(向かい) △8五歩
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d', '6h8h', '8d8e']);
    expect(names(ls)).toEqual([
      'gote:居飛車',
      'sente:向かい飛車',
      'sente:四間飛車',
      'sente:振り飛車',
    ]);
    // 成立手数は振り直しの順序を保つ
    expect(turnOf(ls, '四間飛車')).toBe(3);
    expect(turnOf(ls, '向かい飛車')).toBe(5);
  });

  it('石田流は三間飛車・振り飛車を必ず通る（implies の前提）', () => {
    // ▲7六歩 △3四歩 ▲7五歩 △6二銀 ▲7八飛
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '7a6b', '2h7h']);
    expect(names(ls)).toEqual(['sente:三間飛車', 'sente:振り飛車', 'sente:石田流']);
  });

  describe('ラベルの帰属（prd/03 §2.1.1）', () => {
    it('手番固有のラベルはその側だけに付く', () => {
      expect(attributionOf('四間飛車')).toBe('side');
      const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d']);
      expect(ls.filter((l) => l.label === '四間飛車')).toEqual([
        { side: 'sente', label: '四間飛車', turn: 3 },
      ]);
    });

    it('角換わりは「持ち込んだ側」1 行になる', () => {
      expect(attributionOf('角換わり')).toBe('trigger');
      // 実戦譜（一手損角換わり）。12手目 △8八角成 と後手から踏み込む
      const ls = detectTactics([
        '7g7f', '3c3d', '1g1f', '1c1d', '9g9f', '9c9d', '2g2f', '4a3b',
        '3i4h', '8c8d', '2f2e', '2b8h+', '7i8h', '3a2b', '3g3f', '7a6b',
        '4h3g', '2b3c', '3g4f', '6c6d', '3f3e', '3d3e', '4f3e', '6b6c',
      ]);
      const k = ls.filter((l) => l.label === '角換わり');
      expect(k).toHaveLength(1);
      // **双方が角換わりだが、記録するのは踏み込んだ側**（後手）
      expect(k[0].side).toBe('gote');
    });

    it('相掛かりは both の 1 行になる', () => {
      expect(attributionOf('相掛かり')).toBe('game');
      const ls = detectTactics([
        '2g2f', '8c8d', '2f2e', '8d8e', '2e2d', '2c2d', '2h2d',
        '8e8f', '8g8f', '8b8f',
      ]);
      const a = ls.filter((l) => l.label === '相掛かり');
      expect(a).toHaveLength(1);
      expect(a[0].side).toBe('both');
    });
  });

  describe('奇襲は角換わりに化けない（prd/01 §6.1 の「事象と戦法は別」）', () => {
    it('鬼殺し', () => {
      // ▲7七桂と跳ね、9手目 ▲2二角成。形は角換わりの 2二馬型と同じになる
      const ls = detectTactics([
        '7g7f', '3c3d', '8i7g', '8c8d', '7g6e', '7a6b', '7f7e', '6c6d',
        '8h2b+', '3a2b', 'B*5e', '6b6c', '6e5c+',
      ]);
      expect(names(ls)).toContain('sente:鬼殺し');
      expect(names(ls)).not.toContain('sente:角換わり');
      expect(names(ls)).not.toContain('gote:角換わり');
    });

    it('角頭歩戦法', () => {
      const ls = detectTactics([
        '7g7f', '3c3d', '8g8f', '8c8d', '8h2b+', '3a2b', '8i7g', 'B*8g',
        'B*6e', '6a5b', '7i7h', '6c6d', '6e4c+', '5b4c', '7h8g',
      ]);
      expect(names(ls)).toContain('sente:角頭歩戦法');
      expect(names(ls)).not.toContain('sente:角換わり');
    });
  });
});

describe('suppressForDisplay（prd/03 §2.1.2 の A）', () => {
  it('implies で含意される一般ラベルを隠す', () => {
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '7a6b', '2h7h']);
    // 保存は 3 つ、表示は石田流だけ
    expect(ls).toHaveLength(3);
    expect(names(suppressForDisplay(ls))).toEqual(['sente:石田流']);
  });

  it('振り直しは最初に振った先だけ残す', () => {
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d', '6h8h', '8d8e']);
    expect(names(suppressForDisplay(ls))).toEqual(['gote:居飛車', 'sente:四間飛車']);
  });

  it('抑制は表示だけで、入力の配列を壊さない', () => {
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '7a6b', '2h7h']);
    const before = names(ls);
    suppressForDisplay(ls);
    expect(names(ls)).toEqual(before);
  });

  it('手番が違えば振り先ラベルは互いに影響しない', () => {
    // 双方が振る（相振り飛車）。先手 6八飛、後手 3二飛
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8b3b']);
    const shown = names(suppressForDisplay(ls));
    expect(shown).toContain('sente:四間飛車');
    expect(shown).toContain('gote:三間飛車');
  });
});

describe('deriveRelationLabels（prd/03 §2.1.2 の B）', () => {
  it('対抗形は双方の一次ラベルから導く', () => {
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d']);
    expect(deriveRelationLabels(ls)).toEqual(['対抗形']);
  });

  it('相振り飛車', () => {
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8b3b']);
    expect(deriveRelationLabels(ls)).toEqual(['相振り飛車']);
  });

  it('⚠ 抑制後の集合から導出すると関係ラベルが落ちる（B を A の出力から作らない根拠）', () => {
    // 石田流(先手) 対 居飛車(後手)。`石田流` が `振り飛車` を隠すため、
    // 抑制後の集合では `対抗形` を導出できない
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '8c8d', '2h7h']);
    expect(deriveRelationLabels(ls)).toEqual(['対抗形']);
    expect(deriveRelationLabels(suppressForDisplay(ls))).toEqual([]);
  });
});
