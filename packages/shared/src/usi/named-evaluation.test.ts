import { describe, expect, it } from 'vitest';
import { BROWSER_ANALYSIS_LIMITS, drillNamedEvaluationSchema } from '../analysis-limits';
import {
  namedEvaluationOf,
  namedGoCommand,
  sfenPositionCommand,
  withAllLegalMoves,
} from './named-evaluation';
import { parseInfoLine } from './parser';
import type { UsiSearchResult } from './types';

const result = (lines: string[], bestmove: string): UsiSearchResult => {
  const infoLines = lines.map(parseInfoLine);
  return { bestmove: { move: bestmove }, infoLines, lastInfo: infoLines.at(-1) ?? {} };
};

const provenance = {
  engineBuild: 'c1b80eaa-0123456789ab',
  evalHash: 'a'.repeat(64),
  engineName: 'YaneuraOu',
  fvScale: 16,
  threads: 4,
  hashMb: 64,
  movetimeMs: 600,
};

describe('USI のコマンド', () => {
  it('3 フィールドの SFEN には手数を補う', () => {
    expect(sfenPositionCommand('lnsgkgsnl/9/9/9/9/9/9/9/LNSGKGSNL b -')).toBe(
      'position sfen lnsgkgsnl/9/9/9/9/9/9/9/LNSGKGSNL b - 1',
    );
    expect(sfenPositionCommand('lnsgkgsnl/9/9/9/9/9/9/9/LNSGKGSNL b - 5')).toBe(
      'position sfen lnsgkgsnl/9/9/9/9/9/9/9/LNSGKGSNL b - 5',
    );
  });

  it('searchmoves は最後に置く（後ろの語はすべて手として読まれる）', () => {
    expect(namedGoCommand(600, '7g7f')).toBe('go movetime 600 searchmoves 7g7f');
  });
});

describe('namedEvaluationOf', () => {
  it('名指しした手の評価を取り出す（最後の行を採る）', () => {
    const out = namedEvaluationOf(
      result(
        [
          'info depth 5 score cp 20 pv 7g7f 3c3d',
          'info depth 9 score cp -35 pv 7g7f 8c8d 2g2f',
        ],
        '7g7f',
      ),
      '7g7f',
    );
    expect(out).toEqual({
      kind: 'ok',
      candidate: { scoreType: 'cp', scoreValue: -35, depth: 9, pv: ['7g7f', '8c8d', '2g2f'] },
    });
  });

  it('詰みの評価も取り出す', () => {
    const out = namedEvaluationOf(result(['info depth 3 score mate 3 pv G*5b 5a4a 5b4b'], 'G*5b'), 'G*5b');
    expect(out).toMatchObject({ kind: 'ok', candidate: { scoreType: 'mate', scoreValue: 3 } });
  });

  it('名指しが効かずに別の手が返ったら mismatch（数字を作らない）', () => {
    const out = namedEvaluationOf(result(['info depth 9 score cp 50 pv 2g2f 8c8d'], '2g2f'), '7g7f');
    expect(out).toEqual({ kind: 'mismatch', returned: '2g2f' });
  });

  it('評価を出さずに名指しした手を指したら候補なし', () => {
    expect(namedEvaluationOf(result([], '7g7f'), '7g7f')).toEqual({ kind: 'ok', candidate: null });
  });

  it('評価を出さずに別の手（resign など）を指したら mismatch', () => {
    expect(namedEvaluationOf(result([], 'resign'), '7g7f')).toEqual({ kind: 'mismatch', returned: 'resign' });
  });

  it('長い読み筋は上限で切り、server の検証を通る形にする', () => {
    const pv = ['7g7f', ...Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? '8c8d' : '8d8c'))];
    const out = namedEvaluationOf(result([`info depth 30 score cp 10 pv ${pv.join(' ')}`], '7g7f'), '7g7f');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok' || !out.candidate) throw new Error('unreachable');
    expect(out.candidate.pv).toHaveLength(BROWSER_ANALYSIS_LIMITS.pvMaxPlies);
    expect(
      drillNamedEvaluationSchema.safeParse({ move: '7g7f', candidate: out.candidate, ...provenance }).success,
    ).toBe(true);
  });
});

describe('drillNamedEvaluationSchema（解答に付ける名指し評価）', () => {
  const body = (override: Record<string, unknown> = {}) => ({
    move: '7g7f',
    candidate: { scoreType: 'cp', scoreValue: -30, depth: 12, pv: ['7g7f', '3c3d'] },
    ...provenance,
    ...override,
  });

  it('形の合う評価・候補なしを受ける', () => {
    expect(drillNamedEvaluationSchema.safeParse(body()).success).toBe(true);
    expect(drillNamedEvaluationSchema.safeParse(body({ candidate: null })).success).toBe(true);
  });

  it('読み筋の先頭が名指しした手でなければ拒む（別の手の評価で採点させない）', () => {
    expect(
      drillNamedEvaluationSchema.safeParse(
        body({ candidate: { scoreType: 'cp', scoreValue: 0, depth: 1, pv: ['2g2f'] } }),
      ).success,
    ).toBe(false);
  });

  it('上限を超える値・USI の手でない手を拒む', () => {
    const bad = [
      body({ move: 'resign' }),
      body({ move: '7g7z' }),
      body({ candidate: { scoreType: 'cp', scoreValue: 1_000_001, depth: 1, pv: ['7g7f'] } }),
      body({ candidate: { scoreType: 'cp', scoreValue: 1.5, depth: 1, pv: ['7g7f'] } }),
      body({ candidate: { scoreType: 'cp', scoreValue: 0, depth: 256, pv: ['7g7f'] } }),
      body({ candidate: { scoreType: 'cp', scoreValue: 0, depth: 1, pv: [] } }),
      body({ candidate: { scoreType: 'cp', scoreValue: 0, depth: 1, pv: ['7g7f', 'x'] } }),
      body({
        candidate: { scoreType: 'cp', scoreValue: 0, depth: 1, pv: Array.from({ length: 129 }, () => '7g7f') },
      }),
      body({ evalHash: 'zz' }),
      body({ movetimeMs: 0 }),
    ];
    for (const value of bad) expect(drillNamedEvaluationSchema.safeParse(value).success).toBe(false);
  });
});

describe('withAllLegalMoves（不成の手を読むため。prd/12 §2.2）', () => {
  const recorder = () => {
    const sent: string[] = [];
    return { sent, engine: { setOption: (name: string, value: string) => sent.push(`${name}=${value}`) } };
  };

  it('読みの間だけ有効にし、終わったら戻す', async () => {
    const { sent, engine } = recorder();
    const value = await withAllLegalMoves(engine, async () => {
      sent.push('(go)');
      return 1;
    });
    expect(value).toBe(1);
    expect(sent).toEqual(['GenerateAllLegalMoves=true', '(go)', 'GenerateAllLegalMoves=false']);
  });

  it('読みが投げても戻す（元のエラーを伝える）', async () => {
    const { sent, engine } = recorder();
    await expect(
      withAllLegalMoves(engine, async () => {
        throw new Error('dead');
      }),
    ).rejects.toThrow('dead');
    expect(sent.at(-1)).toBe('GenerateAllLegalMoves=false');
  });

  it('戻す送信が投げても（エンジンが死んでいる）読みのエラーのほうを伝える', async () => {
    let calls = 0;
    const engine = {
      setOption: () => {
        if (++calls > 1) throw new Error('not running');
      },
    };
    await expect(
      withAllLegalMoves(engine, async () => {
        throw new Error('dead');
      }),
    ).rejects.toThrow('dead');
  });
});
