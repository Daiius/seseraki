import { useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { drillRound, roundText } from '../lib/drillRound';
import { MODE_LABEL, MODES, modeSearch, type DrillMode } from '../lib/drillSearch';
import { ICON_BTN, MENU_ITEM, MENU_LIST } from '../lib/touchTargets';
import { ArrowRestartIcon, BookOpenIcon, EyeSlashIcon, HomeIcon } from './icons';

/**
 * 解く画面の上部: 「この回 N 問中 M 問正解」と、右端のケバブ（prd/13 §7.6）。
 * ケバブにはホーム・元の対局・やり直す・自明だったをアイコン付きで入れる（問題が無い画面ではホームだけ）
 */
export function RoundBar({ solve }: { solve?: SolveActions }) {
  const round = useSyncExternalStore(drillRound.subscribe, drillRound.get, () => null);
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-base-content/70">{roundText(round)}</span>
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
  // daisyUI の dropdown はフォーカスで開閉するので、項目を押したらフォーカスを外して閉じる（kifus/$id と同じ）
  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className={ICON_BTN} aria-label="メニュー">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          className="size-5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
        </svg>
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

/** 入口の在庫が尽きた（prd/13 §6.4）。ほかの入口とホームへの導線を出す */
export function Exhausted({ mode }: { mode: DrillMode }) {
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
