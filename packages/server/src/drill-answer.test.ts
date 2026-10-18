import { describe, expect, it } from 'vitest';
import { parseSfen, usiToJapaneseWithPiece } from 'shared';
import {
  DEFAULT_SCORING,
  givesCheck,
  isGiveUpLine,
  isMateAfter,
  matchMateLine,
  isPrefixOf,
  isReachableMove,
  mateStep,
  scoreFromCandidates,
  scoreMove,
  stateOfAnswer,
  verdictOf,
  type DrillAnswerKey,
} from './drill-answer';

const KEY: DrillAnswerKey = {
  kind: 'best',
  answerMove: '2g2f',
  answerScoreType: 'cp',
  answerScoreValue: 500,
  answerPv: null,
  candidates: [
    { rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 500 },
    { rank: 2, move: '7g7f', scoreType: 'cp', scoreValue: 450 },
    { rank: 3, move: '6i7h', scoreType: 'cp', scoreValue: 100 },
  ],
};

describe('verdictOf', () => {
  it('許容差の境界（既定 100 / 300）', () => {
    expect(verdictOf(100, DEFAULT_SCORING)).toBe('correct');
    expect(verdictOf(101, DEFAULT_SCORING)).toBe('close');
    expect(verdictOf(300, DEFAULT_SCORING)).toBe('close');
    expect(verdictOf(301, DEFAULT_SCORING)).toBe('wrong');
  });

  it('負の損失も正解（2 回の探索は深さが揃わない）', () => {
    expect(verdictOf(-40, DEFAULT_SCORING)).toBe('correct');
  });

  it('線引きは設定に従う（ハードコードしない）', () => {
    const strict = { correctMargin: 0, closeMargin: 50 };
    expect(verdictOf(1, strict)).toBe('close');
    expect(verdictOf(51, strict)).toBe('wrong');
  });
});

describe('scoreFromCandidates', () => {
  it('候補内なら差で採点する（エンジンに回さない）', () => {
    expect(scoreFromCandidates(KEY, '2g2f', DEFAULT_SCORING)).toEqual({
      verdict: 'correct',
      lossCp: 0,
    });
    expect(scoreFromCandidates(KEY, '7g7f', DEFAULT_SCORING)).toEqual({
      verdict: 'correct',
      lossCp: 50,
    });
    expect(scoreFromCandidates(KEY, '6i7h', DEFAULT_SCORING)).toEqual({
      verdict: 'wrong',
      lossCp: 400,
    });
  });

  it('候補に無ければ null（エンジンへ回す合図）', () => {
    expect(scoreFromCandidates(KEY, '9g9f', DEFAULT_SCORING)).toBeNull();
  });
});

describe('scoreMove（スコア型の分岐。prd/13 §5.1）', () => {
  it('正の mate は差を取らずに正解', () => {
    expect(scoreMove(KEY, { scoreType: 'mate', scoreValue: 5 }, DEFAULT_SCORING)).toEqual({
      verdict: 'correct',
      lossCp: null,
    });
  });

  it('負の mate（詰まされる）は不正解。損失は持たない', () => {
    expect(scoreMove(KEY, { scoreType: 'mate', scoreValue: -3 }, DEFAULT_SCORING)).toEqual({
      verdict: 'wrong',
      lossCp: null,
    });
  });

  it('最善が詰みで回答が cp なら不正解（差は測れない）', () => {
    const mateKey = { ...KEY, answerScoreType: 'mate', answerScoreValue: 3 };
    expect(scoreMove(mateKey, { scoreType: 'cp', scoreValue: 2000 }, DEFAULT_SCORING)).toEqual({
      verdict: 'wrong',
      lossCp: null,
    });
  });
});

describe('mateStep（指し継ぎ。prd/13 §5.2）', () => {
  const pv = ['G*5b', '5a6a', 'G5b6b'];

  it('正解手順どおりなら受方の応手を返す', () => {
    expect(mateStep(pv, ['G*5b'])).toEqual({ state: 'match', reply: '5a6a', solved: false });
  });

  it('読み筋を使い切ったら詰み上がり', () => {
    expect(mateStep(pv, ['G*5b', '5a6a', 'G5b6b'])).toEqual({
      state: 'match',
      reply: null,
      solved: true,
    });
  });

  it('外れたら deviated（別解かもしれないのでエンジンへ）', () => {
    expect(mateStep(pv, ['G*5a'])).toEqual({ state: 'deviated' });
    expect(mateStep(pv, ['G*5b', '5a6a', 'G5b5c'])).toEqual({ state: 'deviated' });
    expect(mateStep(null, ['G*5b'])).toEqual({ state: 'deviated' });
  });
});

describe('isPrefixOf（手順が問いのものか。prd/13 §5.3）', () => {
  const expected = ['G*5b', '5a6a', 'G5b6b'];

  it('先頭が一致していれば true（空も先頭）', () => {
    expect(isPrefixOf([], expected)).toBe(true);
    expect(isPrefixOf(['G*5b'], expected)).toBe(true);
    expect(isPrefixOf(['G*5b', '5a6a'], expected)).toBe(true);
  });

  it('食い違う手順・長すぎる手順は false（別局面で採点させない）', () => {
    expect(isPrefixOf(['G*5a'], expected)).toBe(false);
    expect(isPrefixOf(['G*5b', '5a4a'], expected)).toBe(false);
    expect(isPrefixOf([...expected, 'P*5c'], expected)).toBe(false);
    expect(isPrefixOf(['7g7f'], [])).toBe(false);
  });
});

describe('isReachableMove（駒の動き方として指せるか。prd/13 §3）', () => {
  // 5五の先手歩、5三の先手飛、持ち駒に金
  const state = parseSfen('4k4/9/4R4/9/4P4/9/9/9/4K4 b G 1')!;

  it('動ける手は true', () => {
    expect(isReachableMove(state, '5e5d')).toBe(true);
    expect(isReachableMove(state, '5c5b')).toBe(true);
    expect(isReachableMove(state, 'G*5d')).toBe(true);
  });

  it('🔴 歩を横に動かす手は false（検討盤では通るが、出題では答えにならない）', () => {
    expect(isReachableMove(state, '5e4e')).toBe(false);
  });

  it('駒を飛び越える手・駒の無いマスからの手・壊れた表記は false', () => {
    expect(isReachableMove(state, '5c5f')).toBe(false); // 5e の歩を飛び越える
    expect(isReachableMove(state, '1a1b')).toBe(false);
    expect(isReachableMove(state, 'zzz')).toBe(false);
  });

  it('埋まっているマス・二歩になるマスへは打てない', () => {
    expect(isReachableMove(state, 'G*5e')).toBe(false);
    expect(isReachableMove(state, 'P*5d')).toBe(false);
  });
});

describe('isMateAfter（候補なしの終局判定。prd/13 §5.2）', () => {
  // 5a の後手玉。6b に金を打てば王手（受方の玉に利いている）
  const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b G 1')!;

  it('王手になる手は詰み上がりとみなす', () => {
    expect(isMateAfter(state, 'G*5b', 'sente')).toBe(true);
  });

  it('王手にならない手は詰み上がりとみなさない（入玉宣言でも候補は空になる）', () => {
    expect(isMateAfter(state, 'G*9i', 'sente')).toBe(false);
  });

  it('読めない手は false（数字を捏造しない）', () => {
    expect(isMateAfter(state, 'zzz', 'sente')).toBe(false);
  });
});

describe('givesCheck（詰将棋の手は王手でなければ不正解。prd/13 §5.2）', () => {
  const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b G 1')!;

  it('受方の玉に王手が掛かる手だけ true', () => {
    expect(givesCheck(state, 'G*5b', 'sente')).toBe(true);
    expect(givesCheck(state, 'G*9i', 'sente')).toBe(false);
  });

  it('読めない手は false', () => {
    expect(givesCheck(state, 'zzz', 'sente')).toBe(false);
  });
});

describe('matchMateLine（元の正解手順と覚えた別解の両方で照らす。prd/13 §5.2）', () => {
  const pv = ['a1', 'r1', 'a2'];
  const alt = ['b1', 'r2', 'b2', 'r3', 'b3'];

  it('どちらの先頭にも合わなければ mismatch（400）', () => {
    expect(matchMateLine([alt, pv], ['c1', 'r1', 'x'])).toEqual({ state: 'mismatch' });
  });

  it('🔴 別解を覚えていても、元の正解手順をなぞれば受方の応手を返す（やり直し）', () => {
    expect(matchMateLine([alt, pv], ['a1'])).toEqual({ state: 'match', reply: 'r1', solved: false });
    expect(matchMateLine([alt, pv], ['a1', 'r1', 'a2'])).toEqual({ state: 'match', reply: null, solved: true });
  });

  it('覚えた別解をなぞれば別解の応手を返す', () => {
    expect(matchMateLine([alt, pv], ['b1', 'r2', 'b2'])).toEqual({ state: 'match', reply: 'r3', solved: false });
  });

  it('手順は合うが最後の手が外れたら deviated（エンジンへ）', () => {
    expect(matchMateLine([alt, pv], ['a1', 'r1', 'z'])).toEqual({ state: 'deviated' });
    expect(matchMateLine([null, pv], ['z'])).toEqual({ state: 'deviated' });
  });

  it('正解手順が 1 本も無ければ mismatch', () => {
    expect(matchMateLine([null, null], ['a1'])).toEqual({ state: 'mismatch' });
  });
});

describe('isGiveUpLine（諦めの手順の検証。prd/13 §5.3）', () => {
  const pv = ['a1', 'r1', 'a2', 'r2', 'a3'];
  const alt = ['b1', 'r9', 'b2'];

  it('次の一手は空の手順だけ', () => {
    expect(isGiveUpLine('best', [], [])).toBe(true);
    expect(isGiveUpLine('best', ['a1'], [])).toBe(false);
  });

  it('詰将棋は空か、正解手順（元の pv・覚えた別解）の先頭の偶数手', () => {
    expect(isGiveUpLine('mate', [], [null, pv])).toBe(true);
    expect(isGiveUpLine('mate', ['a1', 'r1'], [null, pv])).toBe(true);
    expect(isGiveUpLine('mate', ['b1', 'r9'], [alt, pv])).toBe(true);
    expect(isGiveUpLine('mate', ['a1', 'r1'], [alt, pv])).toBe(true);
  });

  it('奇数手（最後がユーザーの手）・先頭が合わない手順は false', () => {
    expect(isGiveUpLine('mate', ['a1'], [null, pv])).toBe(false);
    expect(isGiveUpLine('mate', ['a1', 'x'], [null, pv])).toBe(false);
    expect(isGiveUpLine('mate', ['b1', 'r9'], [null, pv])).toBe(false);
  });
});

describe('stateOfAnswer（表記を作る盤面。prd/13 §5.4・レビュー OCL-A1E622FE）', () => {
  // 5五の先手歩、5三の先手飛、5一の後手玉
  const base = parseSfen('4k4/9/4R4/9/4P4/9/9/9/4K4 b G 1')!;
  /** 詰将棋の指し継ぎ。最後の 5b4b を指すのは**出題局面ではなく 2 手進んだ局面** */
  const line = ['5c5b', '5a4a', '5b4b'];

  it('🔴 詰将棋は手順を積んだ局面を返す（出題局面から読むと駒が居ない）', () => {
    const state = stateOfAnswer(base, line, '5b4b', 'mate')!;
    expect(state).not.toBeNull();
    // 出題局面では 5b は空なので駒名が出ない。手順を積めば飛として読める
    expect(usiToJapaneseWithPiece(state, '5b4b')).toContain('飛');
    expect(usiToJapaneseWithPiece(base, '5b4b')).not.toContain('飛');
  });

  it('次の一手は手順が無くても出題局面でよい（1 手なので同じ）', () => {
    expect(stateOfAnswer(base, null, '5c5b', 'best')).toBe(base);
    expect(stateOfAnswer(base, ['5c5b'], '5c5b', 'best')).toBe(base);
  });

  it('🔒 手順を持たない既存の詰将棋の行は null（復元できない表記を作らない）', () => {
    expect(stateOfAnswer(base, null, '5b4b', 'mate')).toBeNull();
  });

  it('手順の最後が記録された手と食い違う行は null', () => {
    expect(stateOfAnswer(base, line, '5c5b', 'mate')).toBeNull();
  });

  it('読めない手が混ざった手順は null（数字を捏造しない）', () => {
    expect(stateOfAnswer(base, ['zzz', '5b4b'], '5b4b', 'mate')).toBeNull();
  });
});
