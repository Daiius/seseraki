import { describe, expect, it } from 'vitest';
import {
  engineCacheControl,
  engineContentType,
  engineHostAssetName,
  engineRelativePath,
  isEngineRequired,
} from './serving';

describe('engineRelativePath', () => {
  it('/engine/ の下のパスを相対パスにする（クエリは落とす）', () => {
    expect(engineRelativePath('/engine/manifest.json')).toBe('manifest.json');
    expect(engineRelativePath('/engine/manifest.json?t=1')).toBe(
      'manifest.json',
    );
    expect(
      engineRelativePath('/engine/1e50e75f/yaneuraou.halfkp.noeval.wasm'),
    ).toBe('1e50e75f/yaneuraou.halfkp.noeval.wasm');
    expect(engineRelativePath('/engine/eval/nn-768068f0.bin')).toBe(
      'eval/nn-768068f0.bin',
    );
  });

  it('/engine/ の外は null', () => {
    expect(engineRelativePath('/')).toBeNull();
    expect(engineRelativePath('/engine')).toBeNull();
    expect(engineRelativePath('/engine/')).toBeNull();
    expect(engineRelativePath('/engine-host.js')).toBeNull();
    expect(engineRelativePath('/api/engine/manifest.json')).toBeNull();
  });

  it.each([
    '/engine/../package.json',
    '/engine/a/../../x',
    '/engine/%2e%2e/x',
    '/engine/a//b',
    '/engine/.hidden',
    '/engine/a/.env',
    '/engine/a\\b',
    '/engine/a%2Fb/../c',
    '/engine/%E0%A4%A',
    '/engine/a b',
  ])('ディレクトリの外へ出うるパスは配らない: %s', (url) => {
    expect(engineRelativePath(url)).toBeNull();
  });
});

describe('engineContentType / engineCacheControl', () => {
  it('wasm は application/wasm', () => {
    expect(engineContentType('x/y.wasm')).toBe('application/wasm');
  });

  it('グルーと worker は JavaScript、評価関数は octet-stream', () => {
    expect(engineContentType('x/y.js')).toContain('text/javascript');
    expect(engineContentType('x/y.worker.js')).toContain('text/javascript');
    expect(engineContentType('manifest.json')).toContain('application/json');
    expect(engineContentType('eval/nn-1.bin')).toBe('application/octet-stream');
    expect(engineContentType('eval/progress-1.bin')).toBe('application/octet-stream');
    // 評価関数の許諾文（MIT）
    expect(engineContentType('eval/license-1.txt')).toBe('text/plain; charset=utf-8');
  });

  it('manifest.json だけはキャッシュさせず、ほかは長期キャッシュ', () => {
    expect(engineCacheControl('manifest.json')).toBe('no-cache');
    expect(engineCacheControl('eval/nn-1.bin')).toContain('immutable');
    expect(engineCacheControl('abc/y.wasm')).toContain('max-age=31536000');
    // 内容ハッシュのディレクトリの下にある同名のファイルは長期キャッシュのまま
    expect(engineCacheControl('abc/manifest.json')).toContain('immutable');
  });
});

describe('engineHostAssetName / isEngineRequired', () => {
  it('ホストは assets/ の下に内容ハッシュ入りの名前で出す', () => {
    expect(engineHostAssetName('0123456789abcdef0123')).toBe(
      'assets/engine-host-0123456789ab.js',
    );
  });

  it('ENGINE_REQUIRED=1 のときだけ必須', () => {
    expect(isEngineRequired({})).toBe(false);
    expect(isEngineRequired({ ENGINE_REQUIRED: '' })).toBe(false);
    expect(isEngineRequired({ ENGINE_REQUIRED: '0' })).toBe(false);
    expect(isEngineRequired({ ENGINE_REQUIRED: '1' })).toBe(true);
    expect(isEngineRequired({ ENGINE_REQUIRED: 'true' })).toBe(true);
  });
});
