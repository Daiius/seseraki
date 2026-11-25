import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import clsx from 'clsx';
import { dailyGrid, dailyLabel, dailyLevel, todayCorrectOf, useDrillDaily, type DailyCount } from '../lib/drillDaily';
import { MODE_LABEL, modeSearch, type DrillMode } from '../lib/drillSearch';
import type { loadCounts } from '../lib/drillApi';
import { DrillModeIcon } from './icons';

type Counts = NonNullable<Awaited<ReturnType<typeof loadCounts>>['counts']>;

/**
 * ホーム（prd/13 §7.5）。入口のカード 4 つと問題の一覧へのリンク、今日の正解の数と直近 4 週間の記録（§7.11）。
 * 🔒 **正答率などの成績は出さない**（§10。棋力の向上に繋がらないため）。記録は量（正解した問題の数）だけ
 */
export function DrillHome({ counts, error }: { counts: Counts | null; error: string | null }) {
  if (error || !counts) return <p className="text-error p-2">{error ?? '読み込めませんでした'}</p>;
  if (counts.total === 0) {
    return (
      <p className="text-base-content/70 p-2">
        まだ問題がありません。解析済みの棋譜が増えると問題が作られます。
      </p>
    );
  }
  const entries: { mode: DrillMode; stock: number; detail: string }[] = [
    { mode: 'recommend', stock: counts.recommend, detail: '間違えた問題・新しい対局の問題から' },
    { mode: 'mate', stock: counts.mate, detail: `未解答 ${counts.mate}` },
    { mode: 'best', stock: counts.best, detail: `未解答 ${counts.best}` },
    { mode: 'wrong', stock: counts.wrong, detail: `${counts.wrong} 問` },
  ];
  return (
    <div className="space-y-3 max-w-xl">
      <h1 className="text-lg font-bold">出題</h1>
      <DailyRecord />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {entries.map(({ mode, stock, detail }) =>
          // 在庫が 0 の入口は押せない形で出す（数が 0 と分かれば足りる）
          stock > 0 ? (
            <Link
              key={mode}
              to="/drills"
              search={modeSearch(mode)}
              className="card card-border bg-base-100 hover:bg-base-200 p-4 flex-row items-center gap-3"
            >
              {/* 入口のアイコン（解いた後のボタン・ドロップダウンと同じ。prd/13 §7.5） */}
              {/* 幅を揃える（おすすめの重ねた駒は横に広い）——名前の書き出しが入口ごとにずれないように */}
              <span className="font-bold text-base w-9 shrink-0 flex justify-center">
                <DrillModeIcon mode={mode} />
              </span>
              <span className="flex flex-col">
                <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
                <span className="text-sm text-base-content/70">{detail}</span>
              </span>
            </Link>
          ) : (
            <div
              key={mode}
              aria-disabled="true"
              className="card card-border bg-base-200/50 p-4 text-base-content/50 flex-row items-center gap-3"
            >
              {/* 幅を揃える（おすすめの重ねた駒は横に広い）——名前の書き出しが入口ごとにずれないように */}
              <span className="font-bold text-base w-9 shrink-0 flex justify-center">
                <DrillModeIcon mode={mode} />
              </span>
              <span className="flex flex-col">
                <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
                <span className="text-sm">{mode === 'recommend' ? 'いま出せる問題はありません' : detail}</span>
              </span>
            </div>
          ),
        )}
      </div>
      <Link to="/drills" search={{ view: 'list' }} className="link link-primary text-sm">
        問題の一覧
      </Link>
    </div>
  );
}

/** マスの濃さ（0〜3） */
const LEVEL_CLASS = ['bg-base-300', 'bg-success/35', 'bg-success/65', 'bg-success'] as const;

/**
 * 今日の正解の数と、直近 4 週間の日ごとの正解の数（prd/13 §7.11）。1 行 1 週（月〜日）・最後の行が今週。
 * マスを押すと、その日の日付と数を下に出す（触れる端末には title が出ないため）
 */
function DailyRecord() {
  const { days } = useDrillDaily();
  const [picked, setPicked] = useState<DailyCount | null>(null);
  const today = todayCorrectOf(days);
  if (!days || today === null) return null;
  const grid = dailyGrid(days);
  const shown = picked ?? days[days.length - 1];
  return (
    <section className="card card-border bg-base-100 p-3 gap-2 max-w-xs" aria-label="日ごとの正解の数">
      <p className="font-bold">今日 {today} 問正解</p>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-center text-base-content/50" aria-hidden="true">
        {'月火水木金土日'.split('').map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.flat().map((cell, i) =>
          cell ? (
            <button
              key={cell.date}
              type="button"
              onClick={() => setPicked(cell)}
              title={`${dailyLabel(cell.date)} ${cell.correct} 問正解`}
              aria-label={`${dailyLabel(cell.date)} ${cell.correct} 問正解`}
              aria-pressed={shown.date === cell.date}
              className={clsx(
                'aspect-square rounded-sm',
                LEVEL_CLASS[dailyLevel(cell.correct)],
                shown.date === cell.date && 'ring-2 ring-base-content/40',
              )}
            />
          ) : (
            <span key={`empty-${i}`} className="aspect-square" />
          ),
        )}
      </div>
      <p className="text-xs text-base-content/70">
        {dailyLabel(shown.date)} {shown.correct} 問正解
      </p>
    </section>
  );
}
