import { describe, expect, it } from 'vitest';
import { buildPositions, createInitialState } from './board';
import { positionSfen, sideSfen } from './position';
import { positionHash, positionHashHex } from './position-hash';

/** 参照実装（BigInt で素直に書いた FNV-1a 64）。高速版と値が一致することを確かめる */
function referenceHex(text: string): string {
  const bytes = [...text].flatMap((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) return [cp];
    // テストの入力に使う範囲（2〜4 バイト）を素直に書く
    const out: number[] = [];
    if (cp < 0x800) out.push(0xc0 | (cp >> 6));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
      );
    out.push(0x80 | (cp & 0x3f));
    return out;
  });
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

describe('positionHash（FNV-1a 64）', () => {
  it('FNV-1a 64 の公開テストベクタと一致する', () => {
    expect(positionHashHex('')).toBe('cbf29ce484222325');
    expect(positionHashHex('a')).toBe('af63dc4c8601ec8c');
    expect(positionHashHex('foobar')).toBe('85944171f73967e8');
  });

  // 🔴 **この値が変わったら、局面索引の全件の作り直しが要る**（rebuild-positions）。
  // DB に入っている値と検索時に計算する値が食い違い、局面検索が黙って空になる
  it('🔴 局面キーのハッシュ値を固定する（変えたら全件の作り直し）', () => {
    const initial = createInitialState();
    expect(positionHashHex(positionSfen(initial))).toBe(referenceHex(positionSfen(initial)));
    expect({
      sfen: positionHashHex(positionSfen(initial)),
      sente: positionHashHex(sideSfen(initial, 'sente')),
      gote: positionHashHex(sideSfen(initial, 'gote')),
    }).toEqual({
      // ⚠ スナップショットにしない（`vitest -u` で黙って書き換わると固定の意味が無い）
      sfen: '301cf115cbd4fdd1',
      sente: 'd2081159f56f916e',
      gote: '3f5d5fa31629712e',
    });
  });

  it('高速版（32 ビット 2 本）は BigInt の参照実装と一致する', () => {
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e', '6a5b', '4e3d', '2b3c'];
    const inputs = [
      'x',
      '将棋',
      '𠮷',
      ...buildPositions(moves).flatMap((s) => [
        positionSfen(s),
        sideSfen(s, 'sente'),
        sideSfen(s, 'gote'),
      ]),
    ];
    for (const text of inputs) {
      expect(positionHashHex(text)).toBe(referenceHex(text));
    }
  });

  it('8 バイトを返す', () => {
    expect(positionHash(positionSfen(createInitialState()))).toHaveLength(8);
  });

  it('1 手違えば別の値になる', () => {
    const [a, b] = buildPositions(['7g7f']);
    expect(positionHashHex(positionSfen(a))).not.toBe(positionHashHex(positionSfen(b)));
  });
});
