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
