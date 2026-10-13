import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { forgetMe, type AnalysisAssignee, type Me } from '../lib/auth';
import { client } from '../lib/honoClient';
import {
  setBrowserAnalysisSettings,
  useBrowserAnalysisSettings,
  type AnalysisMode,
} from '../lib/browserAnalysis/settings';
import { useBrowserAnalysisState } from '../lib/browserAnalysis/store';
import { BrowserAnalysisNotice } from './BrowserAnalysis';

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
    hint: 'どのページを開いていても、未解析の棋譜を新しい順に解析します。開いている棋譜が最優先です。',
  },
];

/** やねうら王の上流リポジトリ（対応ソースの所在。コミットは配信物の manifest が持つ） */
const UPSTREAM_REPO = 'https://github.com/yaneurao/YaneuraOu';

/**
 * 解析の設定（prd/14 §5.7・§5.10）。
 *
 * - **解析する場所**（サーバー / ブラウザ）: アカウントの設定。選べるユーザー（`canChooseWorker`）にだけ出す
 * - **解析するタイミング**: 端末ごとの設定（localStorage）。ブラウザで解析するときだけ出す
 * - **エンジンと評価関数のライセンス・対応ソースの所在**: ブラウザへ配っているので表示する（§5.5）
 *
 * 文言に内部の用語（担当・段階・世代）は出さない。
 */
export function AnalysisSettings({ me }: { me: Me }) {
  const router = useRouter();
  const { mode } = useBrowserAnalysisSettings();
  const { manifest } = useBrowserAnalysisState();
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
      const res = await client.api.users.me['analysis-assignee'].$put({
        json: { assignee },
      });
      if (!res.ok) {
        setError(`切り替えられませんでした (${res.status})`);
        return;
      }
      // ログイン状態はページ単位で覚えているので、捨ててから取り直す（常駐の解析もこれで切り替わる）
      forgetMe();
      await router.invalidate();
    } catch {
      setError('サーバーに接続できません');
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
              {manifest ? (
                <>
                  対応するソースは上流のコミット{' '}
                  <a
                    className="link font-mono"
                    href={`${UPSTREAM_REPO}/tree/${manifest.engine.upstreamSha}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {manifest.engine.upstreamSha.slice(0, 12)}
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
            <p>
              評価関数は水匠5 で、エンジンとは別の著作物です（やねうら王のリリースで配布されているもの）。
            </p>
          </div>
        </>
      )}
    </section>
  );
}
