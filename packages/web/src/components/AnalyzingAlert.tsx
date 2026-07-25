/**
 * 棋譜詳細（`/kifus/$id`）で解析中に出す進捗 alert。
 *
 * 「解析中 N/M ◯前に更新」の文言とプログレスバーを縦中央に揃える。`alert` は daisyUI 5 では
 * grid（`grid-auto-flow: column`・既定 `place-items: center start`）なので `flex-col`/`flex-row` は
 * 効かず、揃えは `align-items` で決まる。`items-center` で縦中央に揃える。
 *
 * 経過時間の文言（`agoText`）は呼び出し側で組み立てて渡す（`formatUpdatedAgo`）。停止の判断は
 * 経過時間を見せて人に委ねる方針で、ここでは閾値で stale を決めない。
 */
export function AnalyzingAlert({
  analyzed,
  total,
  agoText,
}: {
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
      <progress className="progress w-full sm:w-56" value={analyzed} max={total} />
    </div>
  );
}
