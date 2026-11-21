import { useEffect } from 'react';
import clsx from 'clsx';
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './icons';
import { useDisplaySize } from '../lib/displaySize';
import { controlButtonsOf } from '../lib/touchTargets';
import { linePositions, moveCursor, type ReplayCursor, type ReplayLine } from '../lib/drillReplay';

/*
  出題の手順の再生（prd/13 §7.9）。盤の下の送りの行と、手順 1 本の表示。
  🔒 **棋譜再生画面と同じ感覚にする**——≪ ◀ ▶ ≫ の並びと ← → Home End は `BoardControls`、
  再生位置の手を太字にするのは `CandidateLine` と同じ。状態（どの手順の何手目）は `DrillRunner` が持つ。
*/

/** 盤の下の送りの行（≪ ◀ n/N ▶ ≫） */
export function ReplayControls({
  lines,
  cursor,
  onMove,
}: {
  lines: readonly ReplayLine[];
  cursor: ReplayCursor;
  onMove: (next: ReplayCursor) => void;
}) {
  const { displaySize } = useDisplaySize();
  const btn = controlButtonsOf(displaySize.controlSize);
  const length = lines[cursor.line]?.moves.length ?? 0;
  const { position } = cursor;
  const go = (to: number) => onMove(moveCursor(lines, cursor, to));
  return (
    <div className="flex items-center gap-2 max-w-3xl no-tap-select">
      <button
        type="button"
        className={clsx(btn.icon, 'btn-outline')}
        onClick={() => go(0)}
        disabled={position === 0}
        title="手順の最初へ (Home)"
        aria-label="手順の最初へ"
      >
        <ChevronDoubleLeftIcon />
      </button>
      <button
        type="button"
        className={clsx(btn.iconFlex, 'btn-outline')}
        onClick={() => go(position - 1)}
        disabled={position === 0}
        title="1 手戻る (←)"
        aria-label="1 手戻る"
      >
        <ChevronLeftIcon />
      </button>
      <span className="text-sm font-mono text-base-content/60 w-14 text-center shrink-0">
        {position}/{length}
      </span>
      <button
        type="button"
        className={clsx(btn.iconFlex, 'btn-outline')}
        onClick={() => go(position + 1)}
        disabled={position === length}
        title="1 手進む (→)"
        aria-label="1 手進む"
      >
        <ChevronRightIcon />
      </button>
      <button
        type="button"
        className={clsx(btn.icon, 'btn-outline')}
        onClick={() => go(length)}
        disabled={position === length}
        title="手順の最後へ (End)"
        aria-label="手順の最後へ"
      >
        <ChevronDoubleRightIcon />
      </button>
    </div>
  );
}

/**
 * ← → Home End で再生を送る（`StudyBoard` の手送りと同じキー・同じ除外）。`cursor` が null の間は何もしない
 */
export function useReplayKeys(
  lines: readonly ReplayLine[],
  cursor: ReplayCursor | null,
  onMove: (next: ReplayCursor) => void,
) {
  useEffect(() => {
    if (!cursor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable
          || target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT')
      ) return;
      const length = lines[cursor.line]?.moves.length ?? 0;
      let to: number;
      switch (e.key) {
        case 'ArrowLeft': to = cursor.position - 1; break;
        case 'ArrowRight': to = cursor.position + 1; break;
        case 'Home': to = 0; break;
        case 'End': to = length; break;
        default: return;
      }
      // ページのスクロールを起こさない
      e.preventDefault();
      onMove(moveCursor(lines, cursor, to));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lines, cursor, onMove]);
}

/**
 * 手順 1 本（見出し + 手の並び）。叩くとその手順の再生に切り替わる。
 * 🔴 **再生位置の手（いま盤に出ている局面へ至った直前の手）を太字にする**（`CandidateLine` と同じ規則）。
 * 再生していない手順は太字を付けない
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
  /** 複数の手順を並べていて、これを再生している（枠で示す） */
  selected: boolean;
  onSelect: () => void;
}) {
  const { texts } = linePositions(line);
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
      {texts.map((text, j) => {
        const node =
          position !== null && j === position - 1 ? (
            <strong key={j} className="font-bold">
              {text}
            </strong>
          ) : (
            <span key={j} className={position !== null ? 'text-base-content/70' : undefined}>
              {text}
            </span>
          );
        return j > 0 ? [' ', node] : [node];
      })}
    </button>
  );
}
