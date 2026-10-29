import { describe, expect, it } from 'vitest';
import { formatBuildVersion, formatBuiltAt, shortCommit, webBuildVersion } from './buildVersion';

const SHA = 'aa0922b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
// 端末の時刻帯によらないように、ローカル時刻で作った日時を渡す
const LOCAL = new Date(2026, 9, 30, 9, 5).toISOString();

describe('shortCommit', () => {
  it('先頭 7 桁', () => {
    expect(shortCommit(SHA)).toBe('aa0922b');
  });

  it('SHA でなければ unknown', () => {
    expect(shortCommit('unknown')).toBe('unknown');
    expect(shortCommit('aa0922b')).toBe('unknown');
  });
});

describe('formatBuiltAt', () => {
  it('端末の時刻帯で YYYY-MM-DD HH:mm', () => {
    expect(formatBuiltAt(LOCAL)).toBe('2026-10-30 09:05');
  });

  it('読めなければ null', () => {
    expect(formatBuiltAt('unknown')).toBeNull();
  });
});

describe('formatBuildVersion', () => {
  it('短い SHA とビルド日時', () => {
    expect(formatBuildVersion({ commit: SHA, builtAt: LOCAL, dirty: false })).toBe(
      'aa0922b 2026-10-30 09:05',
    );
  });

  it('dirty なら印を付ける', () => {
    expect(formatBuildVersion({ commit: SHA, builtAt: LOCAL, dirty: true })).toBe(
      'aa0922b* 2026-10-30 09:05',
    );
  });

  it('日時が分からなければ SHA だけ', () => {
    expect(formatBuildVersion({ commit: SHA, builtAt: 'unknown', dirty: false })).toBe('aa0922b');
  });

  it('コミットが分からなければ unknown だけ', () => {
    expect(formatBuildVersion({ commit: 'unknown', builtAt: LOCAL, dirty: false })).toBe('unknown');
  });
});

describe('webBuildVersion', () => {
  it('埋め込みが無ければ unknown', () => {
    expect(webBuildVersion()).toEqual({ commit: 'unknown', builtAt: 'unknown', dirty: false });
  });
});
