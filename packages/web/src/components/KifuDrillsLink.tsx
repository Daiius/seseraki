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

/** 「2/5」の数。全部正解したら正解の色（prd/13 §7.11） */
function progressText(correct: number, total: number) {
  return `${correct}/${total}`;
}

function progressLabel(correct: number, total: number) {
  return `この対局の問題を解く（${total} 問中 ${correct} 問正解）`;
}

/**
 * 棋譜詳細の上部のボタン（「問題 2/5」。正解数 / 問題数。prd/13 §7.11）。問題ができるまでは押せない形で、理由を添える（`lib/kifuDrills.ts`）。
 * 解析の経過を追って詳細を読み直しているので、解析が終われば開き直さなくても数が変わる
 */
export function KifuDrillsButton({
  kifuNo,
  kifu,
  className,
}: {
  kifuNo: number;
  kifu: AnalysisPendingInput & { drillCount: number; drillCorrectCount: number };
  className?: string;
}) {
  const state = kifuDrillsState(kifu);
  const allCorrect = kifu.drillCount > 0 && kifu.drillCorrectCount >= kifu.drillCount;
  const body = (
    <>
      <DrillModeIcon mode="recommend" size={5} />
      問題 {kifu.drillCount > 0 ? progressText(kifu.drillCorrectCount, kifu.drillCount) : 0}
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
      className={clsx(base, allCorrect && 'text-success', className)}
      aria-label={progressLabel(kifu.drillCorrectCount, kifu.drillCount)}
    >
      {body}
    </Link>
  );
}

/** 棋譜一覧の行のバッジ（「2/5」。prd/13 §7.11）。🔒 **0 問の行には出さない**（解析の状態によらず数で決める。§7.10） */
export function KifuDrillsBadge({
  kifuNo,
  drillCount,
  drillCorrectCount,
}: {
  kifuNo: number;
  drillCount: number;
  drillCorrectCount: number;
}) {
  if (drillCount <= 0) return null;
  const allCorrect = drillCorrectCount >= drillCount;
  return (
    <Link
      to="/drills"
      search={kifuEntrySearch(kifuNo)}
      onClick={endRound}
      className={clsx('badge badge-sm badge-outline gap-0.5 px-1', allCorrect && 'badge-success')}
      aria-label={progressLabel(drillCorrectCount, drillCount)}
      title="この対局の問題を解く"
    >
      <DrillModeIcon mode="recommend" size={5} />
      {progressText(drillCorrectCount, drillCount)}
    </Link>
  );
}
