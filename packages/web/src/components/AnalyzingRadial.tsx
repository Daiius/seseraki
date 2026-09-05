import { type CSSProperties } from 'react';
import clsx from 'clsx';
import {
  progressDimClass,
  type AnalysisProfile,
} from '../lib/analysisProgress';

/**
 * 一覧（`/`）の状態セルで「解析中」を表す円環。
 *
 * 他の状態バッジ（済 / 未 / 勝 / 負）と同じ一文字幅に収めるため、daisyUI の `radial-progress` を
 * 文字なしで使う。円環そのものが N/M を表すので数字は出さない。経過時間（何分前に更新）は一覧に
 * 出す幅の余裕がないので省き、詳細画面に委ねる——進捗が動くこと自体が worker の生存確認になる点は、
 * 円環が少しずつ埋まっていくことで保たれる。
 *
 * 🔴 **段階（quick / full）は文字で出さず、濃さで示す**（prd/05 §2.5・決定 2026-09-05 後段）。
 * quick 進行中は半透明、full 進行中は現行どおり。簡易解析だけが終わっている状態は
 * **直後に詳細解析が走る一時的な状態**なので、モバイルの横幅を恒久的に食う印は置かない。
 */
export function AnalyzingRadial({
  profile,
  analyzed,
  total,
}: {
  profile: AnalysisProfile;
  analyzed: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((analyzed / total) * 100) : 0;
  const text = `解析中 ${analyzed}/${total}`;
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
          '--value': pct,
          '--size': '1.1rem',
          '--thickness': '2px',
        } as CSSProperties
      }
    />
  );
}
