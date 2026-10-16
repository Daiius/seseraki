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

/**
 * どれだけ端末の力を使うか（prd/14 §5.10 負荷の設定）。スレッド数の決め方は `engineHost.ts` の `analysisThreads`
 */
export type AnalysisLoad =
  /** 全力（既定）: 論理コア数と server の上限の小さいほう */
  | 'max'
  /** 控えめ: 全力の半分（最低 1） */
  | 'gentle';

export interface BrowserAnalysisSettings {
  mode: AnalysisMode;
  /** 負荷。この設定が無かった頃の値（`load` が無い）は全力として読む */
  load: AnalysisLoad;
  /**
   * 選んだ評価関数（manifest のエントリの `id`。prd/14 §5.5）。未選択は null。
   * 未選択・manifest に無い id は manifest の既定として読む（`shared` の `engineEntryOf`）
   */
  evalId: string | null;
  /**
   * ダウンロードに同意した評価関数のハッシュ（manifest のエントリの `nn.sha256`）の集合。
   * 🔒 **評価関数ごとに同意を取る**——大きさが評価関数ごとに違い、替わればまた落とすことになる。
   * 一度同意した評価関数に戻すときは求めない
   */
  consentedEvalSha256s: readonly string[];
}

export const DEFAULT_BROWSER_ANALYSIS_SETTINGS: BrowserAnalysisSettings = {
  mode: 'detail',
  load: 'max',
  evalId: null,
  consentedEvalSha256s: [],
};

const STORAGE_KEY = 'seseraki:browserAnalysis';

/** 覚えておく同意の数の上限（古いものから捨てる。評価関数の数より十分に大きい） */
const MAX_CONSENTS = 16;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EVAL_ID_PATTERN = /^[a-z0-9]{1,32}$/;

/** その評価関数（`nn.sha256`）のダウンロードに同意済みか */
export function hasConsented(
  settings: Pick<BrowserAnalysisSettings, 'consentedEvalSha256s'>,
  sha256: string,
): boolean {
  return settings.consentedEvalSha256s.includes(sha256);
}

/** 同意を足した集合（重複させない・上限を超えたら古いものから捨てる） */
export function withConsent(
  consented: readonly string[],
  sha256: string,
): string[] {
  return [...consented.filter((s) => s !== sha256), sha256].slice(-MAX_CONSENTS);
}

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
  const v = parsed as Partial<
    Record<keyof BrowserAnalysisSettings | 'consentEvalSha256', unknown>
  >;
  let consented: string[] = [];
  if (Array.isArray(v.consentedEvalSha256s)) {
    for (const sha of v.consentedEvalSha256s) {
      if (typeof sha === 'string' && SHA256_PATTERN.test(sha)) {
        consented = withConsent(consented, sha);
      }
    }
  }
  // 前の形（同意 1 つ。水匠5 の頃）は集合の 1 つとして読む（配らなくなった評価関数なら使われないだけ）
  if (
    typeof v.consentEvalSha256 === 'string' &&
    SHA256_PATTERN.test(v.consentEvalSha256) &&
    !consented.includes(v.consentEvalSha256)
  ) {
    consented = [v.consentEvalSha256, ...consented].slice(-MAX_CONSENTS);
  }
  return {
    mode: v.mode === 'always' || v.mode === 'detail' ? v.mode : 'detail',
    load: v.load === 'gentle' || v.load === 'max' ? v.load : 'max',
    evalId:
      typeof v.evalId === 'string' && EVAL_ID_PATTERN.test(v.evalId) ? v.evalId : null,
    consentedEvalSha256s: consented,
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

/**
 * 今の設定（React の外から読む。常駐の解析が、エンジンを作るたびに負荷の設定を読み直すのに使う）
 */
export function getBrowserAnalysisSettings(): BrowserAnalysisSettings {
  return getSnapshot();
}

export function useBrowserAnalysisSettings(): BrowserAnalysisSettings {
  return useSyncExternalStore(subscribe, getSnapshot);
}
