import { describe, expect, it } from 'vitest';
import {
  buildVersionFromEnv,
  normalizeBuiltAt,
  normalizeCommit,
  parseDirty,
} from './build-version.js';

const SHA = 'aa0922b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';

describe('buildVersionFromEnv', () => {
  it('ビルド引数が揃っていればそのまま返す', () => {
    expect(
      buildVersionFromEnv({
        GIT_COMMIT: SHA,
        BUILD_TIME: '2026-10-30T01:02:03Z',
        GIT_DIRTY: 'false',
      }),
    ).toEqual({ commit: SHA, builtAt: '2026-10-30T01:02:03.000Z', dirty: false });
  });

  it('未指定なら unknown（dev は何も渡さない）', () => {
    expect(buildVersionFromEnv({})).toEqual({
      commit: 'unknown',
      builtAt: 'unknown',
      dirty: false,
    });
  });
});

describe('normalizeCommit', () => {
  it('大文字・前後の空白を揃える', () => {
    expect(normalizeCommit(` ${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  it('短縮形・空・SHA でないものは unknown', () => {
    expect(normalizeCommit('aa0922b')).toBe('unknown');
    expect(normalizeCommit('')).toBe('unknown');
    expect(normalizeCommit('unknown')).toBe('unknown');
    expect(normalizeCommit(`${SHA}0`)).toBe('unknown');
  });
});

describe('normalizeBuiltAt', () => {
  it('オフセット付きの日時を UTC に揃える', () => {
    expect(normalizeBuiltAt('2026-10-30T10:00:00+09:00')).toBe(
      '2026-10-30T01:00:00.000Z',
    );
  });

  it('読めない値は unknown', () => {
    expect(normalizeBuiltAt('yesterday')).toBe('unknown');
    expect(normalizeBuiltAt(undefined)).toBe('unknown');
    expect(normalizeBuiltAt('unknown')).toBe('unknown');
  });
});

describe('parseDirty', () => {
  it('true / 1 だけを dirty とみなす', () => {
    expect(parseDirty('true')).toBe(true);
    expect(parseDirty('TRUE')).toBe(true);
    expect(parseDirty('1')).toBe(true);
    expect(parseDirty('false')).toBe(false);
    expect(parseDirty('')).toBe(false);
    expect(parseDirty(undefined)).toBe(false);
  });
});
