import { describe, expect, it } from 'vitest';
import {
  computePlan,
  deleteAssetsStep,
  formatList,
  isValidAssetName,
  isValidRemoteDir,
  normalizeConfig,
  parseStateOutput,
  readStateStep,
  rsyncRsh,
  shellQuote,
  uploadTopLevelStep,
  writeStateStep,
  type DeployConfig,
} from './plan.js';

const cfg: DeployConfig = {
  host: 'example-host',
  root: '/srv/www/app',
  state: '/srv/deploy-state/app',
  distDir: '/work/packages/web/dist',
  controlPath: '/tmp/deploy-static-x/cm',
};

describe('isValidAssetName', () => {
  it.each(['index-AbC123.js', 'style-9f8e.css', 'logo.svg', 'a_b.woff2'])(
    '受け付ける: %s',
    (n) => {
      expect(isValidAssetName(n)).toBe(true);
    },
  );
  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/b',
    '/etc',
    '-rf',
    '--help',
    'a..b',
    'a\nb',
    'a\0b',
  ])('拒否する: %j', (n) => {
    expect(isValidAssetName(n)).toBe(false);
  });
});

describe('isValidRemoteDir / normalizeConfig', () => {
  it('絶対パスだけを受け付ける', () => {
    expect(isValidRemoteDir('/srv/www')).toBe(true);
    expect(isValidRemoteDir('/')).toBe(false);
    expect(isValidRemoteDir('srv/www')).toBe(false);
    expect(isValidRemoteDir('/srv/../etc')).toBe(false);
    expect(isValidRemoteDir('/srv/w w')).toBe(false);
    expect(isValidRemoteDir("/srv/'x")).toBe(false);
    expect(isValidRemoteDir('/srv/$(x)')).toBe(false);
  });
  it('末尾の / を落とす', () => {
    const n = normalizeConfig({
      ...cfg,
      root: '/srv/www/app/',
      state: '/srv/state/',
    });
    expect(n.root).toBe('/srv/www/app');
    expect(n.state).toBe('/srv/state');
  });
  it('state を配信ディレクトリの中に置くと拒否する', () => {
    expect(() =>
      normalizeConfig({ ...cfg, state: '/srv/www/app/.state' }),
    ).toThrow(/外に置く/);
    expect(() => normalizeConfig({ ...cfg, state: '/srv/www/app' })).toThrow(
      /外に置く/,
    );
    expect(() =>
      normalizeConfig({ ...cfg, state: '/srv/www/app2' }),
    ).not.toThrow();
  });
  it('先頭 - の host を拒否する', () => {
    expect(() => normalizeConfig({ ...cfg, host: '-oProxyCommand=x' })).toThrow(
      /host/,
    );
  });
});

describe('shellQuote', () => {
  it('単一引用符で包み、中の引用符を閉じて開き直す', () => {
    expect(shellQuote('abc')).toBe("'abc'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('parseStateOutput', () => {
  it('どちらも無ければ初回', () => {
    expect(parseStateOutput('')).toEqual({ current: null, prev: null });
  });
  it('current と prev を読む（空行・末尾改行なしも許す）', () => {
    expect(
      parseStateOutput('/current\na.js\nb.css\n\n/prev\nold.js\n'),
    ).toEqual({
      current: ['a.js', 'b.css'],
      prev: ['old.js'],
    });
  });
  it('空の current.txt は空の一覧', () => {
    expect(parseStateOutput('/current\n\n')).toEqual({
      current: [],
      prev: null,
    });
  });
  it('不正な名前があれば投げる', () => {
    expect(() => parseStateOutput('/current\n../x\n')).toThrow(/不正/);
    expect(() => parseStateOutput('a.js\n')).toThrow(/読めない/);
  });
});

describe('computePlan', () => {
  const none = { current: null, prev: null };

  it('初回（1 つ前が無い）は何も消さない', () => {
    const plan = computePlan({
      local: ['b.js', 'a.js'],
      state: none,
      remote: ['legacy.js', 'a.js'],
    });
    expect(plan).toEqual({
      current: ['a.js', 'b.js'],
      previous: null,
      rotate: false,
      toDelete: [],
      ignoredRemote: [],
    });
  });

  it('2 世代目: 1 つ前を残し、どちらにも無いものを消す', () => {
    const plan = computePlan({
      local: ['v2.js'],
      state: { current: ['v1.js'], prev: null },
      remote: ['v1.js', 'v2.js', 'legacy.js'],
    });
    expect(plan.previous).toEqual(['v1.js']);
    expect(plan.rotate).toBe(true);
    expect(plan.toDelete).toEqual(['legacy.js']);
  });

  it('3 世代目: 2 つ前（prev.txt の中身）を消す', () => {
    const plan = computePlan({
      local: ['v3.js'],
      state: { current: ['v2.js'], prev: ['v1.js'] },
      remote: ['v1.js', 'v2.js', 'v3.js'],
    });
    expect(plan.previous).toEqual(['v2.js']);
    expect(plan.toDelete).toEqual(['v1.js']);
  });

  it('今回と 1 つ前が重なるファイルは残る', () => {
    const plan = computePlan({
      local: ['shared.js', 'v3.js'],
      state: { current: ['shared.js', 'v2.js'], prev: ['shared.js', 'v1.js'] },
      remote: ['shared.js', 'v1.js', 'v2.js', 'v3.js'],
    });
    expect(plan.toDelete).toEqual(['v1.js']);
  });

  it('同じビルドの再デプロイは世代を進めず、prev.txt を 1 つ前として残す', () => {
    const plan = computePlan({
      local: ['v2.js'],
      state: { current: ['v2.js'], prev: ['v1.js'] },
      remote: ['v1.js', 'v2.js', 'v0.js'],
    });
    expect(plan.rotate).toBe(false);
    expect(plan.previous).toEqual(['v1.js']);
    expect(plan.toDelete).toEqual(['v0.js']);
  });

  it('同じビルドの再デプロイで prev.txt も無ければ消さない', () => {
    const plan = computePlan({
      local: ['v1.js'],
      state: { current: ['v1.js'], prev: null },
      remote: ['x.js'],
    });
    expect(plan.previous).toBeNull();
    expect(plan.toDelete).toEqual([]);
  });

  it('今回の一覧が空なら中止する', () => {
    expect(() =>
      computePlan({
        local: [],
        state: { current: ['v1.js'], prev: null },
        remote: ['v1.js'],
      }),
    ).toThrow(/空/);
  });

  it('今回の一覧に不正な名前があれば中止する', () => {
    expect(() =>
      computePlan({ local: ['ok.js', '-rf'], state: none, remote: [] }),
    ).toThrow(/不正/);
  });

  it('リモートの不正な名前は消さずに報告する', () => {
    const plan = computePlan({
      local: ['v2.js'],
      state: { current: ['v1.js'], prev: null },
      remote: ['-rf', 'v1.js', 'old.js'],
    });
    expect(plan.toDelete).toEqual(['old.js']);
    expect(plan.ignoredRemote).toEqual(['-rf']);
  });

  it('1 つ前の一覧が空でも、今回に無いものは消す', () => {
    const plan = computePlan({
      local: ['v2.js'],
      state: { current: [], prev: null },
      remote: ['v2.js', 'x.js'],
    });
    expect(plan.toDelete).toEqual(['x.js']);
  });
});

describe('コマンドの組み立て', () => {
  it('削除は assets/ に cd してから、クォートした名前を rm -f -- に渡す', () => {
    const step = deleteAssetsStep(cfg, {
      current: ['v2.js'],
      previous: ['v1.js'],
      rotate: true,
      toDelete: ["it's.js", 'old.js'],
      ignoredRemote: [],
    });
    expect(step?.kind).toBe('write');
    expect(step?.argv.at(-1)).toBe(
      `cd -- '/srv/www/app/assets' && rm -f -- 'it'\\''s.js' 'old.js'`,
    );
    expect(step?.argv.at(-2)).toBe('example-host');
  });

  it('消すものが無ければ削除の手順を作らない', () => {
    expect(
      deleteAssetsStep(cfg, {
        current: ['a'],
        previous: null,
        rotate: false,
        toDelete: [],
        ignoredRemote: [],
      }),
    ).toBeNull();
  });

  it('削除の対象に不正な名前が紛れたら投げる', () => {
    expect(() =>
      deleteAssetsStep(cfg, {
        current: ['a'],
        previous: [],
        rotate: true,
        toDelete: ['../x'],
        ignoredRemote: [],
      }),
    ).toThrow();
  });

  it('ssh は ControlMaster のオプションを付ける', () => {
    const argv = readStateStep(cfg).argv;
    expect(argv.slice(0, 7)).toEqual([
      'ssh',
      '-o',
      'ControlPath=/tmp/deploy-static-x/cm',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=120',
    ]);
    expect(rsyncRsh(cfg)).toBe(
      "ssh -o ControlPath='/tmp/deploy-static-x/cm' -o ControlMaster=auto -o ControlPersist=120",
    );
  });

  it('トップレベルの転送は assets/ を除き、--delete を付けない', () => {
    const argv = uploadTopLevelStep(cfg).argv;
    expect(argv).toContain('--exclude=/assets/');
    expect(argv.some((a) => a.startsWith('--delete'))).toBe(false);
    expect(argv.slice(-2)).toEqual([
      '/work/packages/web/dist/',
      'example-host:/srv/www/app/',
    ]);
  });

  it('一覧の更新は、ずらすときだけ current → prev の mv を含む', () => {
    const base = {
      current: ['a.js', 'b.js'],
      previous: null,
      toDelete: [],
      ignoredRemote: [],
    };
    const rotated = writeStateStep(cfg, { ...base, rotate: true });
    expect(rotated.argv.at(-1)).toContain(
      `mv -f -- '/srv/deploy-state/app/current.txt' '/srv/deploy-state/app/prev.txt'`,
    );
    expect(rotated.stdin).toBe(formatList(['a.js', 'b.js']));
    expect(rotated.stdin).toBe('a.js\nb.js\n');
    const first = writeStateStep(cfg, { ...base, rotate: false });
    expect(first.argv.at(-1)).not.toContain('prev.txt');
  });
});
