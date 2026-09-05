import { accessSync } from "node:fs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig() {
  const enginePath = requireEnv("ENGINE_PATH");

  try {
    accessSync(enginePath);
  } catch {
    throw new Error(`Engine binary not found at: ${enginePath}`);
  }

  // ENGINE_BYOYOMI は ENGINE_MOVETIME に置き換えた。byoyomi は対局用の時間指定で、
  // やねうら王が「floodgate で切れ負けしないため」に NetworkDelay2（既定 1120ms）を
  // 引いてしまい、指定値どおりの思考時間にならない（3000 指定で実測 1883ms、
  // 1120 未満を指定すると下限の 100ms に張り付く）。放置すると解析時間が静かに
  // 変わるので、残っていたら気づけるように警告する。
  if (process.env.ENGINE_BYOYOMI) {
    console.warn(
      "[Config] ENGINE_BYOYOMI は廃止されました。ENGINE_MOVETIME を使ってください（指定値は無視されます）",
    );
  }

  return {
    enginePath,
    engineThreads: Number(optionalEnv("ENGINE_THREADS", "1")),
    engineDepth: Number(optionalEnv("ENGINE_DEPTH", "10")),
    engineMovetime: process.env.ENGINE_MOVETIME
      ? Number(process.env.ENGINE_MOVETIME)
      : undefined,
    // quick 段階の設定（prd/05 §1.1d）。**両方とも未設定なら quick は無効**で、
    // 現状どおり full のみの 1 段階で動く（後方互換）。MultiPV は両段階で共通——
    // 悪手判定と検討盤の再利用が候補手数に依存するため、quick でも本数は減らさない
    engineQuickMovetime: process.env.ENGINE_QUICK_MOVETIME
      ? Number(process.env.ENGINE_QUICK_MOVETIME)
      : undefined,
    engineQuickDepth: process.env.ENGINE_QUICK_DEPTH
      ? Number(process.env.ENGINE_QUICK_DEPTH)
      : undefined,
    engineMultiPv: Number(optionalEnv("ENGINE_MULTIPV", "3")),
    engineHash: Number(optionalEnv("ENGINE_HASH", "128")),
    engineEvalDir: process.env.ENGINE_EVAL_DIR,
    engineBookDir: process.env.ENGINE_BOOK_DIR,
    serverUrl: optionalEnv("SERVER_URL", "http://localhost:4000"),
    pollIntervalMs: Number(optionalEnv("POLL_INTERVAL_MS", "10000")),
    useMock: optionalEnv("USE_MOCK", "true") === "true",
  };
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * この worker が quick 段階を実行できるか（`ENGINE_QUICK_*` のどちらかが設定されている）。
 * poll で server に伝え、持たない worker には quick 未完の棋譜が `full` として渡る
 * （prd/05 §1.1d）。
 */
export function hasQuickProfile(config: Config): boolean {
  return (
    config.engineQuickMovetime !== undefined ||
    config.engineQuickDepth !== undefined
  );
}

/** 段階ごとの探索設定（`go` コマンドと来歴の記録に使う） */
export function profileSettings(
  config: Config,
  profile: "quick" | "full",
): { movetime?: number; depth: number } {
  if (profile === "quick") {
    return {
      movetime: config.engineQuickMovetime,
      // movetime 指定時は depth を使わないが、来歴には「その段階の目標 depth」を残す
      depth: config.engineQuickDepth ?? config.engineDepth,
    };
  }
  return { movetime: config.engineMovetime, depth: config.engineDepth };
}
