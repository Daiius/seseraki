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

/**
 * `ENGINE_FV_SCALE`（任意・正の整数。prd/05 §1.3）。未設定・空ならエンジンの既定に任せる（dev の MATERIAL など）。
 * 🔴 誤った値は起動時に落とす——黙って既定に戻すと、評価値の尺度が変わったまま解析が溜まる。
 */
export function parseFvScale(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ENGINE_FV_SCALE must be a positive integer: ${raw}`);
  }
  return value;
}

/**
 * `ENGINE_EVAL_SHA256`（任意。評価関数 `nn.bin` の sha256・小文字 16 進 64 桁）。来歴の `evalHash` に載せる
 * （prd/05 §1.2・prd/14 §5.9）。本番イメージが照合した値を渡す。未設定・空なら送らない。
 */
export function parseEvalSha256(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`ENGINE_EVAL_SHA256 must be a sha256 hex digest: ${raw}`);
  }
  return value;
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
    // 評価関数の尺度と識別（prd/05 §1.2・§1.3）。本番イメージ（Dockerfile.prod）が渡す
    engineFvScale: parseFvScale(process.env.ENGINE_FV_SCALE),
    engineEvalSha256: parseEvalSha256(process.env.ENGINE_EVAL_SHA256),
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

/**
 * 報告の来歴（`runs`）に添える評価関数の項目（prd/14 §5.9・prd/16 §3.1）。
 * 設定されているものだけを載せる（未設定の worker は今までどおり項目なしで送る）。
 * 🔒 手元 worker の経路では server はこれを上書き・再開の条件に使わない（prd/05 §1.1d）。
 */
export function evalProvenance(
  config: Pick<Config, "engineFvScale" | "engineEvalSha256">,
): { evalHash?: string; fvScale?: number } {
  return {
    ...(config.engineEvalSha256 !== undefined
      ? { evalHash: config.engineEvalSha256 }
      : {}),
    ...(config.engineFvScale !== undefined
      ? { fvScale: config.engineFvScale }
      : {}),
  };
}
