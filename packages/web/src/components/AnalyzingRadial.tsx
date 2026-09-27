import { type CSSProperties } from 'react';
import clsx from 'clsx';
import {
  progressDimClass,
  progressPercent,
  type AnalysisProfile,
} from '../lib/analysisProgress';

/** 円環の大きさ。`badge` は一覧の状態セル、`toast` は詳細画面の浮かせた通知 */
type RadialSize = 'badge' | 'toast';

const SIZE_STYLE: Record<RadialSize, { size: string; thickness: string }> = {
  // 他の状態バッジ（済 / 未 / 勝 / 負）と同じ一文字幅
  badge: { size: '1.1rem', thickness: '2px' },
  // 中央に「100%」が収まる最小限
  toast: { size: '2.25rem', thickness: '3px' },
};

/**
 * 「解析中」を表す円環。一覧（`/`）の状態セルと、棋譜詳細の解析中 toast（`AnalyzingToast`）で使う。
 *
 * - `badge`（既定）: 一覧の状態セル用。他の状態バッジと同じ一文字幅に収めるため文字なし。
 *   円環そのものが N/M を表す。経過時間（何分前に更新）は出さない——進捗が動くこと自体が
 *   worker の生存確認になる点は、円環が少しずつ埋まっていくことで保たれる。
 * - `toast`: 詳細画面用。中央に割合（%）を出す。
 *
 * 🔴 **段階（quick / full）は文字で出さず、濃さで示す**（prd/05 §2.5・決定 2026-09-05 後段）。
 * quick 進行中は半透明、full 進行中は現行どおり。簡易解析だけが終わっている状態は
 * **直後に詳細解析が走る一時的な状態**なので、モバイルの横幅を恒久的に食う印は置かない。
 */
export function AnalyzingRadial({
  profile,
  analyzed,
  estimated,
  total,
  size = 'badge',
}: {
  profile: AnalysisProfile;
  analyzed: number;
  /**
   * 円環に出す推定値（省略時は実データのまま）。ポーリングの合間を埋めて滑らかに進める
   * ためのもので、**読み上げ・title・中央の % は実データ（`analyzed`）のまま**にする
   * （決定・2026-09-07。prd/05 §2.5）。
   */
  estimated?: number;
  total: number;
  size?: RadialSize;
}) {
  // 円環の伸びは推定（小数のまま渡してよい）、文字は実データ
  const shown = total > 0 ? (Math.min(estimated ?? analyzed, total) / total) * 100 : 0;
  const text = `解析中 ${analyzed}/${total}`;
  const { size: cssSize, thickness } = SIZE_STYLE[size];
  return (
    <span
      role="progressbar"
      aria-label={text}
      aria-valuenow={analyzed}
      aria-valuemax={total}
      title={text}
      className={clsx('radial-progress text-info', progressDimClass(profile))}
      style={
        {
          '--value': shown,
          '--size': cssSize,
          '--thickness': thickness,
        } as CSSProperties
      }
    >
      {size === 'toast' && (
        <span
          aria-hidden
          className="text-[0.625rem] leading-none font-semibold tabular-nums text-base-content"
        >
          {progressPercent(analyzed, total)}%
        </span>
      )}
    </span>
  );
}
