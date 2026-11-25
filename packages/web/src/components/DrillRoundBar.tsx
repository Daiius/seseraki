import { Link } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { drillRound, lastKifuDrill } from '../lib/drillRound';
import { todayCorrectOf, useDrillDaily } from '../lib/drillDaily';
import { MODE_LABEL, MODES, modeSearch, type DrillsSearch } from '../lib/drillSearch';
import { ICON_BTN, MENU_ITEM, MENU_LIST } from '../lib/touchTargets';
import { ArrowRestartIcon, BookOpenIcon, EllipsisVerticalIcon, EyeSlashIcon, HomeIcon } from './icons';
// daisyUI の dropdown はフォーカスで開閉するので、項目を押したらフォーカスを外して閉じる
import { closeMenu } from '../lib/closeMenu';

/**
 * 解く画面の上部: 左に「今日 N 問正解」、右端のケバブ（prd/13 §7.6・§7.11）。
 * ケバブにはホーム・元の対局・やり直す・自明だったをアイコン付きで入れる（問題が無い画面ではホームだけ）。
 * ⚠ 経過（「この回 N 問中 M 問正解」）は外した（2026-11-22）。代わりに今日の正解の数を出す（2026-11-25）。
 * 「この回」そのもの（同じ回で記録した問題を出さない。§6.4）は `lib/drillRound.ts` が持ち続ける
 */
export function RoundBar({ solve }: { solve?: SolveActions }) {
  return (
    <div className="flex items-center gap-2">
      <TodayCorrect />
      <div className="ms-auto">
        <SolveMenu solve={solve} />
      </div>
    </div>
  );
}

export type SolveActions = {
  kifuNo: number;
  moveNumber: number;
  /**
   * 採点中（判定の応答待ち）。🔴 **やり直す・自明だったを押させない**（レビュー `OCL-D7C87C9C`）——
   * 進行中の採点の応答が、やり直した後の盤に古い手順や結果を書き戻してしまう
   */
  judging: boolean;
  onRestart: () => void;
  onExclude: () => void;
};

/**
 * 解く画面のケバブ。元の対局・やり直す・自明だったは**解く前から押せる**（2026-10-29 決定）。
 * ⚠ 解く前の「元の対局」は答えが見えている画面へ移る（§7.1 で伏せている棋譜を自分で開く）。記録は付かない
 */
function SolveMenu({ solve }: { solve?: SolveActions }) {
  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className={ICON_BTN} aria-label="メニュー">
        <EllipsisVerticalIcon />
      </button>
      <ul tabIndex={0} className={`${MENU_LIST} w-40`}>
        <li>
          <Link to="/drills" className={MENU_ITEM}>
            <HomeIcon />
            ホーム
          </Link>
        </li>
        {solve && (
          <>
            <li>
              {/*
                元の対局。出題局面の**次の手**（＝この問題の手）まで進めた状態で開く。
                `moveNumber` は 0 始まりの指し手番号なので、盤の手数（初期局面からの手数）は +1。
                こうすると開いた瞬間にその手の評価値・候補手が出る（prd/13 §7.1）
              */}
              <Link
                to="/kifus/$id"
                params={{ id: String(solve.kifuNo) }}
                search={{ ply: solve.moveNumber + 1 }}
                className={MENU_ITEM}
              >
                <BookOpenIcon />
                元の対局
              </Link>
            </li>
            <li>
              {/* やり直す（§7.1 の「最初から」。解答後なら以後は練習で記録しない） */}
              <button
                type="button"
                className={MENU_ITEM}
                disabled={solve.judging}
                onClick={() => {
                  closeMenu();
                  solve.onRestart();
                }}
              >
                <ArrowRestartIcon />
                やり直す
              </button>
            </li>
            <li>
              {/* 🔒 自動判定は作らない（「取り返し」の定義から詰まる。prd/13 §4.2） */}
              <button
                type="button"
                className={MENU_ITEM}
                disabled={solve.judging}
                onClick={() => {
                  closeMenu();
                  solve.onExclude();
                }}
              >
                <EyeSlashIcon />
                自明だった
              </button>
            </li>
          </>
        )}
      </ul>
    </div>
  );
}

/** 今日の正解の数（prd/13 §7.11）。読み込むまでは何も出さない */
export function TodayCorrect({ className }: { className?: string }) {
  const { days } = useDrillDaily();
  const today = todayCorrectOf(days);
  if (today === null) return null;
  return <span className={className ?? 'text-sm text-base-content/70'}>今日 {today} 問正解</span>;
}

/**
 * 入口の在庫が尽きた（prd/13 §6.4）。ほかの入口とホームへの導線を出す。
 * 入口「この対局」（§7.10・§7.11）は「一通り解きました」と、棋譜詳細・棋譜一覧への導線。
 * この回で 1 問も記録せずに尽きた（入った時点で全部正解済み）なら「すべて正解しています」
 * ——入口から入ると新しい回なので、この回の記録はこの対局のものだけ（入口を切り替えたら「この対局」から抜ける）
 */
export function Exhausted({ search }: { search: DrillsSearch }) {
  const mode = search.mode ?? 'recommend';
  const round = useSyncExternalStore(drillRound.subscribe, drillRound.get);
  if (mode === 'kifu' && search.kifu !== undefined) {
    const solvedNow = (round?.recorded ?? 0) > 0;
    // 最後に出した問題の局面まで進めて開く（この回で出したときだけ。分からなければ先頭から）
    const last = solvedNow && lastKifuDrill.current?.kifuNo === search.kifu ? lastKifuDrill.current : null;
    return (
      <div className="space-y-3 p-2">
        <p>{solvedNow ? '一通り解きました。' : 'この対局の問題はすべて正解しています。'}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/kifus/$id"
            params={{ id: String(search.kifu) }}
            // 出題局面の次の手（＝その問題の手）まで進めて開く（`moveNumber + 1`。§7.1 の導線と同じ）
            search={last ? { ply: last.moveNumber + 1 } : {}}
            className="btn btn-sm btn-primary"
          >
            棋譜詳細へ
          </Link>
          <Link to="/" className="btn btn-sm">
            棋譜一覧へ
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 p-2">
      <p>この入口の問題はもうありません。</p>
      <div className="flex items-center gap-2 flex-wrap">
        {MODES.filter((other) => other !== mode).map((other) => (
          <Link key={other} to="/drills" search={modeSearch(other)} replace className="btn btn-sm">
            {MODE_LABEL[other]}
          </Link>
        ))}
        <Link to="/drills" className="btn btn-sm btn-ghost">
          ホーム
        </Link>
      </div>
    </div>
  );
}
