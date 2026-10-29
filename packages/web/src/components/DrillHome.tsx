import { Link } from '@tanstack/react-router';
import { MODE_LABEL, modeSearch, type DrillMode } from '../lib/drillSearch';
import type { loadCounts } from '../lib/drillApi';
import { DrillModeIcon } from './icons';

type Counts = NonNullable<Awaited<ReturnType<typeof loadCounts>>['counts']>;

/**
 * ホーム（prd/13 §7.5）。入口のカード 4 つと問題の一覧へのリンクだけ。
 * 🔒 **正答率などの成績は出さない**（§10。棋力の向上に繋がらないため）
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
