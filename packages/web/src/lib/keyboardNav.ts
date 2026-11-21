/*
  盤の手送りのキー（← → Home End。prd/05 §2.1）。棋譜・検討盤（`StudyBoard`）と出題の手順の再生（`DrillReplay`）が共用する。
  ⚠ 入力欄（スライダー・メモ等）にフォーカスがある間と修飾キー併用時はブラウザ既定に譲る。
*/

/** 手送りの向き。棋譜側の `KeyboardNav` のメソッド名と同じ */
export type NavAction = 'back' | 'forward' | 'first' | 'last';

/** 手送りのキーとして扱わない（修飾キー併用・入力欄にフォーカス） */
export function isNavIgnored(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return true;
  const target = e.target;
  return (
    typeof HTMLElement !== 'undefined'
    && target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT')
  );
}

/** キーの手送りの向き。手送りのキーでなければ null（{@link isNavIgnored} は呼び出し側で先に見る） */
export function navActionOf(key: string): NavAction | null {
  // ⚠ オブジェクトの引き当てにしない——`constructor` などの継承名を拾う（レビュー `OCL-965FD597`）
  switch (key) {
    case 'ArrowLeft': return 'back';
    case 'ArrowRight': return 'forward';
    case 'Home': return 'first';
    case 'End': return 'last';
    default: return null;
  }
}
