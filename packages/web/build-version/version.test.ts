import { describe, expect, it } from 'vitest';
import { buildVersionFromGit, normalizeCommit, versionJson } from './version.ts';

const SHA = 'aa0922b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
const NOW = new Date('2026-10-30T01:02:03.000Z');

describe('buildVersionFromGit', () => {
  it('変更が無ければ dirty: false', () => {
    expect(buildVersionFromGit({ head: `${SHA}\n`, status: '' }, NOW)).toEqual({
      commit: SHA,
      builtAt: '2026-10-30T01:02:03.000Z',
      dirty: false,
    });
  });

  it('未コミットの変更があれば dirty: true', () => {
    expect(
      buildVersionFromGit({ head: SHA, status: ' M packages/web/src/main.tsx\n' }, NOW).dirty,
    ).toBe(true);
  });

  it('git が無い・失敗したら unknown（ビルドは止めない）', () => {
    expect(buildVersionFromGit({ head: null, status: null }, NOW)).toEqual({
      commit: 'unknown',
      builtAt: '2026-10-30T01:02:03.000Z',
      dirty: false,
    });
  });

  it('status だけ失敗したら dirty とは言わない', () => {
    expect(buildVersionFromGit({ head: SHA, status: null }, NOW).dirty).toBe(false);
  });
});

describe('normalizeCommit', () => {
  it('大文字・改行を揃える', () => {
    expect(normalizeCommit(`${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  it('SHA でない出力は unknown', () => {
    expect(normalizeCommit('HEAD')).toBe('unknown');
    expect(normalizeCommit('aa0922b')).toBe('unknown');
    expect(normalizeCommit('')).toBe('unknown');
  });
});

describe('versionJson', () => {
  it('末尾に改行を付けた JSON', () => {
    const text = versionJson({ commit: SHA, builtAt: NOW.toISOString(), dirty: false });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ commit: SHA, builtAt: NOW.toISOString(), dirty: false });
  });
});
