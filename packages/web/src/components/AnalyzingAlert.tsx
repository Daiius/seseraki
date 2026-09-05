import clsx from 'clsx';
import {
  progressDimClass,
  type AnalysisProfile,
} from '../lib/analysisProgress';

/**
 * 棋譜詳細（`/kifus/$id`）で解析中に出す進捗 alert。
 *
 * 🔴 **段階（`profile`）は文言に出さない**（prd/05 §2.5・決定 2026-09-05 後段）。
 * 簡易解析だけが終わっている状態は**直後に詳細解析が走る一時的な状態**で、
 * そこに語を割くと**主に使うモバイルで横幅を食う**。段階は**進捗バーの濃さ**で示す
 * ——quick 進行中は半透明、full 進行中は現行どおり。
 * ⚠ 文言（読み上げを含む）と寸法は現行のまま。変えるのはバーの不透明度だけ。
 *
 * 「解析中 N/M ◯前に更新」の文言とプログレスバーを縦中央に揃える。`alert` は daisyUI 5 では
 * grid（`grid-auto-flow: column`・既定 `place-items: center start`）なので `flex-col`/`flex-row` は
 * 効かず、揃えは `align-items` で決まる。`items-center` で縦中央に揃える。
 *
 * 経過時間の文言（`agoText`）は呼び出し側で組み立てて渡す（`formatUpdatedAgo`）。停止の判断は
 * 経過時間を見せて人に委ねる方針で、ここでは閾値で stale を決めない。
 */
export function AnalyzingAlert({
  profile,
  analyzed,
  total,
  agoText,
}: {
  profile: AnalysisProfile;
  analyzed: number;
  total: number;
  agoText: string;
}) {
  return (
    <div role="status" className="alert alert-info items-center gap-2">
      <span className="flex-1">
        解析中 {analyzed}/{total}
        <span className="ml-2 text-sm opacity-80">{agoText}</span>
      </span>
      {/* 色は付けない。alert-info の上に progress-info を置くと同色で見えなくなる */}
      <progress
        className={clsx(
          'progress w-full sm:w-56',
          progressDimClass(profile),
        )}
        value={analyzed}
        max={total}
      />
    </div>
  );
}
