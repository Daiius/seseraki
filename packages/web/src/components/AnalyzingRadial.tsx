import { type CSSProperties } from 'react';

/**
 * 一覧（`/`）の状態セルで「解析中」を表す円環。
 *
 * 他の状態バッジ（済 / 未 / 勝 / 負）と同じ一文字幅に収めるため、daisyUI の `radial-progress` を
 * 文字なしで使う。円環そのものが N/M を表すので数字は出さない。経過時間（何分前に更新）は一覧に
 * 出す幅の余裕がないので省き、詳細画面に委ねる——進捗が動くこと自体が worker の生存確認になる点は、
 * 円環が少しずつ埋まっていくことで保たれる。
 */
export function AnalyzingRadial({
  analyzed,
  total,
}: {
  analyzed: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((analyzed / total) * 100) : 0;
  return (
    <span
      role="progressbar"
      aria-label={`解析中 ${analyzed}/${total}`}
      aria-valuenow={analyzed}
      aria-valuemax={total}
      title={`解析中 ${analyzed}/${total}`}
      className="radial-progress text-info"
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
