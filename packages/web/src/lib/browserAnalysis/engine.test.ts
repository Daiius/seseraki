import { describe, expect, it } from 'vitest';
import { createUsiSession, type EngineManifest } from 'shared';
import {
  connectEngineHost,
  engineOptions,
  initRequest,
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
  parseBrowserAnalysisSettings,
} from './settings';
import { detectSupport, unsupportedMessage, type BrowserEnv } from './support';

const MANIFEST: EngineManifest = {
  engine: {
    buildId: 'c1b80eaa-a2b7ca71a963',
    upstreamSha: 'c1b80eaa09fe13d5f12b1599d1ae4d53c224de30',
    emsdk: 'emscripten/emsdk:3.1.43',
    target: 'halfkp.noeval',
    exportName: 'YaneuraOu_HalfKP_noeval',
    dir: '1e50e75f5e2b8754',
    files: {
      js: 'yaneuraou.halfkp.noeval.js',
      worker: 'yaneuraou.halfkp.noeval.worker.js',
      wasm: 'yaneuraou.halfkp.noeval.wasm',
    },
    sha256: { js: '1'.repeat(64), worker: '2'.repeat(64), wasm: '3'.repeat(64) },
  },
  eval: {
    name: 'Suisho5',
    file: 'eval/nn-768068f0d534a060.bin',
    bytes: 64_217_066,
    sha256: '7'.repeat(64),
  },
  fvScale: 16,
};

describe('エンジンの URL の組み立て', () => {
  it('manifest から、ホストに渡す絶対 URL を作る', () => {
    expect(engineManifestUrl('https://app.example')).toBe(
      'https://app.example/engine/manifest.json',
    );
    expect(engineUrls('https://app.example', MANIFEST)).toEqual({
      glue: 'https://app.example/engine/1e50e75f5e2b8754/yaneuraou.halfkp.noeval.js',
      // グルーが .worker.js と .wasm を探すディレクトリ（末尾の / まで）
      base: 'https://app.example/engine/1e50e75f5e2b8754/',
      eval: 'https://app.example/engine/eval/nn-768068f0d534a060.bin',
    });
  });

  it('ホストへの初期化の依頼は、manifest の値をそのまま運ぶ', () => {
    expect(initRequest(MANIFEST, engineUrls('http://localhost:5173', MANIFEST))).toEqual({
      type: 'init',
      glueUrl: 'http://localhost:5173/engine/1e50e75f5e2b8754/yaneuraou.halfkp.noeval.js',
      baseUrl: 'http://localhost:5173/engine/1e50e75f5e2b8754/',
      exportName: 'YaneuraOu_HalfKP_noeval',
      evalUrl: 'http://localhost:5173/engine/eval/nn-768068f0d534a060.bin',
      evalBytes: 64_217_066,
      evalSha256: '7'.repeat(64),
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
    expect(manifest?.engine.buildId).toBe('c1b80eaa-a2b7ca71a963');
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

  it('5xx は「置かれていない」と区別して投げる', async () => {
    await expect(
      fetchEngineManifest('https://app.example', respond(502, '')),
    ).rejects.toThrow('502');
  });
});

describe('engineOptions', () => {
  const settings = { maxThreads: 8, hashMb: 64 };

  it('スレッド数は論理コア数と上限の小さいほう', () => {
    expect(engineOptions(MANIFEST, settings, 4).threads).toBe(4);
    expect(engineOptions(MANIFEST, settings, 16).threads).toBe(8);
    expect(engineOptions(MANIFEST, settings, 8).threads).toBe(8);
  });

  it('論理コア数が分からなければ 1 スレッド', () => {
    expect(engineOptions(MANIFEST, settings, undefined).threads).toBe(1);
    expect(engineOptions(MANIFEST, settings, 0).threads).toBe(1);
    expect(engineOptions(MANIFEST, settings, Number.NaN).threads).toBe(1);
  });

  it('評価関数の場所・FV_SCALE・定跡なし・ConsiderationMode を渡す', () => {
    expect(engineOptions(MANIFEST, settings, 6).options).toEqual([
      ['EvalDir', '.'],
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

const INIT: HostRequest = initRequest(MANIFEST, engineUrls('https://app.example', MANIFEST));
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
  it('無い・壊れている値は既定（詳細ページだけ・未同意）', () => {
    expect(parseBrowserAnalysisSettings(null)).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('{')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('null')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(parseBrowserAnalysisSettings('"always"')).toEqual(DEFAULT_BROWSER_ANALYSIS_SETTINGS);
    expect(DEFAULT_BROWSER_ANALYSIS_SETTINGS).toEqual({
      mode: 'detail',
      consentEvalSha256: null,
    });
  });

  it('保存した値を読む', () => {
    const sha = 'ab'.repeat(32);
    expect(
      parseBrowserAnalysisSettings(JSON.stringify({ mode: 'always', consentEvalSha256: sha })),
    ).toEqual({ mode: 'always', consentEvalSha256: sha });
  });

  it('値ごとに既定へ戻す（知らない範囲・ハッシュの形でない同意）', () => {
    expect(
      parseBrowserAnalysisSettings(
        JSON.stringify({ mode: 'background', consentEvalSha256: 'ab'.repeat(32) }),
      ),
    ).toEqual({ mode: 'detail', consentEvalSha256: 'ab'.repeat(32) });
    expect(
      parseBrowserAnalysisSettings(JSON.stringify({ mode: 'always', consentEvalSha256: true })),
    ).toEqual({ mode: 'always', consentEvalSha256: null });
    expect(
      parseBrowserAnalysisSettings(JSON.stringify({ mode: 'always', consentEvalSha256: 'yes' })),
    ).toEqual({ mode: 'always', consentEvalSha256: null });
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
