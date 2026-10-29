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
import { megabytes } from '../lib/browserAnalysis/format';
import {
  answerDrillEngineConsent,
  askDrillEngineConsent,
  useDrillEngineState,
} from '../lib/browserAnalysis/drillEngine';
import {
  answerStudyEvalConsent,
  useStudyEvalConsentAsking,
} from '../lib/browserAnalysis/studyEval';

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
 * 詰将棋の判定だけの常駐（担当がサーバーの利用者。prd/13 §5.5）。出題の画面に置く。何も描かない。
 *
 * 🔒 **`enabled`（= 担当がサーバー）で、初めて詰将棋の 1 手を指した後（`requestDrillEngine`）だけ動かす。**
 * それまではエンジンの一覧も取りに行かない。全局面解析は回さない（判定の読みを受け持つだけ）。
 * 同意が増えたら止めて起動し直す。同意の前なら、その場で同意を求める（{@link DrillEngineConsent} が案内を出す）。
 * 出題の画面を離れたら止める（エンジンも止まる）
 */
export function DrillGradingHost({ enabled }: { enabled: boolean }) {
  const { wanted, asking, declined } = useDrillEngineState();
  const settings = useBrowserAnalysisSettings();
  const { restartNonce, phase, manifest } = useBrowserAnalysisState();
  const consentKey = settings.consentedEvalSha256s.join(',');
  const active = enabled && wanted;
  // 同意した直後は、常駐が起動し直すまで同意の前の状態が残る。選んだ評価関数に同意済みなら聞き直さない
  const needsConsent =
    phase === 'needs-consent' && manifest !== null && unconsentedSelection(manifest, settings) !== null;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    void import('../lib/browserAnalysis/controller')
      .then(({ startDrillGrading }) => {
        if (stopped) return;
        stop = startDrillGrading();
      })
      .catch((error: unknown) => {
        console.warn('[browser-analysis] failed to load the controller', error);
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [active, consentKey, settings.evalId, restartNonce]);

  // 🔒 同意は初めて詰将棋を解くとき（最初の 1 手を指したとき）に求める。断ったらこのタブでは聞き直さない
  useEffect(() => {
    if (active && needsConsent && !asking && !declined) void askDrillEngineConsent();
  }, [active, needsConsent, asking, declined]);

  return null;
}

/**
 * 詰将棋の判定のための同意の案内（担当がサーバーの利用者。prd/13 §5.5）。同意を求めている間だけ出す。
 * 断ったらサーバーで判定する。文言に内部の用語（担当・名指し）は出さない
 */
export function DrillEngineConsent() {
  const { asking } = useDrillEngineState();
  const { manifest } = useBrowserAnalysisState();
  const settings = useBrowserAnalysisSettings();
  if (!asking || !manifest) return null;
  const entry = engineEntryOf(manifest, settings.evalId);
  return (
    <div role="status" className="alert shadow-lg py-2 flex flex-col items-stretch gap-2">
      <div className="text-sm">
        詰将棋の判定をこのブラウザで行うと、その場で結果が出ます。最初に解析エンジンのデータ（評価関数 {entry.name}・約{' '}
        {megabytes(engineEntryDownloadBytes(entry))}）をダウンロードします。
      </div>
      <div className="flex gap-2 self-end">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => answerDrillEngineConsent(false, null)}
        >
          サーバーで判定する
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => answerDrillEngineConsent(true, entry.nn.sha256)}
        >
          ダウンロードする
        </button>
      </div>
    </div>
  );
}

/**
 * 検討盤の局面評価をこのブラウザで読んでいる間の表示（担当がブラウザの利用者。prd/12 §2.4）。評価結果の枠の「評価しています」に出す。
 *
 * - 同意を求めている（押した時点でダウンロードに同意していなかった）: 大きさを示して明示の開始を求める（prd/14 §5.10）。
 *   同意すれば全局面解析にも効く（同意は端末ごと・評価関数ごとに 1 つ）。やめたら評価しない
 * - エンジンを準備している: ダウンロードの進捗
 * - それ以外: 評価している旨だけ
 *
 * 文言に内部の用語（担当・MultiPV）は出さない
 */
export function StudyEvalBrowserStatus() {
  const asking = useStudyEvalConsentAsking();
  const { phase, manifest, download } = useBrowserAnalysisState();
  const settings = useBrowserAnalysisSettings();
  if (asking && manifest) {
    const entry = engineEntryOf(manifest, settings.evalId);
    return (
      <div role="status" className="alert py-2 flex flex-col items-stretch gap-2">
        <div className="text-sm">
          この局面をこのブラウザで評価します。最初に解析エンジンのデータ（評価関数 {entry.name}・約{' '}
          {megabytes(engineEntryDownloadBytes(entry))}）をダウンロードします。棋譜の解析にも使います。
        </div>
        <div className="flex gap-2 self-end">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => answerStudyEvalConsent(false, null)}
          >
            やめる
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => answerStudyEvalConsent(true, entry.nn.sha256)}
          >
            ダウンロードして評価する
          </button>
        </div>
      </div>
    );
  }
  const total = download?.total ?? 0;
  const loaded = download?.loaded ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="loading loading-dots loading-md" aria-label="評価しています" />
        <span className="text-base-content/60">
          {phase === 'loading' ? '解析エンジンを準備しています' : 'このブラウザで評価しています'}
          {phase === 'loading' && total > 0 && (
            <span className="ms-2 tabular-nums">
              {megabytes(loaded)} / {megabytes(total)}
            </span>
          )}
        </span>
      </div>
      {phase === 'loading' && (
        <progress
          className="progress progress-info w-full"
          value={total > 0 ? loaded : undefined}
          max={total > 0 ? total : undefined}
          aria-label="解析エンジンのダウンロード"
        />
      )}
    </div>
  );
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
