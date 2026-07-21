import { DEFAULT_THRESHOLDS, type Thresholds } from '../lib/cpl';
import { applyThresholdInput } from '../lib/thresholds';

/**
 * 悪手判定のしきい値設定（prd/05-analysis.md §2.5）。
 *
 * CPL 自体はしきい値に依存しない（しきい値は表示のフィルタ）ので、変更しても再解析は要らない。
 * 値はブラウザの localStorage に保存され、全棋譜に効く。
 * 入力の解釈（空欄の無視・`疑問手 <= 悪手` の追従）は `applyThresholdInput` に寄せてある。
 */
export function ThresholdSettings({
  thresholds,
  onChange,
}: {
  thresholds: Thresholds;
  onChange: (next: Thresholds) => void;
}) {
  const handleInput = (field: keyof Thresholds, raw: string) => {
    const next = applyThresholdInput(thresholds, field, raw);
    if (next) onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-base-content/70">
        判定の段階を切り替えるしきい値です（このブラウザに保存され、すべての棋譜に効きます）。
        損失（CPL＝最善手の評価 − 実手の評価）そのものはしきい値に依存しないため、
        変更しても解析のやり直しは要りません。
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <ThresholdField
          label="悪手"
          hint="この損失(cp)以上"
          value={thresholds.blunder}
          onInput={(raw) => handleInput('blunder', raw)}
        />
        <ThresholdField
          label="疑問手"
          hint="この損失(cp)以上・悪手未満"
          value={thresholds.dubious}
          onInput={(raw) => handleInput('dubious', raw)}
        />
        <ThresholdField
          label="決着"
          hint="評価値がこの絶対値(cp)以上ならラベルを付けない"
          value={thresholds.decided}
          onInput={(raw) => handleInput('decided', raw)}
        />
      </div>
      <button
        className="btn btn-outline btn-sm self-start"
        onClick={() => onChange(DEFAULT_THRESHOLDS)}
        disabled={
          thresholds.blunder === DEFAULT_THRESHOLDS.blunder
          && thresholds.dubious === DEFAULT_THRESHOLDS.dubious
          && thresholds.decided === DEFAULT_THRESHOLDS.decided
        }
      >
        既定に戻す
      </button>
    </div>
  );
}

function ThresholdField({
  label,
  hint,
  value,
  onInput,
}: {
  label: string;
  hint: string;
  value: number;
  onInput: (raw: string) => void;
}) {
  return (
    <label className="form-control flex flex-col gap-1 sm:w-64">
      <span className="text-sm font-semibold">{label}</span>
      <input
        type="number"
        min={0}
        step={10}
        value={value}
        onChange={(e) => onInput(e.target.value)}
        className="input input-bordered input-sm w-full"
      />
      <span className="text-xs text-base-content/60">{hint}</span>
    </label>
  );
}
