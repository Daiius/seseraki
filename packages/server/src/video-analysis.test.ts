import { describe, expect, it } from 'vitest';
import {
  diffUsiMoves,
  formatDiff,
  videoKifuInputSchema,
  videoKifuTitle,
} from './video-analysis';

describe('diffUsiMoves', () => {
  it('同じ指し手列なら差分なし（再取り込みは冪等）', () => {
    expect(diffUsiMoves(['7g7f', '3c3d'], ['7g7f', '3c3d'])).toEqual([]);
  });

  it('成/不成の違いを拾う（通し再生では見つからない種類の変化）', () => {
    const before = ['7g7f', '3c3d', '3d3c'];
    const after = ['7g7f', '3c3d', '3d3c+'];
    expect(diffUsiMoves(before, after)).toEqual([
      { moveNumber: 3, before: '3d3c', after: '3d3c+' },
    ]);
  });

  it('手数が増えたぶんは before が null', () => {
    expect(diffUsiMoves(['7g7f'], ['7g7f', '3c3d'])).toEqual([
      { moveNumber: 2, before: null, after: '3c3d' },
    ]);
  });

  it('手数が減ったぶんは after が null', () => {
    expect(diffUsiMoves(['7g7f', '3c3d'], ['7g7f'])).toEqual([
      { moveNumber: 2, before: '3c3d', after: null },
    ]);
  });

  it('途中で 1 手ずれると以降が全部差分になる（総崩れが総崩れとして見える）', () => {
    const before = ['7g7f', '3c3d', '2g2f', '8c8d'];
    const after = ['7g7f', '2g2f', '3c3d', '8c8d'];
    expect(diffUsiMoves(before, after)).toHaveLength(2);
  });

  it('旧棋譜が空（usiMoves が null だった）でも差分として出る', () => {
    expect(diffUsiMoves([], ['7g7f'])).toEqual([
      { moveNumber: 1, before: null, after: '7g7f' },
    ]);
  });
});

describe('formatDiff', () => {
  it('差分を 1 行にまとめる', () => {
    const line = formatDiff([
      { moveNumber: 3, before: '3d3c', after: '3d3c+' },
      { moveNumber: 9, before: null, after: 'P*3e' },
    ]);
    expect(line).toBe('3: 3d3c → 3d3c+ / 9: (なし) → P*3e');
  });

  it('総崩れのときは先頭だけ出して残りは件数にする', () => {
    const diffs = Array.from({ length: 25 }, (_, i) => ({
      moveNumber: i + 1,
      before: '7g7f',
      after: '2g2f',
    }));
    const line = formatDiff(diffs, 3);
    expect(line).toContain('ほか 22 件');
    expect(line.split(' / ')).toHaveLength(3);
  });
});

describe('videoKifuTitle', () => {
  it('対局者名が無いので動画と局番号で識別する', () => {
    expect(
      videoKifuTitle({
        videoId: 'abc123',
        gameIndex: 2,
        startedAtSec: 0,
        endedAtSec: 100,
        bottomIsSente: true,
        extractorRev: 'deadbeef',
        usi: ['7g7f'],
        raw: {},
      }),
    ).toBe('動画 abc123 第 2 局');
  });
});

describe('videoKifuInputSchema', () => {
  const valid = {
    videoId: 'abc123',
    gameIndex: 1,
    startedAtSec: 4,
    endedAtSec: 1140,
    bottomIsSente: false,
    extractorRev: '4945580',
    usi: ['7g7f', '3c3d', '8h2b+', 'P*3e'],
    raw: { source: 'x.mp4', runs: [] },
  };

  it('走査結果の形をそのまま受ける', () => {
    expect(videoKifuInputSchema.parse(valid)).toEqual(valid);
  });

  it('局番号は 1 始まり', () => {
    expect(videoKifuInputSchema.safeParse({ ...valid, gameIndex: 0 }).success).toBe(
      false,
    );
  });

  it('指し手が 1 つも無い棋譜は受けない', () => {
    expect(videoKifuInputSchema.safeParse({ ...valid, usi: [] }).success).toBe(false);
  });

  it('USI として長すぎる文字列は弾く', () => {
    expect(
      videoKifuInputSchema.safeParse({ ...valid, usi: ['7g7f', '７六歩(77)'] }).success,
    ).toBe(false);
  });

  it('動画 ID は列の長さ（32）に収まる', () => {
    expect(
      videoKifuInputSchema.safeParse({ ...valid, videoId: 'a'.repeat(33) }).success,
    ).toBe(false);
  });

  it('区間が逆転していたら弾く（個々の値が非負なだけでは通ってしまう）', () => {
    const result = videoKifuInputSchema.safeParse({
      ...valid,
      startedAtSec: 1140,
      endedAtSec: 4,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['endedAtSec']);
  });

  it('区間の長さ 0（1 手で終わった局）は通す', () => {
    expect(
      videoKifuInputSchema.safeParse({ ...valid, startedAtSec: 10, endedAtSec: 10 })
        .success,
    ).toBe(true);
  });
});
