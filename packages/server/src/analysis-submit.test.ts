import { describe, expect, it } from 'vitest';
import {
  isAnalysisComplete,
  isChunkAcceptable,
  isChunkInRange,
  resolveExistingMoveAnalyses,
} from './analysis-submit.js';

describe('isChunkAcceptable', () => {
  it('同一世代 かつ 失敗記録なし なら受理する', () => {
    expect(isChunkAcceptable({ revision: 3, error: null }, 3)).toBe(true);
  });

  it('世代が進んでいたら破棄する（reanalyze 後に届いた旧解析のチャンク）', () => {
    expect(isChunkAcceptable({ revision: 4, error: null }, 3)).toBe(false);
  });

  it('取得時より世代が古い（ありえない）ケースも破棄する', () => {
    expect(isChunkAcceptable({ revision: 2, error: null }, 3)).toBe(false);
  });

  it('失敗が記録済みなら破棄する（completedAt と analysisError を排他に保つ）', () => {
    expect(
      isChunkAcceptable({ revision: 3, error: 'illegal move at move 57' }, 3),
    ).toBe(false);
  });

  it('棋譜が消えていたら破棄する', () => {
    expect(isChunkAcceptable(undefined, 3)).toBe(false);
  });
});

describe('isChunkInRange', () => {
  const usiMoves = ['7g7f', '3c3d', '2g2f'];

  it('初期局面（0）から最終局面（usiMoves.length）までは受理する', () => {
    expect(
      isChunkInRange([{ moveNumber: 0 }, { moveNumber: 3 }], usiMoves),
    ).toBe(true);
  });

  it('棋譜の手数を超える moveNumber は拒否する（欠番のまま件数だけ達するのを防ぐ）', () => {
    expect(
      isChunkInRange([{ moveNumber: 0 }, { moveNumber: 99 }], usiMoves),
    ).toBe(false);
  });

  it('負の moveNumber は拒否する', () => {
    expect(isChunkInRange([{ moveNumber: -1 }], usiMoves)).toBe(false);
  });

  it('整数でない moveNumber は拒否する', () => {
    expect(isChunkInRange([{ moveNumber: 1.5 }], usiMoves)).toBe(false);
  });

  it('空チャンクは受理する（完了確定のために送る最終チャンク）', () => {
    expect(isChunkInRange([], usiMoves)).toBe(true);
    expect(isChunkInRange([], null)).toBe(true);
  });

  it('usiMoves が無い棋譜への書き込みは拒否する', () => {
    expect(isChunkInRange([{ moveNumber: 0 }], null)).toBe(false);
  });
});

describe('isAnalysisComplete', () => {
  it('全局面（usiMoves.length + 1）が揃ったら完了', () => {
    expect(isAnalysisComplete(4, ['7g7f', '3c3d', '2g2f'])).toBe(true);
  });

  it('1 局面でも欠けていれば未完了（初期局面の分を数え落とさない）', () => {
    expect(isAnalysisComplete(3, ['7g7f', '3c3d', '2g2f'])).toBe(false);
  });

  it('チャンクの途中では未完了', () => {
    expect(isAnalysisComplete(0, ['7g7f', '3c3d', '2g2f'])).toBe(false);
    expect(isAnalysisComplete(1, ['7g7f', '3c3d', '2g2f'])).toBe(false);
  });

  it('件数が全局面数を超えていても完了とみなす', () => {
    expect(isAnalysisComplete(5, ['7g7f', '3c3d', '2g2f'])).toBe(true);
  });

  it('usiMoves が無い棋譜は完了にしない', () => {
    expect(isAnalysisComplete(1, null)).toBe(false);
  });
});

describe('resolveExistingMoveAnalyses', () => {
  it('既存が無ければすべて新規挿入になる', () => {
    const resolved = resolveExistingMoveAnalyses(
      [{ moveNumber: 0 }, { moveNumber: 1 }],
      [],
    );
    expect(resolved).toEqual([
      { analysis: { moveNumber: 0 }, existingId: null },
      { analysis: { moveNumber: 1 }, existingId: null },
    ]);
  });

  it('同一 moveNumber の再送は既存行を使い回す（行が二重に増えない）', () => {
    const resolved = resolveExistingMoveAnalyses(
      [{ moveNumber: 5 }, { moveNumber: 6 }],
      [
        { id: 105, moveNumber: 5 },
        { id: 106, moveNumber: 6 },
      ],
    );
    expect(resolved.map((r) => r.existingId)).toEqual([105, 106]);
  });

  it('チャンクが既存とまたがっていても局面ごとに振り分ける', () => {
    const resolved = resolveExistingMoveAnalyses(
      [{ moveNumber: 5 }, { moveNumber: 6 }, { moveNumber: 7 }],
      [{ id: 105, moveNumber: 5 }],
    );
    expect(resolved.map((r) => r.existingId)).toEqual([105, null, null]);
  });

  it('チャンクに無い既存 moveNumber は無視する（他チャンクの行を触らない）', () => {
    const resolved = resolveExistingMoveAnalyses(
      [{ moveNumber: 7 }],
      [
        { id: 105, moveNumber: 5 },
        { id: 106, moveNumber: 6 },
      ],
    );
    expect(resolved).toEqual([
      { analysis: { moveNumber: 7 }, existingId: null },
    ]);
  });

  it('空チャンク（最終チャンクが空のケース）は空を返す', () => {
    expect(
      resolveExistingMoveAnalyses([], [{ id: 105, moveNumber: 5 }]),
    ).toEqual([]);
  });
});
