import { describe, expect, it } from 'vitest';
import { engineAssetPaths, parseEngineManifest } from './engine-manifest';

const sha = (c: string) => c.repeat(64);

// packages/engine-wasm のビルドスクリプトが書く形。
const valid = () => ({
  engine: {
    buildId: 'c1b80eaa-0123456789ab',
    upstreamSha: 'c1b80eaa09fe13d5f12b1599d1ae4d53c224de30',
    emsdk: 'emscripten/emsdk:3.1.43',
    target: 'halfkp.noeval',
    exportName: 'YaneuraOu_HalfKP_noeval',
    dir: '0123456789abcdef',
    files: {
      js: 'yaneuraou.halfkp.noeval.js',
      worker: 'yaneuraou.halfkp.noeval.worker.js',
      wasm: 'yaneuraou.halfkp.noeval.wasm',
    },
    sha256: { js: sha('a'), worker: sha('b'), wasm: sha('c') },
  },
  eval: {
    name: 'Suisho5',
    file: 'eval/nn-768068f0d534a060.bin',
    bytes: 64217066,
    sha256: sha('d'),
  },
  fvScale: 16,
});

describe('parseEngineManifest', () => {
  it('ビルドスクリプトが書く形を受け入れる', () => {
    const manifest = parseEngineManifest(valid());
    expect(manifest.engine.buildId).toBe('c1b80eaa-0123456789ab');
    expect(manifest.fvScale).toBe(16);
  });

  it('知らない項目は落として受け入れる（項目を足しても古い読み手が壊れない）', () => {
    const manifest = parseEngineManifest({ ...valid(), extra: 1 });
    expect(manifest).not.toHaveProperty('extra');
  });

  it('項目が欠けていれば投げる', () => {
    const { fvScale: _fvScale, ...rest } = valid();
    expect(() => parseEngineManifest(rest)).toThrow();
  });

  it('sha256 の形が違えば投げる', () => {
    const input = valid();
    input.eval.sha256 = 'xyz';
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it.each(['../secret', 'a/b', '.hidden', '', '/abs'])(
    '外へ出るディレクトリ名 %j を通さない',
    (dir) => {
      const input = valid();
      input.engine.dir = dir;
      expect(() => parseEngineManifest(input)).toThrow();
    },
  );

  it.each([
    '../nn.bin',
    'eval/../../nn.bin',
    '/eval/nn.bin',
    'eval//nn.bin',
    'https://example.com/nn.bin',
  ])('外へ出る評価関数のパス %j を通さない', (file) => {
    const input = valid();
    input.eval.file = file;
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it('FV_SCALE と大きさは正の整数だけ', () => {
    expect(() => parseEngineManifest({ ...valid(), fvScale: 0 })).toThrow();
    expect(() => parseEngineManifest({ ...valid(), fvScale: 16.5 })).toThrow();
    const input = valid();
    input.eval.bytes = -1;
    expect(() => parseEngineManifest(input)).toThrow();
  });
});

describe('engineAssetPaths', () => {
  it('manifest の置き場からの相対パスを返す', () => {
    expect(engineAssetPaths(parseEngineManifest(valid()))).toEqual({
      js: '0123456789abcdef/yaneuraou.halfkp.noeval.js',
      worker: '0123456789abcdef/yaneuraou.halfkp.noeval.worker.js',
      wasm: '0123456789abcdef/yaneuraou.halfkp.noeval.wasm',
      eval: 'eval/nn-768068f0d534a060.bin',
    });
  });
});
