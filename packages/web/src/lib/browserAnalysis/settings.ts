/**
 * ブラウザ解析の、端末ごとの設定（prd/14 §5.10）。
 *
 * 🔒 **ユーザーの設定ではなく端末に持つ**（localStorage。server には保存しない）。
 * スマホは詳細ページだけ・PC は常に、のように端末で変えたい値で、ダウンロードの同意もその端末のもの。
 */
import { useSyncExternalStore } from 'react';

/** いつ解析するか */
export type AnalysisMode =
  /** 棋譜の詳細ページを開いている間、その棋譜だけ（既定） */
  | 'detail'
  /** どのページを開いていても、未解析の棋譜を消化する */
  | 'always';

export interface BrowserAnalysisSettings {
  mode: AnalysisMode;
  /**
   * ダウンロードに同意した評価関数のハッシュ（manifest の `eval.sha256`）。未同意は null。
   * 🔒 **評価関数ごとに同意を取る**——評価関数が替わると、また数十 MB を落とすことになる
   */
  consentEvalSha256: string | null;
}

export const DEFAULT_BROWSER_ANALYSIS_SETTINGS: BrowserAnalysisSettings = {
  mode: 'detail',
  consentEvalSha256: null,
};

const STORAGE_KEY = 'seseraki:browserAnalysis';

/**
 * localStorage の生の文字列を設定に変換する。
 * 手で書き換えられていても壊れないよう、値ごとに既定へフォールバックする（`lib/thresholds.ts` と同じ作法）。
 */
export function parseBrowserAnalysisSettings(
  raw: string | null,
): BrowserAnalysisSettings {
  if (!raw) return DEFAULT_BROWSER_ANALYSIS_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_BROWSER_ANALYSIS_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_BROWSER_ANALYSIS_SETTINGS;
  }
  const v = parsed as Partial<Record<keyof BrowserAnalysisSettings, unknown>>;
  return {
    mode: v.mode === 'always' || v.mode === 'detail' ? v.mode : 'detail',
    consentEvalSha256:
      typeof v.consentEvalSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(v.consentEvalSha256)
        ? v.consentEvalSha256
        : null,
  };
}

// 設定は常駐の解析（`__root.tsx`）・設定画面・詳細ページの案内が同時に読むので、1 つの store にして
// 変更を全員に伝える（`useState` をそれぞれが持つと、同意しても常駐の側が気づかない）。
let cached: { raw: string | null; value: BrowserAnalysisSettings } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage が使えない環境でも既定値で動かす
    return null;
  }
}

function getSnapshot(): BrowserAnalysisSettings {
  // 保存できない環境では、メモリ上の値（`cached`）がそのまま正になる
  if (cached === null) {
    const raw = readRaw();
    cached = { raw, value: parseBrowserAnalysisSettings(raw) };
  }
  return cached.value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // ほかのタブでの変更（同意・範囲）にも追随する
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setBrowserAnalysisSettings(
  patch: Partial<BrowserAnalysisSettings>,
): void {
  const value = { ...getSnapshot(), ...patch };
  const raw = JSON.stringify(value);
  cached = { raw, value };
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // 保存できなくてもセッション中の変更は効かせる
  }
  for (const listener of [...listeners]) listener();
}

export function useBrowserAnalysisSettings(): BrowserAnalysisSettings {
  return useSyncExternalStore(subscribe, getSnapshot);
}
