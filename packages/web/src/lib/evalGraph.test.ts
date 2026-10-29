import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type MoveLoss } from 'shared';
import { evalMarkersOf, evalPointsOf } from './evalGraph';

const cp = (moveNumber: number, scoreValue: number) => ({
  moveNumber,
  candidates: [{ rank: 1, scoreType: 'cp', scoreValue }],
});

const loss = (moveNumber: number, value: number | null, mate: MoveLoss['mate'] = null): MoveLoss => ({
  moveNumber,
  loss: value,
  approximate: false,
  mate,
});

describe('evalPointsOf', () => {
  it('手数の順に並べ、後手番の局面は符号を反転して先手視点にする', () => {
    expect(evalPointsOf([cp(1, 100), cp(0, 50)])).toEqual([
      { moveNumber: 0, value: 50 },
      { moveNumber: 1, value: -100 },
    ]);
  });

  it('候補手の無い局面は飛ばし、±3000 にクランプする（詰みは端に張り付く）', () => {
    expect(
      evalPointsOf([
        { moveNumber: 0, candidates: [] },
        cp(2, 9999),
        { moveNumber: 4, candidates: [{ rank: 1, scoreType: 'mate', scoreValue: -3 }] },
      ]),
    ).toEqual([
      { moveNumber: 2, value: 3000 },
      { moveNumber: 4, value: -3000 },
    ]);
  });
});

describe('evalMarkersOf', () => {
  const points = evalPointsOf([cp(0, 0), cp(1, 0), cp(2, 0), cp(3, 0)]);

  it('悪手と詰み系だけを拾い、疑問手は出さない', () => {
    const markers = evalMarkersOf(
      points,
      [loss(0, 700), loss(1, 400), loss(2, null, { kind: 'missed', moves: 5 })],
      DEFAULT_THRESHOLDS,
      null,
    );
    expect(markers.map((m) => [m.loss.moveNumber, m.label])).toEqual([
      [0, 'blunder'],
      [2, 'mate'],
    ]);
  });

  it('実手後の局面に置き、無ければ指す前の局面に置く（詰みで終わった棋譜の最終手）', () => {
    const markers = evalMarkersOf(points, [loss(1, 700), loss(3, 700)], DEFAULT_THRESHOLDS, null);
    expect(markers.map((m) => m.point.moveNumber)).toEqual([2, 3]);
  });

  it('点が無ければ置かない', () => {
    expect(evalMarkersOf(points, [loss(10, 700)], DEFAULT_THRESHOLDS, null)).toEqual([]);
  });

  it('先後と自分の手かを付ける（主体側が決まらなければ全部自分の手）', () => {
    const losses = [loss(0, 700), loss(1, 700)];
    expect(
      evalMarkersOf(points, losses, DEFAULT_THRESHOLDS, 'gote').map((m) => [m.isSenteMove, m.isUserMove]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(
      evalMarkersOf(points, losses, DEFAULT_THRESHOLDS, null).every((m) => m.isUserMove),
    ).toBe(true);
  });
});
