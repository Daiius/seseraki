import { createFileRoute } from '@tanstack/react-router';
import { useThresholds } from '../lib/thresholds';
import {
  isValidMateMax,
  MAX_MATE_MAX,
  MIN_MATE_MAX,
  useMateMax,
} from '../lib/mateMax';
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
 *
 * 取りこぼしの詰み手数（prd/09 §5）も同じ性質（恒常的な好み）なのでここに置く。
 * ⚠ **こちらは「既定値」で、`/stats` では URL の `mateMax` が優先される**（prd/09 §3.1）。
 */
function SettingsPage() {
  const { thresholds, setThresholds } = useThresholds();
  const { mateMax, setMateMax } = useMateMax();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">設定</h2>
      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">悪手判定のしきい値</h3>
        <ThresholdSettings thresholds={thresholds} onChange={setThresholds} />
      </section>
      <section className="flex flex-col gap-3 mt-6">
        <h3 className="text-lg font-semibold">取りこぼしの詰み手数</h3>
        <p className="text-sm text-base-content/70">
          戦型別成績で「取りこぼし」と見なす詰みの手数の上限です。
          <strong>ここで決めるのは既定値</strong>で、分析ページ側でも変更できます。
          深い詰みは解析の読みの範囲に入らないため、上げるほど見落とし方向にぶれます。
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="number"
            className="input input-sm input-bordered w-20"
            value={mateMax}
            min={MIN_MATE_MAX}
            max={MAX_MATE_MAX}
            step={1}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (isValidMateMax(value)) setMateMax(value);
            }}
            aria-label="取りこぼしと見なす詰み手数の上限"
          />
          手詰以下を逃して負けた局を取りこぼしとする
        </label>
      </section>
    </div>
  );
}
