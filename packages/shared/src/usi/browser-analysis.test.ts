import { describe, expect, it } from 'vitest';
import {
  BROWSER_ANALYSIS_LIMITS,
  browserAnalysisChunkSchema,
} from '../analysis-limits';
import {
  analyzeKifuForBrowser,
  toBrowserReportAnalyses,
  toBrowserReportCandidate,
  type BrowserAnalysisRun,
  type BrowserReportAnalyses,
} from './browser-analysis';
import type { UsiAnalysisEngine, UsiCandidate } from './kifu-analysis';
import type { UsiInfo, UsiSearchResult } from './types';

const candidate = (over: Partial<UsiCandidate> = {}): UsiCandidate => ({
  rank: 1,
  move: '7g7f',
  score: { type: 'cp', value: 42 },
  pv: ['7g7f', '3c3d'],
  depth: 12,
  ...over,
});

/** 報告の本文に入れて、server と同じ zod を通るか */
function passesSchema(analyses: BrowserReportAnalyses): boolean {
  return browserAnalysisChunkSchema.safeParse({
    revision: 1,
    engineBuild: 'abc123-def456',
    evalHash: 'a'.repeat(64),
    fvScale: 16,
    threads: 4,
    hashMb: 64,
    movetimeMs: 300,
    analyses,
  }).success;
}

describe('toBrowserReportCandidate', () => {
  it('候補手を報告の形にする', () => {
    expect(toBrowserReportCandidate(candidate())).toEqual({
      rank: 1,
      move: '7g7f',
      scoreType: 'cp',
      scoreValue: 42,
      depth: 12,
      pv: ['7g7f', '3c3d'],
    });
  });

  it('読み筋を上限の長さで切る（指定が server の上限より大きくても、上限は超えない）', () => {
    const pv = Array.from({ length: 200 }, () => '7g7f');

    expect(toBrowserReportCandidate(candidate({ pv }), 10)?.pv).toHaveLength(
      10,
    );
    expect(toBrowserReportCandidate(candidate({ pv }))?.pv).toHaveLength(
      BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
    );
    expect(
      toBrowserReportCandidate(candidate({ pv }), 10_000)?.pv,
    ).toHaveLength(BROWSER_ANALYSIS_LIMITS.pvMaxPlies);
  });

  it('詰みの値と resign はそのまま送る（詰みの分類が読む）', () => {
    const mated = candidate({
      move: 'resign',
      score: { type: 'mate', value: 0 },
      pv: ['resign'],
      depth: 0,
    });

    expect(toBrowserReportCandidate(mated)).toEqual({
      rank: 1,
      move: 'resign',
      scoreType: 'mate',
      scoreValue: 0,
      depth: 0,
      pv: ['resign'],
    });
  });

  it('読み筋が空なら move は空文字のまま送る', () => {
    const result = toBrowserReportCandidate(candidate({ move: '', pv: [] }));
    expect(result).toMatchObject({ move: '', pv: [] });
    expect(passesSchema([{ moveNumber: 0, candidates: [result!] }])).toBe(true);
  });

  it('受けてもらえない語が出たら、読み筋はその手前までにする', () => {
    const result = toBrowserReportCandidate(
      candidate({ pv: ['7g7f', '3c3d', '(none)', '2g2f'] }),
    );
    expect(result?.pv).toEqual(['7g7f', '3c3d']);
  });

  it('深さと評価値を上限に収める', () => {
    const result = toBrowserReportCandidate(
      candidate({ score: { type: 'cp', value: -9_999_999 }, depth: 300 }),
    );
    expect(result).toMatchObject({
      scoreValue: -BROWSER_ANALYSIS_LIMITS.maxScoreAbs,
      depth: BROWSER_ANALYSIS_LIMITS.maxDepth,
    });
  });

  it('評価値が数として読めなかった候補は送らない', () => {
    expect(
      toBrowserReportCandidate(
        candidate({ score: { type: 'mate', value: NaN } }),
      ),
    ).toBeNull();
  });
});

describe('toBrowserReportAnalyses', () => {
  it('最善手だけを残し、探索の結果が無い局面は候補なしで送る', () => {
    const analyses = toBrowserReportAnalyses([
      {
        moveNumber: 0,
        candidates: [candidate(), candidate({ rank: 2, move: '2g2f' })],
      },
      { moveNumber: 1, candidates: [] },
    ]);

    expect(analyses).toEqual([
      {
        moveNumber: 0,
        candidates: [
          {
            rank: 1,
            move: '7g7f',
            scoreType: 'cp',
            scoreValue: 42,
            depth: 12,
            pv: ['7g7f', '3c3d'],
          },
        ],
      },
      { moveNumber: 1, candidates: [] },
    ]);
    expect(passesSchema(analyses)).toBe(true);
  });
});

/** 局面ごとに決まった info 行を返すエンジン */
function createEngine(infoOf: (position: string) => UsiInfo[]) {
  const commands: string[] = [];
  const engine: UsiAnalysisEngine = {
    setOption: (name, value) => {
      commands.push(`setoption ${name} ${value}`);
    },
    analyze: async (position, goCommand): Promise<UsiSearchResult> => {
      commands.push(position, goCommand);
      const infoLines = infoOf(position);
      return {
        bestmove: { move: infoLines.at(-1)?.pv?.[0] ?? 'resign' },
        infoLines,
        lastInfo: infoLines.at(-1) ?? {},
      };
    },
  };
  return { engine, commands };
}

const run = (over: Partial<BrowserAnalysisRun> = {}): BrowserAnalysisRun => ({
  revision: 3,
  startMoveNumber: 0,
  usiMoves: ['7g7f', '3c3d', '2g2f', '8c8d'],
  settings: {
    movetimeMs: 300,
    multiPv: 1,
    hashMb: 64,
    maxThreads: 8,
    chunkIntervalMs: 60_000,
    chunkMaxPositions: 2,
    pvMaxPlies: 3,
  },
  ...over,
});

const longLine: UsiInfo = {
  multipv: 1,
  depth: 9,
  score: { type: 'cp', value: 15 },
  pv: ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e'],
};

describe('analyzeKifuForBrowser', () => {
  it('開始の口の設定で解析し、検証を通る形のチャンクを局面数の上限ごとに渡す', async () => {
    const { engine, commands } = createEngine(() => [longLine]);
    const chunks: BrowserReportAnalyses[] = [];
    const progress: [number, number][] = [];

    const summary = await analyzeKifuForBrowser(engine, run(), {
      onChunk: async (analyses) => {
        chunks.push(analyses);
      },
      onProgress: (analyzed, total) => progress.push([analyzed, total]),
    });

    expect(summary).toMatchObject({
      totalMoves: 4,
      analyzed: 5,
      interrupted: false,
    });
    expect(chunks.map((c) => c.map((a) => a.moveNumber))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    // 読み筋は設定の長さ（3 手）で切ってある
    expect(chunks[0][0].candidates).toEqual([
      {
        rank: 1,
        move: '7g7f',
        scoreType: 'cp',
        scoreValue: 15,
        depth: 9,
        pv: ['7g7f', '3c3d', '2g2f'],
      },
    ]);
    for (const chunk of chunks) expect(passesSchema(chunk)).toBe(true);
    expect(progress.at(-1)).toEqual([5, 5]);
    // MultiPV と思考時間は設定どおり
    expect(commands.slice(0, 3)).toEqual([
      'setoption MultiPV 1',
      'position startpos',
      'go movetime 300',
    ]);
  });

  it('再開位置から始め、空のチャンクは渡さない', async () => {
    const { engine } = createEngine(() => [longLine]);
    const chunks: BrowserReportAnalyses[] = [];

    // 残りは 2 局面で、局面数の上限ちょうど。最後の空のチャンクは報告しない
    await analyzeKifuForBrowser(engine, run({ startMoveNumber: 3 }), {
      onChunk: async (analyses) => {
        chunks.push(analyses);
      },
    });

    expect(chunks.map((c) => c.map((a) => a.moveNumber))).toEqual([[3, 4]]);
  });

  it('詰みで終わる棋譜の最後の局面（info 行なし）は、候補なしで送る', async () => {
    const { engine } = createEngine((position) =>
      position.endsWith('8c8d') ? [] : [longLine],
    );
    const chunks: BrowserReportAnalyses[] = [];

    await analyzeKifuForBrowser(engine, run(), {
      onChunk: async (analyses) => {
        chunks.push(analyses);
      },
    });

    expect(chunks.at(-1)).toEqual([{ moveNumber: 4, candidates: [] }]);
    expect(passesSchema(chunks.at(-1)!)).toBe(true);
  });

  it('報告が投げたら解析を中断する', async () => {
    const { engine, commands } = createEngine(() => [longLine]);

    await expect(
      analyzeKifuForBrowser(engine, run(), {
        onChunk: async () => {
          throw new Error('503');
        },
      }),
    ).rejects.toThrow('503');
    // 最初のチャンク（2 局面）で止まる
    expect(commands.filter((c) => c.startsWith('go '))).toHaveLength(2);
  });

  it('局面の境目で中断を求めると、未送信のチャンクを渡してから抜ける', async () => {
    const { engine } = createEngine(() => [longLine]);
    const chunks: BrowserReportAnalyses[] = [];
    let boundary = 0;

    const summary = await analyzeKifuForBrowser(engine, run(), {
      onChunk: async (analyses) => {
        chunks.push(analyses);
      },
      onPositionBoundary: async () => ++boundary === 2,
    });

    expect(summary).toMatchObject({ analyzed: 1, interrupted: true });
    expect(chunks.map((c) => c.map((a) => a.moveNumber))).toEqual([[0]]);
  });
});
