import { describe, expect, it } from 'vitest';
import { reuseFromKifu, type KifuPositionMatch } from './position-kifu-reuse.js';
import type { EvalCandidate } from './position-eval.js';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -';

const ANALYZED_AT = new Date('2026-08-01T00:00:00.000Z');

function candidate(
  rank: number,
  move: string,
  scoreValue: number,
  extra: Partial<EvalCandidate> = {},
): EvalCandidate {
  return {
    rank,
    move,
    scoreType: 'cp',
    scoreValue,
    pv: [move],
    depth: 20,
    ...extra,
  };
}

/** 一致した棋譜局面 1 件。指定しない項目は「未解析・最終局面」に寄せる */
function match(over: Partial<KifuPositionMatch> = {}): KifuPositionMatch {
  return {
    kifuId: 1,
    moveNumber: 10,
    candidates: [],
    analyzedAt: null,
    playedMove: null,
    nextCandidates: [],
    nextAnalyzedAt: null,
    ...over,
  };
}

describe('reuseFromKifu（局面評価）', () => {
  const three = [
    candidate(1, '7g7f', 50),
    candidate(2, '2g2f', 30),
    candidate(3, '5i5h', 10),
  ];

  it('候補手が 3 本揃っていれば再利用する', () => {
    const outcome = reuseFromKifu(
      { sfen: SFEN, move: null },
      [match({ candidates: three, analyzedAt: ANALYZED_AT })],
    );
    expect(outcome).toEqual({
      status: 'done',
      source: 'kifu',
      candidates: three,
      fallback: false,
      evaluatedAt: ANALYZED_AT.toISOString(),
    });
  });

  it('🔴 3 本に満たない解析は再利用しない（3 本は API の契約）', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: null }, [
      match({ candidates: three.slice(0, 2), analyzedAt: ANALYZED_AT }),
    ]);
    expect(outcome).toBeNull();
  });

  it('ENGINE_MULTIPV が 3 より多い解析でも、返すのは先頭 3 本', () => {
    const five = [...three, candidate(4, '3i4h', 5), candidate(5, '9g9f', -20)];
    const outcome = reuseFromKifu({ sfen: SFEN, move: null }, [
      match({ candidates: five, analyzedAt: ANALYZED_AT }),
    ]);
    expect(outcome?.candidates).toEqual(three);
  });

  it('未解析の局面はエンジンへ回す', () => {
    expect(reuseFromKifu({ sfen: SFEN, move: null }, [match()])).toBeNull();
  });

  it('一致する棋譜局面が無ければエンジンへ回す', () => {
    expect(reuseFromKifu({ sfen: SFEN, move: null }, [])).toBeNull();
  });

  it('複数の棋譜が一致したら、3 本揃っている中で解析が新しいものを採る', () => {
    const older = [candidate(1, '7g7f', 10), candidate(2, '2g2f', 5), candidate(3, '6i7h', 0)];
    const newer = [candidate(1, '2g2f', 80), candidate(2, '7g7f', 70), candidate(3, '5i5h', 60)];
    const outcome = reuseFromKifu({ sfen: SFEN, move: null }, [
      match({ kifuId: 1, candidates: older, analyzedAt: ANALYZED_AT }),
      match({
        kifuId: 2,
        candidates: newer,
        analyzedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ]);
    expect(outcome?.candidates).toEqual(newer);
    expect(outcome?.evaluatedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('新しい方が 3 本に満たなければ、揃っている古い方を採る', () => {
    const older = [candidate(1, '7g7f', 10), candidate(2, '2g2f', 5), candidate(3, '6i7h', 0)];
    const outcome = reuseFromKifu({ sfen: SFEN, move: null }, [
      match({ kifuId: 1, candidates: older, analyzedAt: ANALYZED_AT }),
      match({
        kifuId: 2,
        candidates: [candidate(1, '2g2f', 80)],
        analyzedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ]);
    expect(outcome?.candidates).toEqual(older);
  });
});

describe('reuseFromKifu（名指し評価）', () => {
  it('候補手に入っていれば 1 本だけ返す（3 本揃っている必要はない）', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '2g2f' }, [
      match({
        candidates: [
          candidate(1, '7g7f', 50),
          candidate(2, '2g2f', 30, { pv: ['2g2f', '3c3d'], depth: 18 }),
        ],
        analyzedAt: ANALYZED_AT,
      }),
    ]);
    expect(outcome).toEqual({
      status: 'done',
      source: 'kifu',
      candidates: [
        {
          // 名指し評価が返すのはその手 1 本なので rank は 1 に揃える
          rank: 1,
          move: '2g2f',
          scoreType: 'cp',
          scoreValue: 30,
          pv: ['2g2f', '3c3d'],
          depth: 18,
        },
      ],
      fallback: false,
      evaluatedAt: ANALYZED_AT.toISOString(),
    });
  });

  it('候補手が 1 本しか無くても、その手ならば再利用する', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '7g7f' }, [
      match({ candidates: [candidate(1, '7g7f', 50)], analyzedAt: ANALYZED_AT }),
    ]);
    expect(outcome?.candidates).toHaveLength(1);
    expect(outcome?.fallback).toBe(false);
  });

  it('実手は次の局面の評価から引き、符号を反転する', () => {
    const nextAt = new Date('2026-08-05T00:00:00.000Z');
    const outcome = reuseFromKifu({ sfen: SFEN, move: '9g9f' }, [
      match({
        // 候補手 3 本のどれでもない実手
        candidates: [candidate(1, '7g7f', 50), candidate(2, '2g2f', 30)],
        analyzedAt: ANALYZED_AT,
        playedMove: '9g9f',
        nextCandidates: [
          candidate(1, '3c3d', 120, { pv: ['3c3d', '2f2e'], depth: 22 }),
        ],
        nextAnalyzedAt: nextAt,
      }),
    ]);
    expect(outcome).toEqual({
      status: 'done',
      source: 'kifu',
      candidates: [
        {
          rank: 1,
          move: '9g9f',
          scoreType: 'cp',
          // 次局面は相手番なので、手番側視点に戻すため符号を反転する（prd/12 §2.3）
          scoreValue: -120,
          // 読み筋の先頭に名指しした手を足す（worker のフォールバックと同じ形）
          pv: ['9g9f', '3c3d', '2f2e'],
          depth: 22,
        },
      ],
      // 「手を適用した局面を評価して符号反転」で求めた値であることを隠さない
      fallback: true,
      evaluatedAt: nextAt.toISOString(),
    });
  });

  it('mate も符号を反転する', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '9g9f' }, [
      match({
        playedMove: '9g9f',
        nextCandidates: [
          candidate(1, '3c3d', 3, { scoreType: 'mate', pv: ['3c3d'] }),
        ],
        nextAnalyzedAt: ANALYZED_AT,
      }),
    ]);
    expect(outcome?.candidates[0]).toMatchObject({
      scoreType: 'mate',
      scoreValue: -3,
    });
  });

  it('候補手にあるなら、実手からの符号反転より候補手を優先する', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '7g7f' }, [
      match({
        candidates: [candidate(1, '7g7f', 50, { pv: ['7g7f', '3c3d'] })],
        analyzedAt: ANALYZED_AT,
        playedMove: '7g7f',
        nextCandidates: [candidate(1, '3c3d', 999)],
        nextAnalyzedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ]);
    expect(outcome?.fallback).toBe(false);
    expect(outcome?.candidates[0].scoreValue).toBe(50);
  });

  it('候補手にも実手にも無い手はエンジンへ回す', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '9i9h' }, [
      match({
        candidates: [candidate(1, '7g7f', 50), candidate(2, '2g2f', 30)],
        analyzedAt: ANALYZED_AT,
        playedMove: '2g2f',
        nextCandidates: [candidate(1, '3c3d', 20)],
        nextAnalyzedAt: ANALYZED_AT,
      }),
    ]);
    expect(outcome).toBeNull();
  });

  it('実手が一致しても次局面が未解析ならエンジンへ回す', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: '9g9f' }, [
      match({ playedMove: '9g9f', nextCandidates: [] }),
    ]);
    expect(outcome).toBeNull();
  });

  it('一致する棋譜局面が無ければエンジンへ回す', () => {
    expect(reuseFromKifu({ sfen: SFEN, move: '7g7f' }, [])).toBeNull();
  });
});

describe('source', () => {
  it('棋譜から引いた結果は必ず source: kifu を持つ', () => {
    const outcome = reuseFromKifu({ sfen: SFEN, move: null }, [
      match({
        candidates: [
          candidate(1, '7g7f', 50),
          candidate(2, '2g2f', 30),
          candidate(3, '5i5h', 10),
        ],
        analyzedAt: ANALYZED_AT,
      }),
    ]);
    expect(outcome?.source).toBe('kifu');
  });

  // `source: 'engine'` は「再利用できなかった」ときに route が付ける。
  // ここが null を返すことが、その分岐に入る条件そのもの
  it('再利用できないときは null を返す（route はエンジンへ回して source: engine を付ける）', () => {
    expect(reuseFromKifu({ sfen: SFEN, move: null }, [match()])).toBeNull();
  });
});
