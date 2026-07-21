import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  computeMoveLosses,
  formatLoss,
  labelOf,
  labelText,
  type CplAnalysis,
  type Thresholds,
} from './cpl';
import { applyThresholdInput, parseThresholds } from './thresholds';

/** rank 順の候補手を組み立てる（cp 既定・`m` 接頭辞で mate） */
function candidates(...moves: [move: string, score: number | `m${number}`][]) {
  return moves.map(([move, score], i) => ({
    rank: i + 1,
    move,
    scoreType: typeof score === 'string' ? 'mate' : 'cp',
    scoreValue: typeof score === 'string' ? Number(score.slice(1)) : score,
  }));
}

function analysis(moveNumber: number, ...args: Parameters<typeof candidates>): CplAnalysis {
  return { moveNumber, candidates: candidates(...args) };
}

describe('computeMoveLosses', () => {
  it('実手が候補内なら、その候補のスコアとの差を損失にする（近似ではない）', () => {
    // 3 位の手を選んで 700cp 損した。旧判定は「実手が候補内なら悪手にしない」ため
    // これを永久に取りこぼしていた（issue #28）
    const analyses = [
      analysis(0, ['7g7f', 100], ['2g2f', 60], ['5g5f', -600]),
      analysis(1, ['3c3d', -300]),
    ];
    const losses = computeMoveLosses(analyses, ['5g5f', '3c3d']);

    expect(losses.get(0)).toEqual({
      moveNumber: 0,
      bestCp: 100,
      loss: 700,
      approximate: false,
      mate: null,
    });
    expect(labelOf(losses.get(0)!, DEFAULT_THRESHOLDS)).toBe('blunder');
  });

  it('実手が候補外なら次局面の最善値を符号反転して近似する', () => {
    // 手番が入れ替わるので next の +250（後手視点）は先手にとって -250
    const analyses = [
      analysis(0, ['7g7f', 100], ['2g2f', 60]),
      analysis(1, ['3c3d', 250]),
    ];
    const losses = computeMoveLosses(analyses, ['9g9f', '3c3d']);

    expect(losses.get(0)).toEqual({
      moveNumber: 0,
      bestCp: 100,
      loss: 350,
      approximate: true,
      mate: null,
    });
  });

  it('後手番でも手番視点のまま比較する（符号反転しない）', () => {
    const analyses = [
      analysis(1, ['3c3d', 200], ['8c8d', -100]),
      analysis(2, ['2g2f', 100]),
    ];
    const losses = computeMoveLosses(analyses, ['7g7f', '8c8d']);

    expect(losses.get(1)?.loss).toBe(300);
    expect(losses.get(1)?.approximate).toBe(false);
  });

  it('実手が候補外で次局面の解析も無ければ判定できない', () => {
    const analyses = [analysis(0, ['7g7f', 100])];
    const losses = computeMoveLosses(analyses, ['9g9f']);

    expect(losses.has(0)).toBe(false);
  });

  it('実手が候補内なら次局面が無くても判定できる（詰みで終わった棋譜の最終手）', () => {
    // エンジンは詰み局面で info 行を返さないため最終局面の解析は空になる
    const analyses = [analysis(10, ['5e5d', 200], ['4e4d', -600]), { moveNumber: 11, candidates: [] }];
    const losses = computeMoveLosses(analyses, [...Array(10).fill('7g7f'), '4e4d']);

    expect(losses.get(10)?.loss).toBe(800);
    expect(losses.get(10)?.approximate).toBe(false);
  });

  it('指し手の無い局面（最終局面）はエントリを作らない', () => {
    const analyses = [analysis(0, ['7g7f', 100]), analysis(1, ['3c3d', -100])];
    const losses = computeMoveLosses(analyses, ['7g7f']);

    expect([...losses.keys()]).toEqual([0]);
  });

  it('候補手が空の局面は飛ばす', () => {
    const analyses = [{ moveNumber: 0, candidates: [] }, analysis(1, ['3c3d', -100])];
    const losses = computeMoveLosses(analyses, ['7g7f', '3c3d']);

    expect(losses.has(0)).toBe(false);
  });

  it('詰みを逃したら CPL を計算せず詰み逃しにする', () => {
    const analyses = [
      analysis(0, ['5e5d', 'm5'], ['4e4d', 300]),
      analysis(1, ['3c3d', -200]),
    ];
    const losses = computeMoveLosses(analyses, ['4e4d', '3c3d']);

    expect(losses.get(0)).toEqual({
      moveNumber: 0,
      bestCp: null,
      loss: null,
      approximate: false,
      mate: { kind: 'missed', moves: 5 },
    });
  });

  it('詰みを逃さず詰ましたら詰み逃しにしない', () => {
    const analyses = [analysis(0, ['5e5d', 'm5'], ['4e4d', 300])];
    const losses = computeMoveLosses(analyses, ['5e5d']);

    expect(losses.get(0)?.mate).toBeNull();
    expect(losses.get(0)?.loss).toBeNull();
  });

  it('実手で詰まされる筋に入ったら詰まされにする', () => {
    // 実手は候補外。次局面で相手が 3 手詰（後手視点 +3）→ 手番側から見て -3
    const analyses = [
      analysis(0, ['7g7f', 100]),
      analysis(1, ['3c3d', 'm3']),
    ];
    const losses = computeMoveLosses(analyses, ['9g9f', '3c3d']);

    expect(losses.get(0)?.mate).toEqual({ kind: 'into', moves: 3 });
    expect(losses.get(0)?.loss).toBeNull();
    expect(losses.get(0)?.approximate).toBe(true);
  });

  it('もともと詰まされていた局面は詰まされにしない（詰み手順の各手を拾わない）', () => {
    const analyses = [
      analysis(0, ['7g7f', 'm-5']),
      analysis(1, ['3c3d', 'm3']),
    ];
    const losses = computeMoveLosses(analyses, ['9g9f', '3c3d']);

    expect(losses.get(0)?.mate).toBeNull();
  });
});

describe('labelOf', () => {
  const base = { moveNumber: 0, bestCp: 0, approximate: false, mate: null };

  it('閾値の境界で段階が切り替わる', () => {
    expect(labelOf({ ...base, loss: 600 }, DEFAULT_THRESHOLDS)).toBe('blunder');
    expect(labelOf({ ...base, loss: 599 }, DEFAULT_THRESHOLDS)).toBe('dubious');
    expect(labelOf({ ...base, loss: 300 }, DEFAULT_THRESHOLDS)).toBe('dubious');
    expect(labelOf({ ...base, loss: 299 }, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('閾値を変えても CPL は変わらず、ラベルだけが変わる', () => {
    const analyses = [
      analysis(0, ['7g7f', 100], ['2g2f', -300]),
      analysis(1, ['3c3d', 100]),
    ];
    const loose: Thresholds = { blunder: 1000, dubious: 500, decided: 3000 };
    const l = computeMoveLosses(analyses, ['2g2f', '3c3d']).get(0)!;

    expect(l.loss).toBe(400);
    expect(labelOf(l, DEFAULT_THRESHOLDS)).toBe('dubious');
    expect(labelOf(l, loose)).toBeNull();
  });

  it('勝負が決した局面にはラベルを付けない（CPL は保持する）', () => {
    const decided = { ...base, bestCp: 3200, loss: 800 };
    expect(labelOf(decided, DEFAULT_THRESHOLDS)).toBeNull();
    expect(labelOf(decided, { ...DEFAULT_THRESHOLDS, decided: 5000 })).toBe('blunder');
    expect(labelOf({ ...base, bestCp: -3200, loss: 800 }, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('詰み系は決着閾値に関係なくラベルが付く', () => {
    const missed = {
      ...base,
      bestCp: null,
      loss: null,
      mate: { kind: 'missed' as const, moves: 3 },
    };
    expect(labelOf(missed, DEFAULT_THRESHOLDS)).toBe('mate');
  });
});

describe('labelText / formatLoss', () => {
  const base = { moveNumber: 0, bestCp: 0, approximate: false, mate: null };

  it('詰み系は手数を添える', () => {
    const missed = { ...base, loss: null, mate: { kind: 'missed' as const, moves: 5 } };
    const into = { ...base, loss: null, mate: { kind: 'into' as const, moves: 3 } };
    expect(labelText(missed, 'mate')).toBe('詰み逃し（5手詰）');
    expect(labelText(into, 'mate')).toBe('詰まされ（3手詰）');
    expect(formatLoss(missed)).toBeNull();
  });

  it('近似には ≈ を添える', () => {
    expect(formatLoss({ ...base, loss: 320 })).toBe('損失 320cp');
    expect(formatLoss({ ...base, loss: 320, approximate: true })).toBe('損失 ≈320cp');
    // 近似では実手の方が良い値になり損失が負になることがある
    expect(formatLoss({ ...base, loss: -40, approximate: true })).toBe('損失 ≈-40cp');
  });
});

describe('parseThresholds', () => {
  it('未設定・壊れた値は既定へフォールバックする', () => {
    expect(parseThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('{')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('[1,2]')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('"300"')).toEqual(DEFAULT_THRESHOLDS);
  });

  it('値ごとにフォールバックする', () => {
    expect(parseThresholds('{"blunder":500,"dubious":"x","decided":-1}')).toEqual({
      blunder: 500,
      dubious: DEFAULT_THRESHOLDS.dubious,
      decided: DEFAULT_THRESHOLDS.decided,
    });
  });

  it('値ごとのフォールバックで疑問手 > 悪手 になっても正規化する', () => {
    // blunder だけ壊れると既定に戻り、生き残った dubious 900 が上回ってしまう
    expect(parseThresholds('{"blunder":"broken","dubious":900,"decided":1000}')).toEqual({
      blunder: DEFAULT_THRESHOLDS.blunder,
      dubious: DEFAULT_THRESHOLDS.blunder,
      decided: 1000,
    });
    // 保存値そのものが不整合な場合も同じ
    expect(parseThresholds('{"blunder":200,"dubious":400,"decided":1000}')).toEqual({
      blunder: 200,
      dubious: 200,
      decided: 1000,
    });
  });

  it('正規化した閾値では悪手が先に判定される', () => {
    const t = parseThresholds('{"blunder":"broken","dubious":900,"decided":1000}');
    const loss = { moveNumber: 0, bestCp: 0, loss: 700, approximate: false, mate: null };

    expect(labelOf(loss, t)).toBe('blunder');
    expect(t.dubious).toBeLessThanOrEqual(t.blunder);
  });
});

describe('applyThresholdInput', () => {
  const base = DEFAULT_THRESHOLDS;

  it('空欄は無視する（Number("") の 0 を保存しない）', () => {
    // 値を消して打ち直す操作で「決着 0 ＝全局面が決着扱い」になってしまうため
    expect(applyThresholdInput(base, 'decided', '')).toBeNull();
    expect(applyThresholdInput(base, 'decided', '   ')).toBeNull();
    expect(applyThresholdInput(base, 'blunder', '')).toBeNull();
    expect(applyThresholdInput(base, 'dubious', '')).toBeNull();
  });

  it('数値でない・負の入力は無視する', () => {
    expect(applyThresholdInput(base, 'blunder', 'abc')).toBeNull();
    expect(applyThresholdInput(base, 'blunder', '-1')).toBeNull();
  });

  it('悪手を下げると疑問手が追従する', () => {
    expect(applyThresholdInput(base, 'blunder', '100')).toEqual({
      blunder: 100,
      dubious: 100,
      decided: 3000,
    });
    // 疑問手を上回ったままなら動かさない
    expect(applyThresholdInput(base, 'blunder', '400')).toEqual({
      blunder: 400,
      dubious: 300,
      decided: 3000,
    });
  });

  it('疑問手を上げると悪手が追従する', () => {
    expect(applyThresholdInput(base, 'dubious', '900')).toEqual({
      blunder: 900,
      dubious: 900,
      decided: 3000,
    });
  });

  it('決着は他の閾値に影響しない', () => {
    expect(applyThresholdInput(base, 'decided', '2000')).toEqual({
      blunder: 600,
      dubious: 300,
      decided: 2000,
    });
  });
});
