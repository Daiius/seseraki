import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { engineEntryDownloadBytes, engineEntryOf } from 'shared';
import { forgetMe, type AnalysisAssignee, type Me } from '../lib/auth';
import { client } from '../lib/honoClient';
import { callApi } from '../lib/callApi';
import {
  setBrowserAnalysisSettings,
  useBrowserAnalysisSettings,
  type AnalysisLoad,
  type AnalysisMode,
} from '../lib/browserAnalysis/settings';
import { useBrowserAnalysisState } from '../lib/browserAnalysis/store';
import { engineAssetUrl, engineOriginOf } from '../lib/browserAnalysis/enginePaths';
import { BrowserAnalysisNotice } from './BrowserAnalysis';
import { megabytes } from '../lib/browserAnalysis/format';

const ASSIGNEE_OPTIONS: { value: AnalysisAssignee; label: string; hint: string }[] = [
  {
    value: 'worker',
    label: 'サーバーで解析',
    hint: '登録した棋譜を、サーバー側のエンジンが自動で解析します。',
  },
  {
    value: 'browser',
    label: 'ブラウザで解析',
    hint: 'この端末のブラウザが解析します。開いている間だけ進みます。',
  },
];

const MODE_OPTIONS: { value: AnalysisMode; label: string; hint: string }[] = [
  {
    value: 'detail',
    label: '棋譜を開いている間だけ',
    hint: '棋譜のページを開いている間、その棋譜を解析します。',
  },
  {
    value: 'always',
    label: 'このアプリを開いている間は常に',
    hint: 'どのページを開いていても、未解析の棋譜を解析します。まず未解析の棋譜をすべて手早く解析し、そのあと新しい順に詳しく解析します。開いている棋譜が最優先です。',
  },
];

const LOAD_OPTIONS: { value: AnalysisLoad; label: string; hint: string }[] = [
  {
    value: 'max',
    label: '全力',
    hint: 'この端末の CPU をできるだけ使って、早く解析します。',
  },
  {
    value: 'gentle',
    label: '控えめ',
    hint: '使う CPU をおよそ半分に抑えます。解析は遅くなりますが、ほかの操作や電池への影響が小さくなります。',
  },
];

/**
 * 評価関数の一言の説明（manifest のエントリの id ごと。知らない id は説明なし）。
 * 作者の説明（prd/14 §5.5）: mini の方が局面の評価の精度が高く、micro は速い代わりに大局観が劣る
 */
const EVAL_HINTS: Record<string, string> = {
  tsuyo11mini: '局面の評価の精度が高い評価関数です。',
  tsuyo11micro: '解析は速くなりますが、大局観は mini に劣ります。',
};

/** やねうら王の上流リポジトリ（対応ソースの所在。コミットは配信物の manifest が持つ） */
const UPSTREAM_REPO = 'https://github.com/yaneurao/YaneuraOu';

/**
 * 解析の設定（prd/14 §5.7・§5.10）。
 *
 * - **解析する場所**（サーバー / ブラウザ）: アカウントの設定。選べるユーザー（`canChooseWorker`）にだけ出す
 * - **解析するタイミング**・**解析の負荷**: 端末ごとの設定（localStorage）。ブラウザで解析するときだけ出す。
 *   負荷の変更は、次に解析を始めるときから効く（エンジンを作り直すため。解析中の棋譜は区切りまで今の負荷のまま）
 * - **評価関数**（つようら王11mini / micro。§5.5）: 端末ごとの設定。配信されている一覧（manifest）から選ぶ。
 *   変更は負荷と同じく次の解析の開始から効く。同意していない評価関数を選ぶと、ダウンロードの同意を求める
 * - **エンジンと評価関数のライセンス・対応ソースの所在**: ブラウザへ配っているので表示する（§5.5）
 *
 * 文言に内部の用語（担当・段階・世代）は出さない。
 */
export function AnalysisSettings({ me }: { me: Me }) {
  const router = useRouter();
  const { mode, load, evalId } = useBrowserAnalysisSettings();
  const { manifest } = useBrowserAnalysisState();
  // 選んでいない・配っていない id は既定として表示する（解析の側と同じ読み方）
  const selectedEval = manifest ? engineEntryOf(manifest, evalId) : null;
  // エンジンはどの評価関数でも同じ上流のコミットからビルドしている
  const upstreamSha = selectedEval?.engine.upstreamSha ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browser = me.analysisAssignee === 'browser';

  const switchAssignee = async (assignee: AnalysisAssignee) => {
    if (assignee === me.analysisAssignee || busy) return;
    // 🔒 切り替えは途中の解析を消す（prd/14 §5.7）ので、確かめてから送る
    if (
      !confirm(
        '解析する場所を切り替えると、途中まで進んでいた解析は最初からやり直しになります（解析が終わった棋譜はそのまま残ります）。切り替えますか？',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await callApi(
        client.api.users.me['analysis-assignee'].$put({ json: { assignee } }),
        { fallback: (status) => `切り替えられませんでした (${status})` },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // ログイン状態はページ単位で覚えているので、捨ててから取り直す（常駐の解析もこれで切り替わる）
      forgetMe();
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 mt-6">
      <h3 className="text-lg font-semibold">解析</h3>

      {me.canChooseWorker && (
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-sm font-semibold mb-1">解析する場所</legend>
          {ASSIGNEE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="analysis-assignee"
                className="radio radio-sm mt-0.5"
                checked={me.analysisAssignee === option.value}
                onChange={() => void switchAssignee(option.value)}
              />
              <span>
                {option.label}
                <span className="block text-base-content/70">{option.hint}</span>
              </span>
            </label>
          ))}
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
        </fieldset>
      )}

      {browser && (
        <>
          {!me.canChooseWorker && (
            <p className="text-sm text-base-content/70">
              棋譜は、この端末のブラウザが解析します。解析は、開いている間だけ進みます。
            </p>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold mb-1">
              解析するタイミング（この端末の設定）
            </legend>
            {MODE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="analysis-mode"
                  className="radio radio-sm mt-0.5"
                  checked={mode === option.value}
                  onChange={() => setBrowserAnalysisSettings({ mode: option.value })}
                />
                <span>
                  {option.label}
                  <span className="block text-base-content/70">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold mb-1">
              解析の負荷（この端末の設定）
            </legend>
            {LOAD_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="analysis-load"
                  className="radio radio-sm mt-0.5"
                  checked={load === option.value}
                  onChange={() => setBrowserAnalysisSettings({ load: option.value })}
                />
                <span>
                  {option.label}
                  <span className="block text-base-content/70">{option.hint}</span>
                </span>
              </label>
            ))}
            <p className="text-xs text-base-content/70">
              変更は、次に解析を始めるときから効きます。
            </p>
          </fieldset>

          {manifest && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold mb-1">
                評価関数（この端末の設定）
              </legend>
              {manifest.evals.map((entry) => (
                <label key={entry.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="analysis-eval"
                    className="radio radio-sm mt-0.5"
                    checked={selectedEval?.id === entry.id}
                    onChange={() => setBrowserAnalysisSettings({ evalId: entry.id })}
                  />
                  <span>
                    {entry.name}
                    {entry.id === manifest.defaultId && '（既定）'}
                    <span className="ms-1 text-base-content/70 tabular-nums">
                      約 {megabytes(engineEntryDownloadBytes(entry))}
                    </span>
                    {EVAL_HINTS[entry.id] && (
                      <span className="block text-base-content/70">
                        {EVAL_HINTS[entry.id]}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <p className="text-xs text-base-content/70">
                変更は、次に解析を始めるときから効きます。まだダウンロードしていない評価関数を選ぶと、ダウンロードの確認が出ます。
                解析済みの棋譜は、そのときの評価関数の結果のまま残ります。
              </p>
            </fieldset>
          )}

          <BrowserAnalysisNotice />

          <div className="text-sm text-base-content/70 flex flex-col gap-1">
            <div className="font-semibold text-base-content">
              解析エンジンについて
            </div>
            <p>
              解析エンジンは
              <a className="link" href={UPSTREAM_REPO} target="_blank" rel="noreferrer">
                やねうら王
              </a>
              （GPL-3.0）を WebAssembly にビルドしたもので、変更は加えていません。
              {upstreamSha ? (
                <>
                  対応するソースは上流のコミット{' '}
                  <a
                    className="link font-mono"
                    href={`${UPSTREAM_REPO}/tree/${upstreamSha}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {upstreamSha.slice(0, 12)}
                  </a>
                  、ビルドの手順はこのアプリのリポジトリの{' '}
                  <span className="font-mono">packages/engine-wasm</span>{' '}
                  にあります。
                </>
              ) : (
                <>
                  ビルドの手順はこのアプリのリポジトリの{' '}
                  <span className="font-mono">packages/engine-wasm</span>{' '}
                  にあります。
                </>
              )}
            </p>
            {manifest && (
              <p>
                評価関数はエンジンとは別の著作物です。
                {manifest.evals.map((entry) => (
                  <span key={entry.id} className="block">
                    {entry.name}（{entry.license.name}・
                    <a
                      className="link"
                      href={entry.license.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      配布元
                    </a>
                    {entry.license.file && (
                      <>
                        ・
                        <a
                          className="link"
                          href={engineAssetUrl(engineOriginOf('', import.meta.env.BASE_URL), entry.license.file)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          許諾文
                        </a>
                      </>
                    )}
                    ）
                  </span>
                ))}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
