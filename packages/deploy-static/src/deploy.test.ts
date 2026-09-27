import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploy, StepFailedError, type Runner } from './deploy.js';
import type { DeployConfig, Step } from './plan.js';
import { spawnRunner } from './runner.js';

const cfg: DeployConfig = {
  host: 'example-host',
  root: '/srv/www/app',
  state: '/srv/deploy-state/app',
  distDir: '/work/packages/web/dist',
  controlPath: '/tmp/deploy-static-x/cm',
};

/** 呼ばれた手順を記録し、読む手順には決まった出力を返す偽の runner。 */
function fakeRunner(
  opts: { state?: string; remote?: string; failAt?: string } = {},
) {
  const calls: Step[] = [];
  const runner: Runner = async (step) => {
    calls.push(step);
    if (step.label === opts.failAt) return { code: 23, stdout: '' };
    if (step.label === 'read-state')
      return { code: 0, stdout: opts.state ?? '' };
    if (step.label === 'list-assets')
      return { code: 0, stdout: opts.remote ?? '' };
    return { code: 0, stdout: '' };
  };
  return { runner, calls };
}

const quiet = () => {};

describe('deploy（偽の runner）', () => {
  const secondGen = {
    state: '/current\nv1.js\n',
    remote: 'v1.js\nlegacy.js\n',
  };

  it('apply: 読む → assets → トップレベル → 一覧 → 削除 の順に呼ぶ', async () => {
    const { runner, calls } = fakeRunner(secondGen);
    const plan = await deploy({
      cfg,
      localAssets: ['v2.js'],
      apply: true,
      runner,
      log: quiet,
    });
    expect(calls.map((c) => c.label)).toEqual([
      'read-state',
      'list-assets',
      'upload-assets',
      'upload-top-level',
      'write-state',
      'delete-assets',
    ]);
    expect(plan.toDelete).toEqual(['legacy.js']);
  });

  it('初回は削除の手順を呼ばない', async () => {
    const { runner, calls } = fakeRunner({ state: '', remote: 'legacy.js\n' });
    await deploy({
      cfg,
      localAssets: ['v1.js'],
      apply: true,
      runner,
      log: quiet,
    });
    expect(calls.map((c) => c.label)).not.toContain('delete-assets');
    expect(calls.map((c) => c.label)).toContain('write-state');
  });

  it('dry-run では書き込む手順を 1 つも呼ばない', async () => {
    const { runner, calls } = fakeRunner(secondGen);
    const logs: string[] = [];
    const plan = await deploy({
      cfg,
      localAssets: ['v2.js'],
      apply: false,
      runner,
      log: (m) => logs.push(m),
    });
    expect(calls.map((c) => c.label)).toEqual(['read-state', 'list-assets']);
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
    expect(calls.some((c) => c.argv[0] === 'rsync')).toBe(false);
    expect(plan.toDelete).toEqual(['legacy.js']);
    expect(logs.join('\n')).toContain('assets/legacy.js');
    expect(logs.join('\n')).toContain('dry-run');
  });

  it.each([
    'read-state',
    'list-assets',
    'upload-assets',
    'upload-top-level',
    'write-state',
    'delete-assets',
  ])('%s で失敗したら、それ以降を呼ばない', async (failAt) => {
    const { runner, calls } = fakeRunner({ ...secondGen, failAt });
    await expect(
      deploy({ cfg, localAssets: ['v2.js'], apply: true, runner, log: quiet }),
    ).rejects.toBeInstanceOf(StepFailedError);
    expect(calls.at(-1)?.label).toBe(failAt);
  });

  it('今回の一覧が空なら、書き込む前に中止する', async () => {
    const { runner, calls } = fakeRunner(secondGen);
    await expect(
      deploy({ cfg, localAssets: [], apply: true, runner, log: quiet }),
    ).rejects.toThrow(/空/);
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
  });

  it('壊れた current.txt を根拠に削除しない', async () => {
    const { runner, calls } = fakeRunner({
      state: '/current\n../etc\n',
      remote: 'v1.js\n',
    });
    await expect(
      deploy({ cfg, localAssets: ['v2.js'], apply: true, runner, log: quiet }),
    ).rejects.toThrow(/不正/);
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
  });
});

// 組み立てたシェルコマンドが本当に動くかを、ローカルの一時ディレクトリで確かめる。
// ssh は `sh -c <リモートコマンド>` に、rsync は `-e` と `host:` を外したローカル転送に読み替える。
const hasRsync = spawnSync('rsync', ['--version']).status === 0;

function localRunner(host: string): Runner {
  return (step) => {
    let argv = step.argv;
    if (argv[0] === 'ssh') {
      argv = ['sh', '-c', argv.at(-1)!];
    } else if (argv[0] === 'rsync') {
      const out: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-e') {
          i++;
          continue;
        }
        out.push(
          argv[i]!.startsWith(`${host}:`)
            ? argv[i]!.slice(host.length + 1)
            : argv[i]!,
        );
      }
      argv = out;
    }
    return spawnRunner({ ...step, argv });
  };
}

describe.skipIf(!hasRsync)('deploy（ローカルの一時ディレクトリで実行）', () => {
  let work = '';
  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  function build(dist: string, assets: string[], index: string) {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(join(dist, 'assets'), { recursive: true });
    for (const a of assets) writeFileSync(join(dist, 'assets', a), a);
    writeFileSync(join(dist, 'index.html'), index);
  }

  it('3 回デプロイすると、今回と 1 つ前だけが残る', async () => {
    work = mkdtempSync(join(tmpdir(), 'deploy-static-test-'));
    const root = join(work, 'www');
    const state = join(work, 'state');
    const dist = join(work, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'legacy.js'), 'legacy');
    writeFileSync(join(root, 'assets', "it's odd.js"), 'odd');
    const c: DeployConfig = {
      host: 'local',
      root,
      state,
      distDir: dist,
      controlPath: join(work, 'cm'),
    };
    const runner = localRunner('local');
    const run = (assets: string[], apply = true) =>
      deploy({ cfg: c, localAssets: assets, apply, runner, log: quiet });
    const remoteAssets = () => readdirSync(join(root, 'assets')).sort();

    build(dist, ['shared.js', 'v1.js'], 'v1');
    await run(['shared.js', 'v1.js']);
    // 初回は前からあったものを消さない。
    expect(remoteAssets()).toEqual([
      "it's odd.js",
      'legacy.js',
      'shared.js',
      'v1.js',
    ]);
    expect(readFileSync(join(state, 'current.txt'), 'utf8')).toBe(
      'shared.js\nv1.js\n',
    );
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('v1');

    build(dist, ['shared.js', 'v2.js'], 'v2');
    // dry-run は何も変えない。
    await run(['shared.js', 'v2.js'], false);
    expect(remoteAssets()).toEqual([
      "it's odd.js",
      'legacy.js',
      'shared.js',
      'v1.js',
    ]);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('v1');

    await run(['shared.js', 'v2.js']);
    expect(remoteAssets()).toEqual(['shared.js', 'v1.js', 'v2.js']);
    expect(readFileSync(join(state, 'prev.txt'), 'utf8')).toBe(
      'shared.js\nv1.js\n',
    );
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('v2');

    build(dist, ['shared.js', 'v3.js'], 'v3');
    await run(['shared.js', 'v3.js']);
    expect(remoteAssets()).toEqual(['shared.js', 'v2.js', 'v3.js']);

    // 同じビルドの再デプロイでは 1 つ前（v2）が消えない。
    await run(['shared.js', 'v3.js']);
    expect(remoteAssets()).toEqual(['shared.js', 'v2.js', 'v3.js']);
    expect(readFileSync(join(state, 'prev.txt'), 'utf8')).toBe(
      'shared.js\nv2.js\n',
    );
  });
});
