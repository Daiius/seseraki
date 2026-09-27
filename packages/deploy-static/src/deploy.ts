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
  writePendingStep,
  writeStateStep,
  type DeployConfig,
  type Plan,
  type Step,
} from './plan.js';

export type RunResult = { code: number; stdout: string };

/**
 * 手順を 1 つ実行する。終了コードと標準出力を返す（標準エラーは呼び出し側に流してよい）。
 * `signal` が中断されたら、実行中の子を止めて reject する。
 */
export type Runner = (step: Step, signal?: AbortSignal) => Promise<RunResult>;

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

async function runStep(
  runner: Runner,
  step: Step,
  signal: AbortSignal | undefined,
): Promise<string> {
  // 中断を受けたら、次の手順へは進まない。
  signal?.throwIfAborted();
  const { code, stdout } = await runner(step, signal);
  signal?.throwIfAborted();
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
  /** 中断（SIGINT / SIGTERM）。中断後は次の手順へ進まない。 */
  signal?: AbortSignal;
};

/**
 * 1. リモートの世代の一覧と assets/ の一覧を読む
 * 2. 今回の一覧を pending.txt に書く（公開しかけた世代の記録）
 * 3. assets/ を送る（削除なし）→ index.html などトップレベルを最後に送る
 * 4. prev.txt・current.txt を書き、pending.txt を消す
 * 5. 今回 ∪ 1 つ前に無い assets/ のファイルを消す（初回は消さない）
 *
 * どこかで失敗したら投げて、それ以降（一覧の更新・削除）は行わない。
 */
export async function deploy(opts: DeployOptions): Promise<Plan> {
  const { cfg, log } = opts;
  const run = (step: Step) => runStep(opts.runner, step, opts.signal);

  const state = parseStateOutput(await run(readStateStep(cfg)));
  const remote = parseLines(await run(listAssetsStep(cfg)));
  const plan = computePlan({ local: opts.localAssets, state, remote });

  log(describePlan(plan, cfg));
  if (!opts.apply) {
    log('dry-run: 何も書き込んでいない。実行するには --apply を付ける');
    return plan;
  }

  await run(writePendingStep(cfg, plan));
  log('assets/ を送る…');
  await run(uploadAssetsStep(cfg));
  log('トップレベル（index.html など）を送る…');
  await run(uploadTopLevelStep(cfg));
  log('世代の一覧を更新する…');
  await run(writeStateStep(cfg, plan));
  const del = deleteAssetsStep(cfg, plan);
  if (del !== null) {
    log(`古い assets/ を ${plan.toDelete.length} ファイル消す…`);
    await run(del);
  }
  log('完了');
  return plan;
}
