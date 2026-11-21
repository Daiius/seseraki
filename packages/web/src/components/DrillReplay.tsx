import { useEffect, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './icons';
import { PvMoves } from './CandidateLine';
import { useDisplaySize } from '../lib/displaySize';
import { controlButtonsOf } from '../lib/touchTargets';
import { isNavIgnored, navActionOf, type NavAction } from '../lib/keyboardNav';
import { canStep, lineTexts, stepCursor, type ReplayCursor, type ReplayLine } from '../lib/drillReplay';

/*
  出題の手順の再生（prd/13 §7.9）。盤の下の送りの行と、手順 1 本の表示。
  🔒 **棋譜再生画面と同じ感覚にする**——キーの判定は `lib/keyboardNav.ts`、太字の規則は `CandidateLine` の `PvMoves`、
  ボタンの寸法は `lib/touchTargets.ts` を棋譜側と共用する。状態（どの手順の何手目）は `DrillRunner` が持つ。
  ⚠ 送りの行そのものは `BoardControls` と別にしている——あちらは検討の undo / redo・スライダー・反転・評価と一体で、
  出題の再生には要らない
*/

/** 盤の下の送りの行（≪ ◀ n/N ▶ ≫）。再生に入っていなければ位置を `–` にする */
export function ReplayControls({
  lines,
  cursor,
  onMove,
}: {
  lines: readonly ReplayLine[];
  cursor: ReplayCursor | null;
  onMove: (next: ReplayCursor) => void;
}) {
  const { displaySize } = useDisplaySize();
  const btn = controlButtonsOf(displaySize.controlSize);
  const length = lines[cursor?.line ?? 0]?.moves.length ?? 0;
  const go = (action: NavAction) => {
    const next = stepCursor(lines, cursor, action);
    if (next) onMove(next);
  };
  const button = (action: NavAction, className: string, title: string, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={clsx(className, 'btn-outline')}
      onClick={() => go(action)}
      disabled={!canStep(lines, cursor, action)}
      title={title}
      aria-label={label}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex items-center gap-2 max-w-3xl no-tap-select">
      {button('first', btn.icon, '手順の最初へ (Home)', '手順の最初へ', <ChevronDoubleLeftIcon />)}
      {button('back', btn.iconFlex, '1 手戻る (←)', '1 手戻る', <ChevronLeftIcon />)}
      <span className="text-sm font-mono text-base-content/60 w-14 text-center shrink-0">
        {cursor ? cursor.position : '–'}/{length}
      </span>
      {button('forward', btn.iconFlex, '1 手進む (→)', '1 手進む', <ChevronRightIcon />)}
      {button('last', btn.icon, '手順の最後へ (End)', '手順の最後へ', <ChevronDoubleRightIcon />)}
    </div>
  );
}

/** ← → Home End で再生を送る（棋譜側と同じキー・同じ除外。`lib/keyboardNav.ts`）。手順が無い間は何もしない */
export function useReplayKeys(
  lines: readonly ReplayLine[],
  cursor: ReplayCursor | null,
  onMove: (next: ReplayCursor) => void,
) {
  useEffect(() => {
    if (lines.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isNavIgnored(e)) return;
      const action = navActionOf(e.key);
      if (action === null) return;
      // ページのスクロールを起こさない
      e.preventDefault();
      const next = stepCursor(lines, cursor, action);
      if (next) onMove(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lines, cursor, onMove]);
}

/**
 * 手順 1 本（見出し + 手の並び）。叩くとその手順の再生に切り替わる。
 * 再生位置の手を太字にする規則は棋譜側と同じ（`PvMoves`）。再生していない手順は太字を付けない
 */
export function ReplayLineText({
  line,
  position,
  selected,
  onSelect,
}: {
  line: ReplayLine;
  /** この手順を再生している位置（再生していなければ null） */
  position: number | null;
  /** これを再生している（背景で示す） */
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        'block w-full text-left text-sm break-all rounded-lg px-2 py-1 cursor-pointer',
        selected ? 'bg-base-300' : 'hover:bg-base-300/50',
      )}
    >
      <span className="me-1">{line.label}</span>
      <span className={position !== null ? 'text-base-content/70' : undefined}>
        <PvMoves texts={lineTexts(line)} position={position ?? 0} />
      </span>
    </button>
  );
}
