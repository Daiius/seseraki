import { describe, expect, it } from 'vitest';
import {
  engineAssetPaths,
  engineEntryDownloadBytes,
  engineEntryOf,
  parseEngineManifest,
} from './engine-manifest';

const sha = (c: string) => c.repeat(64);

const entry = (id: string, arch: string, dir: string, nnSha: string) => ({
  id,
  name: `つようら王11${id.replace('tsuyo11', '')}`,
  engine: {
    buildId: `c1b80eaa-${dir.slice(0, 12)}`,
    upstreamSha: 'c1b80eaa09fe13d5f12b1599d1ae4d53c224de30',
    emsdk: 'emscripten/emsdk:3.1.43',
    edition: `YANEURAOU_ENGINE_SFNN_ka2_${arch}_8_64_progress8`,
    exportName: `YaneuraOu_SFNN_ka2_${arch}`,
    dir,
    files: {
      js: `yaneuraou.sfnn_ka2_${arch}_8_64_progress8.js`,
      worker: `yaneuraou.sfnn_ka2_${arch}_8_64_progress8.worker.js`,
      wasm: `yaneuraou.sfnn_ka2_${arch}_8_64_progress8.wasm`,
    },
    sha256: { js: sha('a'), worker: sha('b'), wasm: sha('c') },
  },
  nn: {
    file: `eval/nn-${nnSha.slice(0, 16)}.bin`,
    bytes: 7711372,
    sha256: nnSha,
  },
  progress: {
    file: 'eval/progress-a2d18f0564639c94.bin',
    bytes: 1003104,
    sha256: sha('e'),
  },
  fvScale: 16,
  license: {
    name: 'MIT',
    sourceUrl: 'https://example.com/tsuyou-11',
    file: 'eval/license-0123456789abcdef.txt',
  },
});

// packages/engine-wasm のビルドスクリプトが書く形。
const valid = () => ({
  defaultId: 'tsuyo11mini',
  evals: [
    entry('tsuyo11mini', '4096', '0123456789abcdef', sha('d')),
    entry('tsuyo11micro', '2048', 'fedcba9876543210', sha('f')),
  ],
});

describe('parseEngineManifest', () => {
  it('ビルドスクリプトが書く形を受け入れる', () => {
    const manifest = parseEngineManifest(valid());
    expect(manifest.defaultId).toBe('tsuyo11mini');
    expect(manifest.evals.map((e) => e.id)).toEqual(['tsuyo11mini', 'tsuyo11micro']);
    expect(manifest.evals[0].engine.buildId).toBe('c1b80eaa-0123456789ab');
    expect(manifest.evals[0].fvScale).toBe(16);
  });

  it('知らない項目は落として受け入れる（項目を足しても古い読み手が壊れない）', () => {
    const input = { ...valid(), extra: 1 };
    input.evals[0] = { ...input.evals[0], extra: 2 } as (typeof input.evals)[0];
    const manifest = parseEngineManifest(input);
    expect(manifest).not.toHaveProperty('extra');
    expect(manifest.evals[0]).not.toHaveProperty('extra');
  });

  it('許諾文のパスは無くてもよい', () => {
    const input = valid();
    delete (input.evals[0].license as { file?: string }).file;
    expect(parseEngineManifest(input).evals[0].license.file).toBeUndefined();
  });

  it('項目が欠けていれば投げる', () => {
    const input = valid();
    const { progress: _progress, ...rest } = input.evals[0];
    expect(() => parseEngineManifest({ ...input, evals: [rest] })).toThrow();
  });

  it('前の形（エンジン 1 つ・eval・トップの fvScale）は受け入れない', () => {
    const [first] = valid().evals;
    expect(() =>
      parseEngineManifest({
        engine: { ...first.engine, target: 'halfkp.noeval' },
        eval: { name: 'Suisho5', ...first.nn },
        fvScale: 16,
      }),
    ).toThrow();
  });

  it('一覧が空なら投げる', () => {
    expect(() => parseEngineManifest({ ...valid(), evals: [] })).toThrow();
  });

  it('既定の id が一覧に無ければ投げる', () => {
    expect(() => parseEngineManifest({ ...valid(), defaultId: 'suisho5' })).toThrow(
      /既定の評価関数が一覧に無い/,
    );
  });

  it('id が重複していれば投げる', () => {
    const input = valid();
    input.evals[1].id = 'tsuyo11mini';
    expect(() => parseEngineManifest(input)).toThrow(/重複/);
  });

  it.each(['Tsuyo', 'a-b', '', 'a/b'])('id %j は通さない', (id) => {
    const input = valid();
    input.evals[1].id = id;
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it('sha256 の形が違えば投げる', () => {
    const input = valid();
    input.evals[0].nn.sha256 = 'xyz';
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it.each(['../secret', 'a/b', '.hidden', '', '/abs'])(
    '外へ出るディレクトリ名 %j を通さない',
    (dir) => {
      const input = valid();
      input.evals[0].engine.dir = dir;
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
    for (const key of ['nn', 'progress'] as const) {
      const input = valid();
      input.evals[0][key].file = file;
      expect(() => parseEngineManifest(input)).toThrow();
    }
    const input = valid();
    input.evals[0].license.file = file;
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it('出典は https の URL だけ', () => {
    const input = valid();
    input.evals[0].license.sourceUrl = 'javascript:alert(1)';
    expect(() => parseEngineManifest(input)).toThrow();
  });

  it('FV_SCALE と大きさは正の整数だけ', () => {
    for (const fvScale of [0, 16.5]) {
      const input = valid();
      input.evals[0].fvScale = fvScale;
      expect(() => parseEngineManifest(input)).toThrow();
    }
    const input = valid();
    input.evals[0].progress.bytes = -1;
    expect(() => parseEngineManifest(input)).toThrow();
  });
});

describe('engineEntryOf', () => {
  const manifest = parseEngineManifest(valid());

  it('選んだ id のエントリを返す', () => {
    expect(engineEntryOf(manifest, 'tsuyo11micro').id).toBe('tsuyo11micro');
  });

  it.each([null, undefined, '', 'suisho5'])('選んでいない・一覧に無い id（%j）は既定', (id) => {
    expect(engineEntryOf(manifest, id).id).toBe('tsuyo11mini');
  });
});

describe('engineEntryDownloadBytes', () => {
  it('nn.bin と progress.bin の合計', () => {
    const manifest = parseEngineManifest(valid());
    expect(engineEntryDownloadBytes(manifest.evals[0])).toBe(7711372 + 1003104);
  });
});

describe('engineAssetPaths', () => {
  it('manifest の置き場からの相対パスを返す', () => {
    const manifest = parseEngineManifest(valid());
    expect(engineAssetPaths(manifest.evals[1])).toEqual({
      js: 'fedcba9876543210/yaneuraou.sfnn_ka2_2048_8_64_progress8.js',
      worker: 'fedcba9876543210/yaneuraou.sfnn_ka2_2048_8_64_progress8.worker.js',
      wasm: 'fedcba9876543210/yaneuraou.sfnn_ka2_2048_8_64_progress8.wasm',
      nn: `eval/nn-${'f'.repeat(16)}.bin`,
      progress: 'eval/progress-a2d18f0564639c94.bin',
    });
  });
});
