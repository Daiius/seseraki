import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import type { AnalysisPendingInput } from '../lib/analysisPending';
import { drillRound } from '../lib/drillRound';
import { kifuEntrySearch } from '../lib/drillSearch';
import { kifuDrillsState } from '../lib/kifuDrills';
import { DrillModeIcon } from './icons';

/*
  棋譜から、その対局の問題を解きに行く導線（prd/13 §7.10）。押すと入口「この対局」の解く画面へ移る。
  🔒 **棋譜詳細の中では解かせない**（§7.1）——ここは解く画面へ移るだけ。
  🔒 **入り直したら新しい回**（§6.4。レビュー `OCL-4A6EDA33`）——押したときに今の回を終える。
  ブラウザの戻るで解く画面へ戻ったときは回が残り、続きから出る。
  アイコンは出題の入口のもの（おすすめ＝詰と次の 2 枚重ね）を、出題全体の印として使う
*/

/** 押したら今の回を終える（新しい回は解く画面の loader が始める） */
function endRound() {
  drillRound.end();
}

/**
 * 棋譜詳細の上部のボタン（「問題 3」）。問題ができるまでは押せない形で、理由を添える（`lib/kifuDrills.ts`）。
 * 解析の経過を追って詳細を読み直しているので、解析が終われば開き直さなくても数が変わる
 */
export function KifuDrillsButton({
  kifuNo,
  kifu,
  className,
}: {
  kifuNo: number;
  kifu: AnalysisPendingInput & { drillCount: number };
  className?: string;
}) {
  const state = kifuDrillsState(kifu);
  const body = (
    <>
      <DrillModeIcon mode="recommend" size={5} />
      問題 {kifu.drillCount}
    </>
  );
  const base = 'btn btn-sm btn-ghost gap-1 px-2 max-sm:min-h-11 max-[375px]:min-h-10 whitespace-nowrap';
  if (!state.enabled) {
    return (
      // ⚠ disabled のボタンは title のツールチップが出ない端末があるので、理由は aria-label と小さな文字の両方に持たせる
      <span className={clsx('flex flex-col items-end', className)}>
        <button type="button" className={base} disabled aria-label={`問題 0（${state.reason}）`}>
          {body}
        </button>
        <span className="text-[10px] leading-tight text-base-content/50 max-w-44 text-right">{state.reason}</span>
      </span>
    );
  }
  return (
    <Link
      to="/drills"
      search={kifuEntrySearch(kifuNo)}
      onClick={endRound}
      className={clsx(base, className)}
      aria-label={`この対局の問題を解く（${kifu.drillCount} 問）`}
    >
      {body}
    </Link>
  );
}

/** 棋譜一覧の行のバッジ。🔒 **0 問の行には出さない**（解析の状態によらず数で決める。§7.10） */
export function KifuDrillsBadge({ kifuNo, drillCount }: { kifuNo: number; drillCount: number }) {
  if (drillCount <= 0) return null;
  return (
    <Link
      to="/drills"
      search={kifuEntrySearch(kifuNo)}
      onClick={endRound}
      className="badge badge-sm badge-outline gap-0.5 px-1"
      aria-label={`この対局の問題を解く（${drillCount} 問）`}
      title="この対局の問題を解く"
    >
      <DrillModeIcon mode="recommend" size={5} />
      {drillCount}
    </Link>
  );
}
