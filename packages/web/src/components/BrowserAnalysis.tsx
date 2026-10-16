import { useEffect } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { forgetMe } from '../lib/auth';
import {
  engineEntryDownloadBytes,
  engineEntryOf,
  type EngineManifest,
} from 'shared';
import {
  getBrowserAnalysisSettings,
  hasConsented,
  setBrowserAnalysisSettings,
  useBrowserAnalysisSettings,
  withConsent,
  type BrowserAnalysisSettings,
} from '../lib/browserAnalysis/settings';
import {
  pokeBrowserAnalysis,
  requestBrowserAnalysisRestart,
  setAnalysisFocus,
  useBrowserAnalysisState,
} from '../lib/browserAnalysis/store';
import { unsupportedMessage } from '../lib/browserAnalysis/support';

/**
 * ブラウザ解析の常駐（prd/14 §5.10）。`__root.tsx` に置き、どのページでも生きる。何も描かない。
 *
 * 🔒 **`enabled`（= 担当がブラウザ）のときだけ動かす。** サーバーで解析するユーザーでは、
 * エンジンの一覧の取得も、エンジンの読み込みも一切しない。
 * 範囲・同意（端末の設定）が変わったら、止めて起動し直す。評価関数の選択は、同意済みのものどうしなら
 * 起動し直さない（常駐が次の解析の開始で読む）。同意していないものに切り替えたら、止めて同意を求める。
 */
export function BrowserAnalysisHost({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const settings = useBrowserAnalysisSettings();
  const { mode } = settings;
  const { restartNonce, manifest } = useBrowserAnalysisState();
  // 同意が増えたら起動し直す（同意を待っていた評価関数で解析を始める）
  const consentKey = settings.consentedEvalSha256s.join(',');
  // 同意していない評価関数に切り替えたら、すぐ止めて同意を求める（前の評価関数でも解析しない。prd/14 §5.10）。
  // 同意済みの評価関数どうしの切り替えでは起動し直さない——常駐が次の解析の開始で読み、エンジンを作り直す
  const unconsentedSha256 = manifest
    ? unconsentedSelection(manifest, settings)
    : null;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    // 解析の本体（runner・USI の解釈・報告の検証）は、動かすときにだけ読み込む
    // ——サーバーで解析するユーザーの初回の読み込みに載せない
    void import('../lib/browserAnalysis/controller')
      .then(({ startBrowserAnalysis }) => {
        if (stopped) return;
        stop = startBrowserAnalysis({
          mode,
          // 完了・失敗した棋譜の表示を入れ替える（一覧のバッジ・詳細の解析結果はローダー経由）
          onSettled: () => void router.invalidate(),
          // 担当が変わっていた・ログインが切れていた。`GET /api/me` を取り直す（ルートの beforeLoad が叩く）
          onAccountChanged: () => {
            forgetMe();
            void router.invalidate();
          },
        });
      })
      .catch((error: unknown) => {
        console.warn('[browser-analysis] failed to load the controller', error);
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [enabled, mode, consentKey, unconsentedSha256, restartNonce, router]);

  // ページを移ったら、待機中の解析に次の棋譜を選び直させる（棋譜を登録した直後など）
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    pokeBrowserAnalysis();
  }, [pathname]);

  return null;
}

/**
 * 詳細ページが「いま開いている、解析を待っている棋譜」を常駐の解析に知らせる（最優先で解析される）。
 * 待っていない（解析済み・失敗・指し手列なし・担当がサーバー）なら null を渡す。
 */
export function useBrowserAnalysisFocus(kifuNo: number | null): void {
  useEffect(() => {
    setAnalysisFocus(kifuNo);
    return () => setAnalysisFocus(null);
  }, [kifuNo]);
}

/** 選んだ評価関数が同意済みでなければ、その `nn.bin` の sha256。同意済みなら null */
function unconsentedSelection(
  manifest: EngineManifest,
  settings: BrowserAnalysisSettings,
): string | null {
  const entry = engineEntryOf(manifest, settings.evalId);
  return hasConsented(settings, entry.nn.sha256) ? null : entry.nn.sha256;
}

/** バイト数を「約 8.7MB」の形にする（10MB 未満は小数 1 桁） */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 10 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
}

/**
 * ブラウザ解析の案内（同意・準備中・解析できない理由）。解析が普通に動いている間は何も出さない。
 *
 * 🔒 **その端末での初回は、ダウンロードの大きさを示して明示の開始を求める**（prd/14 §5.10）。
 * ボタンを押すまで、評価関数は落とし始めない。
 *
 * 文言に内部の用語（担当・段階・世代）は出さない。
 */
export function BrowserAnalysisNotice() {
  const { phase, manifest, unsupported, download, error } =
    useBrowserAnalysisState();
  const settings = useBrowserAnalysisSettings();

  switch (phase) {
    case 'needs-consent': {
      if (!manifest) return null;
      // 同意は選んでいる評価関数ごと（prd/14 §5.10）
      const entry = engineEntryOf(manifest, settings.evalId);
      return (
        <div
          role="status"
          className="alert shadow-lg py-2 flex flex-col items-stretch gap-2"
        >
          <div className="text-sm">
            棋譜をこのブラウザで解析します。最初に解析エンジンのデータ（評価関数 {entry.name}・約{' '}
            {megabytes(engineEntryDownloadBytes(entry))}）をダウンロードします。
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm self-end"
            onClick={() =>
              setBrowserAnalysisSettings({
                consentedEvalSha256s: withConsent(
                  getBrowserAnalysisSettings().consentedEvalSha256s,
                  entry.nn.sha256,
                ),
              })
            }
          >
            ダウンロードして解析する
          </button>
        </div>
      );
    }
    case 'loading': {
      const total = download?.total ?? 0;
      const loaded = download?.loaded ?? 0;
      return (
        <div
          role="status"
          className="alert shadow-lg py-2 flex flex-col items-stretch gap-1"
        >
          <div className="text-sm">
            解析エンジンを準備しています
            {total > 0 && (
              <span className="ms-2 tabular-nums text-base-content/70">
                {megabytes(loaded)} / {megabytes(total)}
              </span>
            )}
          </div>
          <progress
            className="progress progress-info w-full"
            value={total > 0 ? loaded : undefined}
            max={total > 0 ? total : undefined}
            aria-label="解析エンジンのダウンロード"
          />
        </div>
      );
    }
    case 'unsupported':
      return (
        <div role="status" className="alert alert-warning shadow-lg py-2 text-sm">
          {unsupportedMessage(unsupported)}
        </div>
      );
    case 'no-engine':
      return (
        <div role="status" className="alert alert-warning shadow-lg py-2 text-sm">
          解析エンジンが配置されていないため、解析できません。
        </div>
      );
    case 'error':
      return (
        <div
          role="alert"
          className="alert alert-error shadow-lg py-2 flex flex-col items-stretch gap-1"
        >
          <div className="font-semibold">解析を続けられません</div>
          <div className="text-sm [overflow-wrap:anywhere] opacity-90">{error}</div>
          <button
            type="button"
            className="btn btn-sm self-end"
            onClick={requestBrowserAnalysisRestart}
          >
            やり直す
          </button>
        </div>
      );
    default:
      return null;
  }
}
