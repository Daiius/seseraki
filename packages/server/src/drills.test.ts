import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from 'shared';
import { drillConfigFromEnv, extractDrills, type DrillAnalysis } from './drills';

const CONFIG = { thresholds: DEFAULT_THRESHOLDS, mateMaxPlies: 10 };

/** rank 順の候補手を組み立てる（cp 既定・`m` 接頭辞で mate） */
function analysis(
  moveNumber: number,
  ...moves: [move: string, score: number | `m${number}`, pv?: string[]][]
): DrillAnalysis {
  return {
    moveNumber,
    candidates: moves.map(([move, score, pv], i) => ({
      rank: i + 1,
      move,
      scoreType: typeof score === 'string' ? 'mate' : 'cp',
      scoreValue: typeof score === 'string' ? Number(score.slice(1)) : score,
      pv: pv ?? null,
    })),
  };
}

/** 先手が 1 手目で悪手を指した形。moveNumber 0 が先手番 */
const MOVES = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e'];

describe('extractDrills', () => {
  it('自分の悪手を best 種別で拾う（正解は rank1）', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: 'sente',
      analyses: [analysis(0, ['2g2f', 100], ['7g7f', -600])],
      config: CONFIG,
    });

    expect(drills).toHaveLength(1);
    expect(drills[0]).toMatchObject({
      moveNumber: 0,
      kind: 'best',
      reason: 'own_blunder',
      answerMove: '2g2f',
      playedMove: '7g7f',
      playedLossCp: 700,
      matePlies: null,
    });
    // 採点は行に焼き付けた候補手を引く（再解析に影響されない。prd/13 §5.1）
    expect(drills[0].candidates).toEqual([
      { rank: 1, move: '2g2f', scoreType: 'cp', scoreValue: 100 },
      { rank: 2, move: '7g7f', scoreType: 'cp', scoreValue: -600 },
    ]);
  });

  it('相手の手番の局面は拾わない（主体の手番だけ）', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: 'gote',
      analyses: [analysis(0, ['2g2f', 100], ['7g7f', -600])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });

  it('勝負が決した局面は拾わない（決着判定は labelOf に委ねる）', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: 'sente',
      analyses: [analysis(0, ['2g2f', 4000], ['7g7f', 3000])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });

  it('相手の悪手を咎め損ねた局面は「自分の悪手」として拾う（咎め条件は持たない）', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: 'sente',
      analyses: [
        // 後手が 750 損した（moveNumber 1 は後手番）
        analysis(1, ['8c8d', 50], ['3c3d', -700]),
        // 咎め損ねて 700 損した → 悪手判定がそのまま拾う
        analysis(2, ['6i7h', 800], ['2g2f', 100]),
      ],
      config: CONFIG,
    });

    expect(drills).toHaveLength(1);
    expect(drills[0]).toMatchObject({ moveNumber: 2, reason: 'own_blunder' });
  });

  it('相手の悪手を実戦で咎めていたら出題しない（自明な取り返しを持ち込まない）', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: 'sente',
      analyses: [
        analysis(1, ['8c8d', 50], ['3c3d', -700]),
        // 実手が最善そのもの。**取り返すだけの自明な 1 手**がここに来る
        analysis(2, ['2g2f', 800]),
      ],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });

  it('主体側が決まらない棋譜からは 1 問も作らない', () => {
    const drills = extractDrills({
      usiMoves: MOVES,
      subjectSide: null,
      analyses: [analysis(0, ['2g2f', 100], ['7g7f', -600])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });
});

describe('extractDrills（詰み）', () => {
  // 2 手進めた局面（先手番）。金を 5b へ打てば 5a の後手玉に王手が掛かる形を借りて、
  // **読み筋が王手の連続かどうか**の分岐だけを見る（合法性はエンジンの担当。prd/13 §3）
  const OPENING = ['7g7f', '3c3d', '2g2f'];

  it('詰み逃しを mate 種別で拾い、読み筋を正解手順として持つ', () => {
    const drills = extractDrills({
      usiMoves: OPENING,
      subjectSide: 'sente',
      analyses: [analysis(2, ['G*5b', 'm1', ['G*5b']], ['2g2f', 300])],
      config: CONFIG,
    });

    expect(drills).toHaveLength(1);
    expect(drills[0]).toMatchObject({
      moveNumber: 2,
      kind: 'mate',
      reason: 'missed_mate',
      answerMove: 'G*5b',
      matePlies: 1,
      answerPv: ['G*5b'],
    });
  });

  it('王手の連続でない詰み筋（必至など）は出題しない', () => {
    const drills = extractDrills({
      usiMoves: OPENING,
      subjectSide: 'sente',
      // 初手が静かな手の読み筋は `checkmate` に分類されない
      analyses: [analysis(2, ['5g5f', 'm3', ['5g5f', '5a4b', 'G*4c']], ['2g2f', 300])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });

  it('上限手数を超える詰みは出題しない', () => {
    const drills = extractDrills({
      usiMoves: OPENING,
      subjectSide: 'sente',
      analyses: [analysis(2, ['G*5b', 'm11', ['G*5b']], ['2g2f', 300])],
      config: { ...CONFIG, mateMaxPlies: 10 },
    });
    expect(drills).toEqual([]);
  });

  it('実際に詰ませていたら出題しない（逃した詰みだけを拾う）', () => {
    const drills = extractDrills({
      usiMoves: [...OPENING, 'G*5b'],
      subjectSide: 'sente',
      // 実手が候補 1 位の詰みそのもの
      analyses: [analysis(3, ['G*5b', 'm1', ['G*5b']])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });

  it('自分が詰まされる局面（負の mate）は best として拾わない', () => {
    const drills = extractDrills({
      usiMoves: OPENING,
      subjectSide: 'sente',
      analyses: [analysis(2, ['2g2f', 'm-3', ['2g2f']], ['5g5f', 'm-1'])],
      config: CONFIG,
    });
    expect(drills).toEqual([]);
  });
});

describe('drillConfigFromEnv', () => {
  it('未設定なら shared の既定と取りこぼしの既定（10 plies）', () => {
    const config = drillConfigFromEnv({});
    expect(config.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(config.mateMaxPlies).toBe(10);
  });

  it('環境変数で上書きできる（不正値は既定のまま）', () => {
    expect(drillConfigFromEnv({ DRILL_BLUNDER_CP: '400' }).thresholds.blunder).toBe(400);
    expect(drillConfigFromEnv({ DRILL_MATE_MAX_PLIES: '5' }).mateMaxPlies).toBe(5);
    expect(drillConfigFromEnv({ DRILL_BLUNDER_CP: 'x' }).thresholds.blunder).toBe(
      DEFAULT_THRESHOLDS.blunder,
    );
    expect(drillConfigFromEnv({ DRILL_MATE_MAX_PLIES: '-1' }).mateMaxPlies).toBe(10);
  });
});
