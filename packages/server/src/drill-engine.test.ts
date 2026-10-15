// 出題の名指し評価の判定と、担当での分岐（`drill-engine.ts` の純粋な部分。DB 無し。prd/13 §5・prd/14 §5.7）。
// DB を通した流れ（解答の口・記録・担当の読み出し）は `drill-browser-grading.db.test.ts`。
import { parseSfen } from 'shared';
import { describe, expect, it } from 'vitest';
import { BROWSER_ANALYSIS_MOVETIME_MS, browserAnalysisSettingsFor } from './analysis-report.js';
import { DEFAULT_SCORING, type DrillAnswerKey } from './drill-answer.js';
import {
  DRILL_BROWSER_EVAL_MOVETIME_MS,
  drillBrowserEvalSettings,
  evaluationSourceOf,
  judgeNamedEvaluation,
} from './drill-engine.js';

const BEST: DrillAnswerKey & { id: number; ownerId: string } = {
  id: 1,
  ownerId: 'u',
  kind: 'best',
  answerMove: '2g2f',
  answerScoreType: 'cp',
  answerScoreValue: 500,
  answerPv: null,
  candidates: [{ rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 500 }],
};
const MATE = { ...BEST, kind: 'mate' as const, answerMove: 'G*5b', answerScoreType: 'mate', answerScoreValue: 3, answerPv: ['G*5b'] };

// 5a の後手玉。5b に金を打てば王手（受方の玉に利いている）
const STATE = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b G 1')!;
const input = (drill = BEST, move = '7g7f', line = [move]) => ({
  drill,
  state: STATE,
  move,
  line,
  scoring: DEFAULT_SCORING,
});

describe('evaluationSourceOf（どこで読むか。prd/14 §5.7）', () => {
  it('🔒 手元 worker にジョブを積むのは担当 worker だけ', () => {
    expect(evaluationSourceOf('worker', false)).toBe('worker');
    // 担当 worker がブラウザの結果を付けてきても使わない（切り替え直後の送り直しなど）
    expect(evaluationSourceOf('worker', true)).toBe('worker');
  });

  it('担当 browser は結果が無ければ読ませ、付いていればそれで判定する', () => {
    expect(evaluationSourceOf('browser', false)).toBe('ask-browser');
    expect(evaluationSourceOf('browser', true)).toBe('use-browser');
  });

  it('担当が読めなければ手元 worker を使わせない', () => {
    expect(evaluationSourceOf(null, false)).toBe('ask-browser');
  });
});

describe('ブラウザに読ませる設定', () => {
  it('🔒 全局面解析の full と同じ値（思考時間 600ms）を共有する', () => {
    expect(drillBrowserEvalSettings()).toEqual(browserAnalysisSettingsFor('full'));
    expect(DRILL_BROWSER_EVAL_MOVETIME_MS).toBe(BROWSER_ANALYSIS_MOVETIME_MS.full);
    expect(drillBrowserEvalSettings().movetimeMs).toBe(600);
  });
});

describe('judgeNamedEvaluation（次の一手。prd/13 §5.1）', () => {
  it('最善との差で 3 段階に分け、記録する', () => {
    const close = judgeNamedEvaluation(input(), { scoreType: 'cp', scoreValue: 300, pv: ['7g7f', '3c3d'] });
    expect(close.answer).toEqual({ status: 'done', verdict: 'close', lossCp: 200 });
    expect(close.attempt).toEqual({ verdict: 'close', lossCp: 200 });
    expect(close.remember).toBeNull();
  });

  it('不正解には咎め筋（相手の応手から）を付ける', () => {
    const wrong = judgeNamedEvaluation(input(), { scoreType: 'cp', scoreValue: -200, pv: ['7g7f', '3c3d', '2g2f'] });
    expect(wrong.answer).toEqual({ status: 'done', verdict: 'wrong', lossCp: 700, refutation: ['3c3d', '2g2f'] });
  });

  it('正の mate は差を取らずに正解・負の mate は不正解', () => {
    expect(judgeNamedEvaluation(input(), { scoreType: 'mate', scoreValue: 5, pv: ['7g7f'] }).answer).toMatchObject({
      verdict: 'correct',
      lossCp: null,
    });
    expect(judgeNamedEvaluation(input(), { scoreType: 'mate', scoreValue: -3, pv: ['7g7f', '3c3d'] }).answer).toMatchObject({
      verdict: 'wrong',
      lossCp: null,
    });
  });

  it('🔴 候補なしは、その手で王手なら詰み上がり（正解）・王手でなければ不正解', () => {
    expect(judgeNamedEvaluation(input(BEST, 'G*5b'), undefined).answer).toEqual({
      status: 'done',
      verdict: 'correct',
      lossCp: null,
    });
    expect(judgeNamedEvaluation(input(BEST, 'G*9i'), undefined).attempt).toEqual({ verdict: 'wrong', lossCp: null });
  });
});

describe('judgeNamedEvaluation（実戦詰将棋の別解。prd/13 §5.2）', () => {
  it('🔴 詰みが返れば別解として正解手順を引き継ぎ、受方の応手を返す（まだ記録しない）', () => {
    const judged = judgeNamedEvaluation(input(MATE, 'G*4b'), {
      scoreType: 'mate',
      scoreValue: 3,
      pv: ['G*4b', '5a6a', 'G*6b'],
    });
    expect(judged.answer).toEqual({ status: 'continue', reply: '5a6a' });
    expect(judged.attempt).toBeNull();
    expect(judged.remember).toEqual(['G*4b', '5a6a', 'G*6b']);
  });

  it('別解の手順は「ここまでの手順 + 読み筋の残り」', () => {
    const judged = judgeNamedEvaluation(input(MATE, 'G*4b', ['G*5b', '5a4a', 'G*4b']), {
      scoreType: 'mate',
      scoreValue: 1,
      pv: ['G*4b', '4a3a', 'G*3b'],
    });
    expect(judged.remember).toEqual(['G*5b', '5a4a', 'G*4b', '4a3a', 'G*3b']);
  });

  it('🔴 読み筋がその手で終わる詰みは done（continue を永久に返さない）', () => {
    expect(
      judgeNamedEvaluation(input(MATE, 'G*5b'), { scoreType: 'mate', scoreValue: 1, pv: ['G*5b'] }).answer,
    ).toEqual({ status: 'done', verdict: 'correct', lossCp: null });
  });

  it('詰まなければ不正解と咎め筋', () => {
    expect(
      judgeNamedEvaluation(input(MATE, 'G*9i'), { scoreType: 'cp', scoreValue: 900, pv: ['G*9i', '5a4b'] }).answer,
    ).toEqual({ status: 'done', verdict: 'wrong', lossCp: null, refutation: ['5a4b'] });
  });

  it('🔴 候補なしを「詰みません」と読まない（王手なら詰み上がり）', () => {
    expect(judgeNamedEvaluation(input(MATE, 'G*5b'), undefined).answer).toMatchObject({ verdict: 'correct' });
    expect(judgeNamedEvaluation(input(MATE, 'G*9i'), undefined).answer).toMatchObject({ verdict: 'wrong' });
  });
});
