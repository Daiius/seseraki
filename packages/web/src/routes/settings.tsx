import { createFileRoute } from '@tanstack/react-router';
import { useThresholds } from '../lib/thresholds';
import { ThresholdSettings } from '../components/ThresholdSettings';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

/**
 * アプリ全体の設定（prd/05-analysis.md §2.5）。
 *
 * しきい値は localStorage に 1 組だけ持ち全棋譜に効くので、棋譜ごとの画面ではなくここに置く。
 * 折り畳みにはしない——このページに来た時点で目的は設定なので、開く操作を挟む理由が無い。
 * 認証は `__root.tsx` の `beforeLoad` が全ルートに掛かっているのでここでは何もしない。
 */
function SettingsPage() {
  const { thresholds, setThresholds } = useThresholds();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">設定</h2>
      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">悪手判定のしきい値</h3>
        <ThresholdSettings thresholds={thresholds} onChange={setThresholds} />
      </section>
    </div>
  );
}
