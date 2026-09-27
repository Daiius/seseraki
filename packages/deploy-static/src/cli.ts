// web の静的ビルドを配信ディレクトリへ置く。既定は dry-run（計画の表示のみ）、--apply で書き込む。
//
//   DEPLOY_STATIC_HOST   ssh の宛先（~/.ssh/config の Host 名など）
//   DEPLOY_STATIC_ROOT   配信ディレクトリ（リモートの絶対パス）
//   DEPLOY_STATIC_STATE  世代の一覧を置く配信外のディレクトリ（リモートの絶対パス）
//   DEPLOY_STATIC_DIST   ローカルのビルド成果物（省略時は packages/web/dist）
//
// パスフレーズの入力を 1 回で済ませるため ssh の ControlMaster を使い、終了時（失敗・中断でも）に閉じる。

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy, StepFailedError } from './deploy.js';
import { closeMasterArgv, normalizeConfig, type DeployConfig } from './plan.js';
import { runQuietly, spawnRunner } from './runner.js';

const USAGE = `usage: tsx src/cli.ts [--apply]
  既定は dry-run（計画の表示のみ）。--apply で実際に書き込む。
  環境変数: DEPLOY_STATIC_HOST / DEPLOY_STATIC_ROOT / DEPLOY_STATIC_STATE（必須）、DEPLOY_STATIC_DIST（任意）`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`環境変数 ${name} が未設定`);
  return v;
}

/** ローカルの assets/ 直下のファイル名。サブディレクトリがあれば中止する（一覧で追えないため）。 */
function listLocalAssets(distDir: string): string[] {
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`${distDir}/index.html が無い。先に web をビルドする`);
  }
  const entries = readdirSync(join(distDir, 'assets'), { withFileTypes: true });
  const dirs = entries.filter((e) => !e.isFile());
  if (dirs.length > 0) {
    throw new Error(
      `assets/ にファイル以外がある: ${dirs.map((e) => e.name).join(', ')}`,
    );
  }
  return entries.map((e) => e.name);
}

async function main(argv: string[]): Promise<number> {
  const unknown = argv.filter(
    (a) => a !== '--apply' && a !== '--help' && a !== '-h',
  );
  if (argv.includes('--help') || argv.includes('-h') || unknown.length > 0) {
    if (unknown.length > 0) console.error(`不明な引数: ${unknown.join(' ')}`);
    console.error(USAGE);
    return unknown.length > 0 ? 2 : 0;
  }
  const apply = argv.includes('--apply');

  const defaultDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const distDir = resolve(process.env.DEPLOY_STATIC_DIST || defaultDist);
  const localAssets = listLocalAssets(distDir);

  const checked = normalizeConfig({
    host: requireEnv('DEPLOY_STATIC_HOST'),
    root: requireEnv('DEPLOY_STATIC_ROOT'),
    state: requireEnv('DEPLOY_STATIC_STATE'),
    distDir,
    controlPath: '',
  });
  // 検証が通ってから作る（失敗で一時ディレクトリを残さないため）。
  const controlDir = mkdtempSync(join(tmpdir(), 'deploy-static-'));
  const cfg: DeployConfig = { ...checked, controlPath: join(controlDir, 'cm') };

  // Ctrl+C は子の ssh / rsync にも届いて失敗として返ってくるので、ここでは即終了せず
  // finally の後片付け（ControlMaster を閉じる）まで走らせる。
  const onSignal = () =>
    console.error('\n中断を受け付けた。後片付けをして終わる');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log(
    `${apply ? 'apply' : 'dry-run'}: ${distDir} → ${cfg.host}:${cfg.root}`,
  );
  try {
    await deploy({
      cfg,
      localAssets,
      apply,
      runner: spawnRunner,
      log: (m) => console.log(m),
    });
    return 0;
  } catch (e) {
    if (e instanceof StepFailedError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  } finally {
    if (existsSync(cfg.controlPath)) await runQuietly(closeMasterArgv(cfg));
    rmSync(controlDir, { recursive: true, force: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
