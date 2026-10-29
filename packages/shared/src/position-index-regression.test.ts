import { describe, expect, it } from 'vitest';
import { buildPositions } from './board';
import { boardBytes, handBytes, positionSfen, sideSfen } from './position';
import { positionHashHex } from './test-fixtures/position-hash-hex';
import { RANDOM_GAME_A, RANDOM_GAME_B, RANDOM_GAME_C } from './test-fixtures/games';

/**
 * 🔴 **合法な棋譜の局面索引を変えない**（AGENTS.md「局面索引の一括再構築」）。
 *
 * 局面索引（`kifu_positions`）は `buildPositions` の各局面から、局面キー 3 本（`positionSfen` /
 * `sideSfen` の先手・後手）のハッシュと、盤・持ち駒のバイト列を作って保存する。`applyMove` や
 * 駒の定義を直したときに 1 局面でも値が変わると、**本番で全件の作り直しが要る**。
 *
 * ここでは対局ごとに全局面の値を 1 本の文字列に連ねて、そのハッシュを既知の値で固定する。
 * 既知の値は、`applyMove` の中核を `relocate` に寄せる前（main 883b2c9）のコードで取った。
 * ⚠ スナップショットにしない（`vitest -u` で黙って書き換わると固定の意味が無い）。
 */
function indexDigest(moves: string[]): string {
  const lines = buildPositions(moves).map((state) =>
    [
      positionHashHex(positionSfen(state)),
      positionHashHex(sideSfen(state, 'sente')),
      positionHashHex(sideSfen(state, 'gote')),
      [...boardBytes(state)].join(','),
      [...handBytes(state)].join(','),
    ].join(':'),
  );
  return positionHashHex(lines.join('\n'));
}

describe('局面索引の回帰（合法な棋譜で値を変えない）', () => {
  it('無作為な合法手の対局 A（250 手・打ち 80）', () => {
    expect(indexDigest(RANDOM_GAME_A)).toBe('d14cbd97d72b305c');
  });

  it('無作為な合法手の対局 B（85 手で詰み）', () => {
    expect(indexDigest(RANDOM_GAME_B)).toBe('bc96f45d8668a8e3');
  });

  it('無作為な合法手の対局 C（160 手・成り / 不成 / 打ち / 取り返しが多い）', () => {
    expect(indexDigest(RANDOM_GAME_C)).toBe('1c7200b9d795b0c6');
  });
});
