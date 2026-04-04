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

  return {
    enginePath,
    engineThreads: Number(optionalEnv("ENGINE_THREADS", "1")),
    engineDepth: Number(optionalEnv("ENGINE_DEPTH", "10")),
    serverUrl: optionalEnv("SERVER_URL", "http://localhost:4000"),
    pollIntervalMs: Number(optionalEnv("POLL_INTERVAL_MS", "10000")),
    useMock: optionalEnv("USE_MOCK", "true") === "true",
  };
}

export type Config = ReturnType<typeof loadConfig>;
