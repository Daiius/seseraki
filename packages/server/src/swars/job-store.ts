export type ImportedEntry = { id: number; gameKey: string };
export type ErrorEntry = { gameKey: string; error: string };
export type JobErrorKind = 'cookie_expired' | 'generic';

export type JobState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | {
      status: 'done';
      startedAt: string;
      finishedAt: string;
      imported: ImportedEntry[];
      skipped: string[];
      errors: ErrorEntry[];
    }
  | {
      status: 'error';
      startedAt: string;
      finishedAt: string;
      errorKind: JobErrorKind;
      errorMessage: string;
    };

export type JobResult = {
  imported: ImportedEntry[];
  skipped: string[];
  errors: ErrorEntry[];
};

let currentJob: JobState = { status: 'idle' };

export function getJob(): JobState {
  return currentJob;
}

/** テスト用。プロセス状態をリセット */
export function resetJob(): void {
  currentJob = { status: 'idle' };
}

function classifyError(err: unknown): JobErrorKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Cookie expired')) return 'cookie_expired';
  return 'generic';
}

/**
 * シングルトン合流ガード。
 * 実行中なら現在の状態を返し runner は起動しない。
 * idle/done/error なら新規に runner をバックグラウンド起動し running 状態を返す。
 */
export function startJob(runner: () => Promise<JobResult>): JobState {
  if (currentJob.status === 'running') return currentJob;

  const startedAt = new Date().toISOString();
  currentJob = { status: 'running', startedAt };

  void runner().then(
    (result) => {
      currentJob = {
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
      };
    },
    (err: unknown) => {
      currentJob = {
        status: 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        errorKind: classifyError(err),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    },
  );

  return currentJob;
}
