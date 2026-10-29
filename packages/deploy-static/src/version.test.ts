import { describe, expect, it } from 'vitest';
import { describeBuildVersion } from './version.js';

const SHA = 'aa0922b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
const AT = '2026-10-30T01:02:03.000Z';

describe('describeBuildVersion', () => {
  it('コミットとビルド日時を 1 行で出す', () => {
    expect(describeBuildVersion(JSON.stringify({ commit: SHA, builtAt: AT, dirty: false }))).toBe(
      `版: ${SHA}（ビルド ${AT}）`,
    );
  });

  it('dirty・unknown は注意を添える', () => {
    expect(
      describeBuildVersion(JSON.stringify({ commit: SHA, builtAt: AT, dirty: true })),
    ).toContain('未コミットの変更');
    expect(
      describeBuildVersion(JSON.stringify({ commit: 'unknown', builtAt: AT, dirty: false })),
    ).toContain('コミットが分からない');
  });

  it('読めない・形が違うなら投げる', () => {
    expect(() => describeBuildVersion('{')).toThrow();
    expect(() => describeBuildVersion(JSON.stringify({ commit: SHA }))).toThrow();
  });
});
