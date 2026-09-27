// 計画（plan.ts）を runner に流す薄い層。runner を差し替えれば本物の ssh / rsync を呼ばずに
// 手順の順序・途中失敗・dry-run を確かめられる（deploy.test.ts）。

import {
  computePlan,
  deleteAssetsStep,
  describePlan,
  listAssetsStep,
  parseLines,
  parseStateOutput,
  readStateStep,
  uploadAssetsStep,
  uploadTopLevelStep,
  writeStateStep,
  type DeployConfig,
  type Plan,
  type Step,
} from './plan.js';

export type RunResult = { code: number; stdout: string };

/** 手順を 1 つ実行する。終了コードと標準出力を返す（標準エラーは呼び出し側に流してよい）。 */
export type Runner = (step: Step) => Promise<RunResult>;

export class StepFailedError extends Error {
  constructor(
    readonly step: Step,
    readonly code: number,
  ) {
    super(
      `手順 ${step.label} が失敗した（終了コード ${code}）。以降の手順は行わない`,
    );
    this.name = 'StepFailedError';
  }
}

async function runStep(runner: Runner, step: Step): Promise<string> {
  const { code, stdout } = await runner(step);
  if (code !== 0) throw new StepFailedError(step, code);
  return stdout;
}

export type DeployOptions = {
  cfg: DeployConfig;
  /** 今回送る `assets/` のファイル名（ローカルの一覧）。 */
  localAssets: string[];
  /** false なら計画の表示だけで、書き込む手順は 1 つも呼ばない。 */
  apply: boolean;
  runner: Runner;
  log: (message: string) => void;
};

/**
 * 1. リモートの世代の一覧と assets/ の一覧を読む
 * 2. assets/ を送る（削除なし）
 * 3. index.html などトップレベルを最後に送る
 * 4. current.txt を prev.txt にずらし、今回の一覧を current.txt に書く
 * 5. 今回 ∪ 1 つ前に無い assets/ のファイルを消す（初回は消さない）
 *
 * どこかで失敗したら投げて、それ以降（一覧の更新・削除）は行わない。
 */
export async function deploy(opts: DeployOptions): Promise<Plan> {
  const { cfg, runner, log } = opts;

  const state = parseStateOutput(await runStep(runner, readStateStep(cfg)));
  const remote = parseLines(await runStep(runner, listAssetsStep(cfg)));
  const plan = computePlan({ local: opts.localAssets, state, remote });

  log(describePlan(plan, cfg));
  if (!opts.apply) {
    log('dry-run: 何も書き込んでいない。実行するには --apply を付ける');
    return plan;
  }

  log('assets/ を送る…');
  await runStep(runner, uploadAssetsStep(cfg));
  log('トップレベル（index.html など）を送る…');
  await runStep(runner, uploadTopLevelStep(cfg));
  log('世代の一覧を更新する…');
  await runStep(runner, writeStateStep(cfg, plan));
  const del = deleteAssetsStep(cfg, plan);
  if (del !== null) {
    log(`古い assets/ を ${plan.toDelete.length} ファイル消す…`);
    await runStep(runner, del);
  }
  log('完了');
  return plan;
}
