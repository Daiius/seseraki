import { describe, expect, it } from 'vitest';
import {
  createUsiSession,
  engineEntryOf,
  type EngineManifest,
  type EngineManifestEntry,
} from 'shared';
import {
  connectEngineHost,
  analysisThreads,
  engineOptions,
  initRequest,
  threadsFor,
  type HostRequest,
  type HostWorkerLike,
} from './engineHost';
import {
  engineManifestUrl,
  engineUrls,
  fetchEngineManifest,
} from './enginePaths';
import {
  DEFAULT_BROWSER_ANALYSIS_SETTINGS,
  hasConsented,
  parseBrowserAnalysisSettings,
  withConsent,
} from './settings';
import { detectSupport, unsupportedMessage, type BrowserEnv } from './support';

const PROGRESS = {
  file: 'eval/progress-a2d18f0564639c94.bin',
  bytes: 1_003_104,
  sha256: 'a2d18f0564639c945b5d6469e9b437cd64a526ad4fbcef02ab1d8f547d08e5f1',
};
const LICENSE = {
  name: 'MIT',
  sourceUrl: 'https://yaneuraou.yaneu.com/2026/10/14/tsuyou-11-mini-micro-released-under-mit-license/',
  file: 'eval/license-1bf4379b216297a6.txt',
};

const MINI: EngineManifestEntry = {
  id: 'tsuyo11mini',
  name: 'つようら王11mini',
  engine: {
    buildId: 'c1b80eaa-a2b7ca71a963',
    upstreamSha: 'c1b80eaa09fe13d5f12b1599d1ae4d53c224de30',
    emsdk: 'emscripten/emsdk:3.1.43',
    edition: 'YANEURAOU_ENGINE_SFNN_ka2_4096_8_64_progress8',
    exportName: 'YaneuraOu_SFNN_ka2_4096',
    dir: '1e50e75f5e2b8754',
    files: {
      js: 'yaneuraou.sfnn_ka2_4096_8_64_progress8.js',
      worker: 'yaneuraou.sfnn_ka2_4096_8_64_progress8.worker.js',
      wasm: 'yaneuraou.sfnn_ka2_4096_8_64_progress8.wasm',
    },
    sha256: { js: '1'.repeat(64), worker: '2'.repeat(64), wasm: '3'.repeat(64) },
  },
  nn: {
    file: 'eval/nn-45323c65135da65d.bin',
    bytes: 7_711_372,
    sha256: '45323c65135da65d6c2c364eea93a5af6a285c27ebfb07eab4afbe737ef74508',
  },
  progress: PROGRESS,
  fvScale: 16,
  license: LICENSE,
};

const MICRO: EngineManifestEntry = {
  ...MINI,
  id: 'tsuyo11micro',
  name: 'つようら王11micro',
  engine: {
    ...MINI.engine,
    buildId: 'c1b80eaa-0123456789ab',
    edition: 'YANEURAOU_ENGINE_SFNN_ka2_2048_8_64_progress8',
    exportName: 'YaneuraOu_SFNN_ka2_2048',
    dir: 'fedcba9876543210',
    files: {
      js: 'yaneuraou.sfnn_ka2_2048_8_64_progress8.js',
      worker: 'yaneuraou.sfnn_ka2_2048_8_64_progress8.worker.js',
      wasm: 'yaneuraou.sfnn_ka2_2048_8_64_progress8.wasm',
    },
  },
  nn: {
    file: 'eval/nn-7f9545dbf73b87ac.bin',
    bytes: 3_864_610,
    sha256: '7f9545dbf73b87acf312146daabf59c4f17d0845c87d587fa19caed51707dddb',
  },
};

const MANIFEST: EngineManifest = { defaultId: 'tsuyo11mini', evals: [MINI, MICRO] };

describe('エンジンの URL の組み立て', () => {
  it('選んだエントリから、ホストに渡す絶対 URL を作る', () => {
    expect(engineManifestUrl('https://app.example')).toBe(
      'https://app.example/engine/manifest.json',
    );
    expect(engineUrls('https://app.example', MICRO)).toEqual({
      glue: 'https://app.example/engine/fedcba9876543210/yaneuraou.sfnn_ka2_2048_8_64_progress8.js',
      // グルーが .worker.js と .wasm を探すディレクトリ（末尾の / まで）
      base: 'https://app.example/engine/fedcba9876543210/',
      nn: 'https://app.example/engine/eval/nn-7f9545dbf73b87ac.bin',
      progress: 'https://app.example/engine/eval/progress-a2d18f0564639c94.bin',
    });
  });

  it('ホストへの初期化の依頼は、エントリの値をそのまま運び、評価関数を /eval/ に置かせる', () => {
    expect(initRequest(MINI, engineUrls('http://localhost:5173', MINI))).toEqual({
      type: 'init',
      glueUrl:
        'http://localhost:5173/engine/1e50e75f5e2b8754/yaneuraou.sfnn_ka2_4096_8_64_progress8.js',
      baseUrl: 'http://localhost:5173/engine/1e50e75f5e2b8754/',
      exportName: 'YaneuraOu_SFNN_ka2_4096',
      evalFiles: [
        {
          url: 'http://localhost:5173/engine/eval/nn-45323c65135da65d.bin',
          bytes: 7_711_372,
          sha256: MINI.nn.sha256,
          path: '/eval/nn.bin',
        },
        {
          url: 'http://localhost:5173/engine/eval/progress-a2d18f0564639c94.bin',
          bytes: 1_003_104,
          sha256: PROGRESS.sha256,
          path: '/eval/progress.bin',
        },
      ],
    });
  });
});

describe('fetchEngineManifest', () => {
  const respond = (status: number, body: string) => async () =>
    new Response(body, { status });

  it('置かれていれば検証して返す', async () => {
    const manifest = await fetchEngineManifest(
      'https://app.example',
      respond(200, JSON.stringify(MANIFEST)),
    );
    expect(manifest?.evals.map((entry) => entry.engine.buildId)).toEqual([
      'c1b80eaa-a2b7ca71a963',
      'c1b80eaa-0123456789ab',
    ]);
  });

  it('無ければ null（404）', async () => {
    expect(await fetchEngineManifest('https://app.example', respond(404, 'not found'))).toBeNull();
  });

  it('無いパスに index.html を 200 で返す配信でも null', async () => {
    expect(
      await fetchEngineManifest('https://app.example', respond(200, '<!doctype html><html>')),
    ).toBeNull();
  });

  it('形の違う JSON も null', async () => {
    expect(
      await fetchEngineManifest('https://app.example', respond(200, '{"engine":{}}')),
    ).toBeNull();
  });

  it('前の形（水匠5 の頃のエンジン 1 つ・eval）も null（配信を入れ替える途中でも解析しない）', async () => {
    const old = { engine: MINI.engine, eval: { name: 'Suisho5', ...MINI.nn }, fvScale: 16 };
    expect(
      await fetchEngineManifest('https://app.example', respond(200, JSON.stringify(old))),
    ).toBeNull();
  });

  it('5xx は「置かれていない」と区別して投げる', async () => {
    await expect(
      fetchEngineManifest('https://app.example', respond(502, '')),
    ).rejects.toThrow('502');
  });
});

describe('analysisThreads（負荷の設定。prd/14 §5.10）', () => {
  it('全力: 論理コア数と上限の小さいほう', () => {
    expect(analysisThreads(4, 8, 'max')).toBe(4);
    expect(analysisThreads(16, 8, 'max')).toBe(8);
    expect(analysisThreads(8, 8, 'max')).toBe(8);
  });

  it('控えめ: 全力の半分（切り捨て・最低 1）', () => {
    expect(analysisThreads(16, 8, 'gentle')).toBe(4);
    expect(analysisThreads(6, 8, 'gentle')).toBe(3);
    expect(analysisThreads(3, 8, 'gentle')).toBe(1);
    expect(analysisThreads(2, 8, 'gentle')).toBe(1);
    expect(analysisThreads(1, 8, 'gentle')).toBe(1);
  });

  it('論理コア数が分からなければ 1 スレッド', () => {
    expect(analysisThreads(undefined, 8, 'max')).toBe(1);
    expect(analysisThreads(0, 8, 'max')).toBe(1);
    expect(analysisThreads(Number.NaN, 8, 'max')).toBe(1);
    expect(analysisThreads(undefined, 8, 'gentle')).toBe(1);
  });
});

describe('threadsFor（作るとき・合わせるときのスレッド数）', () => {
  const created = { maxThreads: 8, stageMaxThreads: 4 };
  const base = { createdSettings: created, hardwareConcurrency: 16, load: 'max' as const };

  it('固定のスレッド数があればその数（段の上限・負荷・論理コア数によらない）', () => {
    expect(threadsFor({ ...base, fixed: 2 })).toBe(2);
    expect(threadsFor({ ...base, fixed: 2, cap: 8, load: 'gentle' })).toBe(2);
  });

  it('無ければ負荷の設定の数。上限は段の上限（cap）と、作ったときの maxThreads の小さいほう', () => {
    expect(threadsFor({ ...base, fixed: null, cap: 4 })).toBe(4);
    expect(threadsFor({ ...base, fixed: null, cap: 8 })).toBe(8);
    expect(threadsFor({ ...base, fixed: null, cap: 16 })).toBe(8);
    expect(threadsFor({ ...base, fixed: null, cap: 4, load: 'gentle' })).toBe(2);
    expect(threadsFor({ ...base, fixed: null, cap: 8, hardwareConcurrency: 2 })).toBe(2);
  });

  it('cap が無ければ作ったときの段の上限（無ければ maxThreads）', () => {
    expect(threadsFor({ ...base })).toBe(4);
    expect(threadsFor({ ...base, createdSettings: { maxThreads: 8 } })).toBe(8);
    expect(threadsFor({ ...base, createdSettings: { maxThreads: 8 }, load: 'gentle' })).toBe(4);
  });
});

describe('engineOptions', () => {
  const settings = { maxThreads: 8, hashMb: 64 };

  it('スレッド数は負荷の設定で決まる', () => {
    expect(engineOptions(MINI, settings, 4, 'max').threads).toBe(4);
    expect(engineOptions(MINI, settings, 16, 'max').threads).toBe(8);
    expect(engineOptions(MINI, settings, 16, 'gentle').threads).toBe(4);
  });

  it('段ごとの上限（stageMaxThreads。full は 4。prd/14 §5.5）で絞る。控えめはその半分。無ければ maxThreads', () => {
    const full = { ...settings, stageMaxThreads: 4 };
    expect(engineOptions(MINI, full, 16, 'max').threads).toBe(4);
    expect(engineOptions(MINI, full, 16, 'gentle').threads).toBe(2);
    expect(engineOptions(MINI, full, 2, 'max').threads).toBe(2);
    expect(engineOptions(MINI, { ...settings, stageMaxThreads: 8 }, 16, 'max').threads).toBe(8);
    // 詰将棋の判定の固定のスレッド数は段の上限によらない
    expect(engineOptions(MINI, full, 16, 'max', 2).threads).toBe(2);
  });

  it('論理コア数が分からなければ 1 スレッド', () => {
    expect(engineOptions(MINI, settings, undefined, 'max').threads).toBe(1);
  });

  it('固定のスレッド数を渡せばその数（詰将棋の判定。負荷の設定・論理コア数によらない。prd/13 §5.5）', () => {
    const options = engineOptions(MINI, settings, 16, 'gentle', 2);
    expect(options.threads).toBe(2);
    expect(options.options).toContainEqual(['Threads', '2']);
    expect(engineOptions(MINI, settings, undefined, 'max', 2).threads).toBe(2);
    // 数として使えない値は負荷の設定で決める
    expect(engineOptions(MINI, settings, 16, 'max', 0).threads).toBe(8);
  });

  it('評価関数の場所・FV_SCALE・定跡なし・ConsiderationMode を渡す', () => {
    expect(engineOptions(MINI, settings, 6, 'max').options).toEqual([
      ['EvalDir', '/eval'],
      ['EvalFile', 'nn.bin'],
      ['FV_SCALE', '16'],
      ['Threads', '6'],
      ['USI_Hash', '64'],
      ['BookFile', 'no_book'],
      ['ConsiderationMode', 'true'],
    ]);
  });
});

/** 偽のホスト（Worker）。送られたメッセージを覚え、テストからメッセージを届ける */
function fakeWorker() {
  const worker: HostWorkerLike & {
    sent: HostRequest[];
    terminated: boolean;
    throwOnPost: unknown;
    emit(data: unknown): void;
  } = {
    sent: [],
    terminated: false,
    throwOnPost: undefined,
    onmessage: null,
    onerror: null,
    postMessage(message) {
      if (worker.throwOnPost !== undefined) throw worker.throwOnPost;
      worker.sent.push(message);
    },
    terminate() {
      worker.terminated = true;
    },
    emit(data) {
      worker.onmessage?.({ data });
    },
  };
  return worker;
}

const INIT: HostRequest = initRequest(MINI, engineUrls('https://app.example', MINI));
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

describe('connectEngineHost', () => {
  it('init を送り、ready で準備完了になる。受信の進捗を伝える', async () => {
    const worker = fakeWorker();
    const downloads: [number, number][] = [];
    const connection = connectEngineHost(worker, INIT, {
      onDownload: (loaded, total) => downloads.push([loaded, total]),
    });
    expect(worker.sent).toEqual([INIT]);

    worker.emit({ type: 'download', loaded: 10, total: 100 });
    worker.emit({ type: 'ready' });
    await expect(connection.ready).resolves.toBeUndefined();
    expect(downloads).toEqual([[10, 100]]);
  });

  it('USI の行を送受信する（セッションを上に載せられる）', async () => {
    const worker = fakeWorker();
    const connection = connectEngineHost(worker, INIT);
    worker.emit({ type: 'ready' });
    const session = createUsiSession(connection.transport, { timers: noTimers });

    const started = session.start();
    expect(worker.sent.at(-1)).toEqual({ type: 'cmd', line: 'usi' });
    worker.emit({ type: 'line', line: 'id name YaneuraOu NNUE' });
    worker.emit({ type: 'line', line: 'usiok' });
    await started;
    expect(session.getName()).toBe('YaneuraOu NNUE');
  });

  it('ホストが dead を送ったら、待っている探索はそのエラーで失敗する', async () => {
    const worker = fakeWorker();
    const connection = connectEngineHost(worker, INIT);
    worker.emit({ type: 'ready' });
    const session = createUsiSession(connection.transport, { timers: noTimers });

    const analysis = session.analyze('position startpos moves 1a1b', 'go movetime 300');
    worker.emit({ type: 'dead', message: 'Program terminated with exit(1)' });
    await expect(analysis).rejects.toThrow('exit(1)');
    // 死んだ後に届く行は配らない・以後の送信は投げる
    worker.emit({ type: 'line', line: 'info string Error! : Illegal Input Move' });
    expect(() => connection.transport.send('isready')).toThrow('exit(1)');
  });

  it('Worker の error もエンジンの死として扱う', async () => {
    const worker = fakeWorker();
    const connection = connectEngineHost(worker, INIT);
    const deaths: string[] = [];
    connection.transport.onDeath((error) => deaths.push(error.message));

    worker.onerror?.({ message: 'Uncaught RuntimeError: memory access out of bounds' });
    expect(deaths).toEqual(['Uncaught RuntimeError: memory access out of bounds']);
    await expect(connection.ready).rejects.toThrow('memory access out of bounds');
  });

  it('送信が投げたら（Error でない値でも）死として伝え、Error にして投げ直す', () => {
    const worker = fakeWorker();
    const connection = connectEngineHost(worker, INIT);
    const deaths: Error[] = [];
    connection.transport.onDeath((error) => deaths.push(error));

    worker.throwOnPost = { name: 'ExitStatus', message: 'Program terminated', status: 1 };
    expect(() => connection.transport.send('go')).toThrow('Program terminated');
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toBeInstanceOf(Error);
  });

  it('準備の前に死んだら ready が拒否される（聞き手の登録が後でも伝わる）', async () => {
    const worker = fakeWorker();
    const connection = connectEngineHost(worker, INIT);
    worker.emit({ type: 'dead', message: '評価関数を取得できません (404)' });
    await expect(connection.ready).rejects.toThrow('404');

    const deaths: string[] = [];
    connection.transport.onDeath((error) => deaths.push(error.message));
    expect(deaths).toEqual(['評価関数を取得できません (404)']);
  });

  it('dispose は quit を送り、猶予の後に Worker を止める', () => {
    const worker = fakeWorker();
    const scheduled: (() => void)[] = [];
    const connection = connectEngineHost(worker, INIT, {
      setTimeout: (callback) => scheduled.push(callback),
    });
    connection.dispose();
    connection.dispose();
    expect(worker.sent.filter((m) => m.type === 'quit')).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    scheduled[0]();
    expect(worker.terminated).toBe(true);
    expect(() => connection.transport.send('usi')).toThrow();
  });
});

describe('parseBrowserAnalysisSettings', () => {
  it('無い・壊れている値は既定（詳細ページだけ・全力・未同意）', () => {
    expect(parseBrowserAnalysisSettings(null)).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('{')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('null')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('"always"')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(DEFAULT_BROWSER_ANALYSIS_SETTINGS).toEqual({
      mode: 'detail',
      load: 'max',
      evalId: null,
      consentedEvalSha256s: [],
    });
  });

  it('保存した値を読む', () => {
    const a = 'ab'.repeat(32);
    const b = 'cd'.repeat(32);
    const value = {
      mode: 'always',
      load: 'gentle',
      evalId: 'tsuyo11micro',
      consentedEvalSha256s: [a, b],
    };
    expect(parseBrowserAnalysisSettings(JSON.stringify(value))).toEqual(value);
  });

  it('負荷の設定が無い値（この設定を足す前に保存したもの）は全力として読む', () => {
    expect(parseBrowserAnalysisSettings(JSON.stringify({ mode: 'always' }))).toEqual({
      mode: 'always',
      load: 'max',
      evalId: null,
      consentedEvalSha256s: [],
    });
  });

  it('前の形の同意（1 つだけ。水匠5 の頃）は集合の 1 つとして読む', () => {
    const old = 'ab'.repeat(32);
    const settings = parseBrowserAnalysisSettings(
      JSON.stringify({ mode: 'always', consentEvalSha256: old }),
    );
    expect(settings.consentedEvalSha256s).toEqual([old]);
    // 新しい評価関数には効かない
    expect(hasConsented(settings, MINI.nn.sha256)).toBe(false);
    expect(settings).not.toHaveProperty('consentEvalSha256');
  });

  it('知らない負荷の値は全力に戻す', () => {
    expect(
      parseBrowserAnalysisSettings(JSON.stringify({ mode: 'detail', load: 'turbo' })).load,
    ).toBe('max');
  });

  it('値ごとに既定へ戻す（知らない範囲・形の違う評価関数の id・ハッシュの形でない同意）', () => {
    const sha = 'ab'.repeat(32);
    expect(
      parseBrowserAnalysisSettings(
        JSON.stringify({ mode: 'background', evalId: 'tsuyo11mini', consentedEvalSha256s: [sha] }),
      ),
    ).toEqual({ mode: 'detail', load: 'max', evalId: 'tsuyo11mini', consentedEvalSha256s: [sha] });
    for (const evalId of [1, '', 'Mini', '../x', 'a'.repeat(33)]) {
      expect(parseBrowserAnalysisSettings(JSON.stringify({ evalId })).evalId).toBeNull();
    }
    expect(
      parseBrowserAnalysisSettings(
        JSON.stringify({ consentedEvalSha256s: [sha, true, 'yes', sha.toUpperCase(), sha] }),
      ).consentedEvalSha256s,
    ).toEqual([sha]);
    expect(
      parseBrowserAnalysisSettings(JSON.stringify({ consentedEvalSha256s: sha }))
        .consentedEvalSha256s,
    ).toEqual([]);
  });
});

describe('評価関数ごとの同意（prd/14 §5.10）', () => {
  it('同意を足しても重複させない', () => {
    const once = withConsent([], MINI.nn.sha256);
    expect(withConsent(once, MINI.nn.sha256)).toEqual([MINI.nn.sha256]);
    expect(withConsent(once, MICRO.nn.sha256)).toEqual([MINI.nn.sha256, MICRO.nn.sha256]);
  });

  it('覚える数には上限があり、古いものから捨てる', () => {
    let consented: string[] = [];
    for (let i = 0; i < 20; i++) {
      consented = withConsent(consented, i.toString(16).padStart(64, '0'));
    }
    expect(consented).toHaveLength(16);
    expect(consented[0]).toBe((4).toString(16).padStart(64, '0'));
  });

  it('選んだ評価関数の nn.bin の sha256 で同意を確かめる（未選択は既定）', () => {
    const settings = { consentedEvalSha256s: [MICRO.nn.sha256] };
    expect(hasConsented(settings, engineEntryOf(MANIFEST, 'tsuyo11micro').nn.sha256)).toBe(true);
    expect(hasConsented(settings, engineEntryOf(MANIFEST, null).nn.sha256)).toBe(false);
    // 配っていない id は既定（mini）として読む
    expect(engineEntryOf(MANIFEST, 'suisho5').id).toBe('tsuyo11mini');
  });
});

describe('detectSupport', () => {
  const ok: BrowserEnv = {
    isSecureContext: true,
    crossOriginIsolated: true,
    hasSharedArrayBuffer: true,
    hasWebLocks: true,
    hasWorker: true,
    hasWasm: true,
  };

  it('そろっていれば動く', () => {
    expect(detectSupport(ok)).toEqual({ supported: true });
  });

  it('cross-origin isolated でなければ動かない', () => {
    expect(detectSupport({ ...ok, crossOriginIsolated: false, hasSharedArrayBuffer: false })).toEqual({
      supported: false,
      reasons: ['not-isolated'],
    });
  });

  it('SharedArrayBuffer・Web Locks が無ければ動かない', () => {
    expect(detectSupport({ ...ok, hasSharedArrayBuffer: false })).toEqual({
      supported: false,
      reasons: ['no-shared-array-buffer'],
    });
    expect(detectSupport({ ...ok, hasWebLocks: false })).toEqual({
      supported: false,
      reasons: ['no-web-locks'],
    });
  });

  it('https でない接続は、その理由だけを挙げる', () => {
    const result = detectSupport({
      ...ok,
      isSecureContext: false,
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      hasWebLocks: false,
    });
    expect(result).toEqual({ supported: false, reasons: ['insecure-context'] });
  });

  it('案内の文は理由で変わり、内部の用語を出さない', () => {
    expect(unsupportedMessage(['insecure-context'])).toContain('https');
    expect(unsupportedMessage(['not-isolated'])).toContain('配信の設定');
    expect(unsupportedMessage(['no-web-locks'])).toContain('このブラウザ');
    for (const reasons of [['insecure-context'], ['not-isolated'], ['no-wasm']] as const) {
      expect(unsupportedMessage(reasons)).not.toMatch(/SharedArrayBuffer|COOP|COEP|Locks/);
    }
  });
});
