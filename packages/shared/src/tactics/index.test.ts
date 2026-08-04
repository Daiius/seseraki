import { describe, expect, it } from 'vitest';
import {
  attributionOf,
  detectTactics,
  RELATION_FILTERS,
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
    // ▲7六歩 △3四歩 ▲6八飛(四間) △8四歩 ▲7七角 △8五歩 ▲8八飛(向かい)
    // ※ 8八には自分の角がいるので、振り直す前に角を上がる（合法手順にする）
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d', '8h7g', '8d8e', '6h8h']);
    expect(names(ls)).toEqual([
      'gote:居飛車',
      'sente:向かい飛車',
      'sente:四間飛車',
      'sente:振り飛車',
    ]);
    // 成立手数は振り直しの順序を保つ
    expect(turnOf(ls, '四間飛車')).toBe(3);
    expect(turnOf(ls, '向かい飛車')).toBe(7);
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

  describe('右辺の飛車は居飛車（prd/01 §6.3）', () => {
    it('飛車先を突かなくても 4八飛なら居飛車が立ち、表示では右四間飛車が隠す', () => {
      // ▲7六歩 △3四歩 ▲4六歩 △8四歩 ▲4八飛。**2六歩を一度も突いていない**
      const ls = detectTactics(['7g7f', '3c3d', '4g4f', '8c8d', '2h4h']);
      expect(names(ls)).toContain('sente:右四間飛車');
      expect(names(ls)).toContain('sente:居飛車');
      // `IMPLIES` により表示では居飛車が畳まれる
      expect(names(suppressForDisplay(ls))).toEqual(['gote:居飛車', 'sente:右四間飛車']);
    });

    it('先に振っていたら、そのあとの 4八飛は右四間飛車ではない', () => {
      // ▲7六歩 △3四歩 ▲6八飛(四間) △8四歩 ▲4八飛 — 中盤の飛車の転回であって戦法ではない
      const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d', '6h4h']);
      expect(names(ls)).toContain('sente:四間飛車');
      expect(names(ls)).not.toContain('sente:右四間飛車');
    });

    it('玉を左辺へ囲ってから 5筋へ回しても振り飛車ではない', () => {
      // ▲7六歩 △3四歩 ▲6八玉 △8四歩 ▲5八飛。飛車と玉が同じ側 = 振り飛車の駒組みではない
      const ls = detectTactics(['7g7f', '3c3d', '5i6h', '8c8d', '2h5h']);
      expect(names(ls)).not.toContain('sente:中飛車');
      expect(names(ls)).not.toContain('sente:振り飛車');
    });

    it('このガードは振り先ラベル全部に掛かる（`IMPLIES` の 振り先 ⟹ 振り飛車 を保つ）', () => {
      // ▲7六歩 △3四歩 ▲6八玉 △8四歩 ▲7八飛。中飛車だけに掛けていた頃は、
      // ここで `三間飛車` が立つのに `振り飛車` が立たず、宣言した含意が壊れていた
      const ls = detectTactics(['7g7f', '3c3d', '5i6h', '8c8d', '2h7h']);
      expect(names(ls)).not.toContain('sente:三間飛車');
      expect(names(ls)).not.toContain('sente:振り飛車');
    });

    it('玉を囲う前に振る形（陽動振り飛車）では居飛車と振り飛車が両立する', () => {
      // ▲2六歩 △3四歩 ▲6八飛 …。居飛車で出だして途中で振った**経過**であって誤りではない。
      // bioshogi 自身も両方を付ける（`陽動振り飛車.kif` = 戦法[四間飛車, 陽動振り飛車] + 備考[居飛車]）
      const ls = detectTactics(['2g2f', '3c3d', '2h6h', '8c8d', '6i7h']);
      expect(names(ls)).toContain('sente:居飛車');
      expect(names(ls)).toContain('sente:四間飛車');
      expect(names(ls)).toContain('sente:振り飛車');
    });
  });

  describe('相掛かりと囲いは別の軸（prd/01 §6.3）', () => {
    it('相掛かりの出だしから雁木に組んでも相掛かりのまま', () => {
      // `ショーダンオリジナル.kif` の出だし。13〜15手目に飛車先を交換してから
      // 17▲6六歩 21▲6七銀 と雁木に組む。**雁木は囲いなので戦型は相掛かりのまま**
      const ls = detectTactics([
        '2g2f', '8c8d', '2f2e', '4a3b', '7g7f', '8d8e', '8h7g', '7a6b',
        '7i6h', '1c1d', '6i7h', '5c5d', '2e2d', '2c2d', '2h2d', '6b5c',
        '6g6f', 'P*2c', '2d2h', '5d5e', '6h6g',
      ]);
      expect(names(ls)).toContain('both:相掛かり');
      // 雁木は一次ラベルから外した（囲い判定の系統で扱う）
      expect(names(ls)).not.toContain('sente:雁木');
    });

    it('角道を止めてから飛車先を伸ばした将棋は相掛かりではない', () => {
      // ▲7六歩 △8四歩 ▲**6六歩** △8五歩 ▲2六歩 △3二金 ▲2五歩 △8六歩 ▲同歩 △同飛
      // 飛車先を伸ばし合って歩も交換されるが、**角道を止める方が先**なので相掛かりではない
      // （`ツノ銀型右玉.kif` = 1▲7六歩 3▲6六歩 … 13▲2六歩 15▲2五歩 と同じ順序）
      const ls = detectTactics([
        '7g7f', '8c8d', '6g6f', '8d8e', '2g2f', '4a3b', '2f2e',
        '8e8f', '8g8f', '8b8f',
      ]);
      expect(names(ls)).not.toContain('both:相掛かり');
    });
  });

  describe('相掛かりは飛車先の歩交換を許し合う戦型', () => {
    it('角で飛車先を受けてから伸ばし合った将棋は相掛かりではない', () => {
      // 実戦譜。▲2六歩 △3四歩 ▲2五歩 **△3三角** と角で受けてから △8四歩 △8五歩 と
      // 飛車先を伸ばし、△8六歩 で**後手だけ**が歩を交換する。先手は 3三角に受けられて
      // 交換できないので、「双方が伸ばし合い、片方が交換した」という条件は通ってしまう
      const ls = detectTactics([
        '2g2f', '3c3d', '2f2e', '2b3c', '3i4h', '8c8d', '6i7h', '8d8e',
        '9g9f', '7a6b', '5i6i', '8e8f', '8g8f', '8b8f', 'P*8g', '8f8b',
      ]);
      expect(names(ls)).not.toContain('both:相掛かり');
      expect(names(ls)).toEqual(['gote:居飛車', 'sente:居飛車']);
    });

    it('相掛かりに組んでから角を上がるのは普通のこと（`hit` で見る理由）', () => {
      // ▲2六歩 △8四歩 ▲2五歩 △8五歩 まで**角を上げずに**伸ばし合ってから △3三角。
      // 上の否定条件を歩交換の完了時で見ると、この形まで相掛かりから落ちる
      const ls = detectTactics([
        '2g2f', '8c8d', '2f2e', '8d8e', '7g7f', '3c3d', '8h7g', '2b3c',
        '2e2d', '2c2d', '2h2d',
      ]);
      expect(names(ls)).toContain('both:相掛かり');
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

describe('観測窓（prd/01 §6.2）', () => {
  it('角交換なら窓は閉じない（角交換は開戦ではない）', () => {
    // ▲7六歩 △3四歩 ▲2二角成 △同銀（角交換） ▲6八飛
    const ls = detectTactics(['7g7f', '3c3d', '8h2b+', '3a2b', '2h6h']);
    expect(names(ls)).toContain('sente:四間飛車');
  });

  it('⚠ 交換でない角取りでは窓が閉じる（角損・角切りは開戦）', () => {
    // ▲2二角成 に △同銀 とせず、馬が逃げる。**後手は角を持ち駒にしていない**ので交換ではない。
    // 窓が 2 手目で閉じ、7手目の ▲6八飛 は拾わない
    const ls = detectTactics(['7g7f', '3c3d', '8h2b+', '6a5b', '2b3a', '8c8d', '2h6h']);
    expect(names(ls)).not.toContain('sente:四間飛車');
    expect(names(ls)).not.toContain('sente:振り飛車');
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
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d', '8h7g', '8d8e', '6h8h']);
    expect(names(suppressForDisplay(ls))).toEqual(['gote:居飛車', 'sente:四間飛車']);
  });

  it('抑制は表示だけで、入力の配列を壊さない', () => {
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '7a6b', '2h7h']);
    const before = names(ls);
    suppressForDisplay(ls);
    expect(names(ls)).toEqual(before);
  });

  it('片側の派生ラベルは相手側の一般ラベルを隠さない', () => {
    // 先手が石田流、後手が（石田流でない）三間飛車。先手の `石田流` は自分の
    // `三間飛車` `振り飛車` だけを隠し、後手のものには触れない
    const ls: TacticLabel[] = [
      { side: 'sente', label: '石田流', turn: 5 },
      { side: 'sente', label: '三間飛車', turn: 5 },
      { side: 'sente', label: '振り飛車', turn: 5 },
      { side: 'gote', label: '三間飛車', turn: 6 },
      { side: 'gote', label: '振り飛車', turn: 6 },
    ];
    // 後手の `三間飛車` は**自分の** `振り飛車` を隠す（それは正しい）。
    // 見たいのは「先手の `石田流` が後手の `三間飛車` を消さない」こと
    expect(names(suppressForDisplay(ls))).toEqual(['gote:三間飛車', 'sente:石田流']);
  });

  it('対局帰属のラベルは双方のタグを隠す（相掛かり ⟹ 双方が居飛車）', () => {
    const ls = detectTactics([
      '2g2f', '8c8d', '2f2e', '8d8e', '2e2d', '2c2d', '2h2d',
      '8e8f', '8g8f', '8b8f',
    ]);
    expect(names(ls)).toEqual(['both:相掛かり', 'gote:居飛車', 'sente:居飛車']);
    expect(names(suppressForDisplay(ls))).toEqual(['both:相掛かり']);
  });

  it('手番が違えば振り先ラベルは互いに影響しない', () => {
    // 双方が振る（相振り飛車）。先手 6八飛、後手 3二飛
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8b3b']);
    const shown = names(suppressForDisplay(ls));
    expect(shown).toContain('sente:四間飛車');
    expect(shown).toContain('gote:三間飛車');
  });
});

describe('対局レベルの関係は絞り込みの語彙として持つ（RELATION_FILTERS）', () => {
  /** `RELATION_FILTERS` の言うとおり、双方に per-side ラベルが**保存されている**か */
  const matches = (ls: TacticLabel[], relation: string) => {
    const label = RELATION_FILTERS[relation];
    return (['sente', 'gote'] as const).every((side) =>
      ls.some((l) => l.side === side && l.label === label),
    );
  };

  it('タグとしては出さない（双方の per-side タグを見れば読めるため）', () => {
    // ▲7六歩 △3四歩 ▲6八飛(四間) △8四歩 = 振り飛車 対 居飛車
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8c8d']);
    expect(names(ls)).toContain('sente:四間飛車');
    expect(names(ls)).toContain('gote:居飛車');
    // `対抗形` `相居飛車` `相振り飛車` はどれもラベルとして返らない
    expect(ls.map((l) => l.label)).not.toContain('対抗形');
    expect(ls.map((l) => l.label)).not.toContain('相居飛車');
  });

  it('相居飛車は双方の `居飛車` が保存されていることで引ける', () => {
    const ls = detectTactics(['2g2f', '8c8d']);
    expect(matches(ls, '相居飛車')).toBe(true);
    expect(matches(ls, '相振り飛車')).toBe(false);
  });

  it('相振り飛車は双方の `振り飛車` が保存されていることで引ける', () => {
    const ls = detectTactics(['7g7f', '3c3d', '2h6h', '8b3b']);
    expect(matches(ls, '相振り飛車')).toBe(true);
    expect(matches(ls, '相居飛車')).toBe(false);
  });

  it('⚠ 引くのは保存値。表示用に抑制した集合では引けない', () => {
    // 双方が石田流。`石田流` が `三間飛車` → `振り飛車` を隠すので、
    // 表示用の集合を絞り込みに使うと相振り飛車が引けなくなる
    const ls = detectTactics(['7g7f', '3c3d', '7f7e', '3d3e', '2h7h', '8b3b']);
    expect(matches(ls, '相振り飛車')).toBe(true);
    expect(matches(suppressForDisplay(ls), '相振り飛車')).toBe(false);
  });
});
