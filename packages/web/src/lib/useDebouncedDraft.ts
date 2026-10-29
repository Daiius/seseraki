import { useEffect, useEffectEvent, useState } from 'react';

/**
 * 入力欄の下書き。打鍵ごとには反映せず、止まってから `ms` 後に `commit` へ渡す（一覧の検索語・分析の詰み手数）。
 *
 * - **外から値が変わったら下書きを作り直す**（戻る/進む・「条件をクリア」・`/settings` での変更など）。
 *   🔴 追従は**レンダー中に前回の値と比べて**行う（`StudyBoard` の `baseKey` と同じ定石）。
 *   effect で setState すると、1 フレームだけ古い下書きで描かれる
 * - 下書きが今の値と同じなら何もしない。`commit` は値の検証（範囲外なら反映しない など）も受け持つ
 * - `commit` は最新のものを呼ぶ（`useEffectEvent`）。待っている間に `commit` が作り直されても待ち直さない
 *
 * ⚠ 待っている間に**値が変わらないまま**下書きを捨てたいとき（URL の `q` が元から空の状態での「条件をクリア」）は、
 * 返す setter で下書きを今の値へ戻す（下書きが値と同じになれば、待っていた反映は取り消される）
 */
export function useDebouncedDraft(
  value: string,
  commit: (draft: string) => void,
  ms: number,
): [draft: string, setDraft: (draft: string) => void] {
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(value);
  }

  const onCommit = useEffectEvent(commit);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), ms);
    return () => clearTimeout(timer);
  }, [draft, value, ms]);

  return [draft, setDraft];
}
