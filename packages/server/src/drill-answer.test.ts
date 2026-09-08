import { describe, expect, it } from 'vitest';
import { parseSfen } from 'shared';
import {
  DEFAULT_SCORING,
  isMateAfter,
  mateStep,
  scoreFromCandidates,
  scoreMove,
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
