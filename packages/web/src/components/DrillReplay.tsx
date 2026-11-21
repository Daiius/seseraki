import { useEffect, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './icons';
import { PvLine } from './CandidateLine';
import { useDisplaySize } from '../lib/displaySize';
import { controlButtonsOf } from '../lib/touchTargets';
import { isNavIgnored, navActionOf, type NavAction } from '../lib/keyboardNav';
import { canStep, lineTexts, stepCursor, type ReplayCursor, type ReplayLine } from '../lib/drillReplay';

/*
  出題の手順の再生（prd/13 §7.9）。盤の下の送りの行と、手順 1 本の表示。
  🔒 **棋譜再生画面と同じ感覚にする**——キーの判定は `lib/keyboardNav.ts`、手順の外枠と太字の規則は `CandidateLine.tsx` の `PvLine`、
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
 * 再生できる手順の一覧。🔒 **棋譜側の候補手と同じ外枠（`PvLine`）で描く**——再生している手順は左に primary の線、
 * ほかはグレーの線を引く。🔒 **畳まない**（叩いても高さが変わらない）。どこを叩いてもその手順の再生に切り替わる（prd/13 §7.9）
 */
export function ReplayLines({
  name,
  lines,
  cursor,
  onSelect,
}: {
  /** 排他アコーディオンの名前（解答後と途中の間違いで分ける） */
  name: string;
  lines: readonly ReplayLine[];
  cursor: ReplayCursor | null;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {lines.map((line, index) => {
        const selected = cursor?.line === index;
        const texts = lineTexts(line);
        return (
          <PvLine
            key={line.label}
            name={name}
            className="text-sm"
            active={selected}
            selectable
            onSummaryClick={() => onSelect(index)}
            collapse="never"
            summary={
              <span className={clsx('badge badge-sm whitespace-nowrap', selected ? 'badge-primary' : 'badge-ghost')}>
                {line.label}
              </span>
            }
            texts={texts}
            position={selected ? cursor.position : 0}
          />
        );
      })}
    </div>
  );
}
