import { describe, expect, it } from 'vitest';
import { isEnginePathSegment } from './engine-paths';

describe('isEnginePathSegment（配信物のパスの 1 階層）', () => {
  it('内容ハッシュ入りの名前は通す', () => {
    for (const ok of ['manifest.json', '1e50e75f', 'nn-768068f0.bin', 'yaneuraou.halfkp.noeval.wasm', '_x', '-x']) {
      expect(isEnginePathSegment(ok)).toBe(true);
    }
  });

  it('🔒 外へ出うる名前（空・親ディレクトリ・先頭のドット・区切り・空白）は通さない', () => {
    for (const ng of ['', '.', '..', '.env', 'a/b', 'a\\b', 'a b', '%2e']) {
      expect(isEnginePathSegment(ng)).toBe(false);
    }
  });
});
