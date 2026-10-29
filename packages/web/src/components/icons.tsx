/**
 * インライン SVG アイコン（heroicons v2 outline・MIT）。
 *
 * アイコン用の依存を足さず、必要な数個だけ heroicons のパスをインライン化する（既存の
 * 三点メニュー等と同じ流儀）。`currentColor` 追従・`className` で寸法を渡す（既定 `size-5`）。
 * 装飾目的なので `aria-hidden`——意味はボタン側の `aria-label` に持たせる。
 *
 * 🔴 **`width` / `height` 属性を必ず持たせる。** `className` は既定引数なので、呼び出し側が
 * 寸法クラスを含まない値を渡すと既定の `size-5` が消える。**寸法を持たない SVG の auto
 * サイズ解決は Chromium と WebKit で違い**、Chromium は親いっぱいに伸ばすのに対し
 * WebKit（iOS の Chrome を含む）では潰れて見えなくなる。実際に踏んだ
 * （ヘッダーの `<PlusIcon className="sm:hidden" />` が iPhone で消えた）。
 * 属性は presentation attribute なので CSS の `size-*` に負ける——**渡した寸法クラスは
 * 今までどおり効き、クラスが無いときだけ 24px で描かれる**。呼び出し側の書き方を縛らずに
 * 済むこの形を採った（既定寸法をクラスへ前置する案は、`size-4` を渡している既存の呼び出しと
 * `size-*` 同士で衝突して CSS 順序次第になるため見送った）。
 */
import { useId } from 'react';

type IconProps = { className?: string };

/** コピー（clipboard-document） */
export function ClipboardDocumentIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"
      />
    </svg>
  );
}

/** 完了（check） */
export function CheckIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

/** ペースト（clipboard） */
export function ClipboardIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
      />
    </svg>
  );
}

/*
 * 以下はヘッダー（navbar）用。線の太さは 2 で揃える——小さな寸法（size-5）で並ぶので、
 * 1.5 だと他の UI に比べて薄く沈む。
 */

/** 棋譜一覧（list-bullet） */
export function ListBulletIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm0 5.25h.007v.008H3.75V12Zm0 5.25h.007v.008H3.75v-.008Z" />
    </svg>
  );
}

/** 登録（plus） */
export function PlusIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

/** 成績（chart-bar） */
export function ChartBarIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
    </svg>
  );
}

/** 出題（academic-cap。prd/13） */
export function AcademicCapIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5" />
    </svg>
  );
}

/** メニュー（ellipsis-vertical。ケバブ） */
export function EllipsisVerticalIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
    </svg>
  );
}

/** 局面検索（magnifying-glass） */
export function MagnifyingGlassIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  );
}

/** 設定（cog-6-tooth） */
export function CogIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.379.137.75.43.992l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.379-.138-.75-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

/** ログアウト（arrow-right-on-rectangle） */
export function LogoutIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
    </svg>
  );
}

/** メニュー（bars-3） */
export function Bars3Icon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
    </svg>
  );
}

/** 開閉の示唆（chevron-down）。`details[open]` で 180° 回すために単体で置く */
export function ChevronDownIcon({ className = 'size-3' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2.5}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

/** 前へ（chevron-left）。検討盤の読み筋送りで使う */
export function ChevronLeftIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
    </svg>
  );
}

/** 次へ（chevron-right）。検討盤の読み筋送りで使う */
export function ChevronRightIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  );
}

/** 最初へ（chevron-double-left）。棋譜のコントローラー行で使う */
export function ChevronDoubleLeftIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
    </svg>
  );
}

/** 最後へ（chevron-double-right）。棋譜のコントローラー行で使う */
export function ChevronDoubleRightIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 4.5l7.5 7.5-7.5 7.5m-6-15l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

/** 盤面反転（上下の矢印） */
export function FlipIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
    </svg>
  );
}

/**
 * 評価する（棋譜のコントローラー行・7 つ目。prd/12 §3.2・決定 2026-09-01）。
 * 虫眼鏡（局面検索と同じ図像になる）・グラフ（真下の評価値グラフと紛れる）は避け、
 * cpu-chip にした。線の太さは 2（コントローラー行の chevron と並ぶため）。
 */
export function CpuChipIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z"
      />
    </svg>
  );
}

/*
 * 以下は検討盤の操作パネル用（prd/12 §3.2・決定 2026-08-29）。**アイコン化して 1 行に
 * 収める**（「評価する」は決定 2026-09-01 でコントローラー行へ移り、パネルからは外れた）。
 * 線の太さは 2（コントローラー行の chevron と並ぶため）。
 */

/** 棋譜に戻る（arrow-uturn-left）。検討を捨てて棋譜の局面へ帰る */
export function ArrowUturnLeftIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
    </svg>
  );
}

/** 手番を入れ替える（arrows-right-left） */
export function ArrowsRightLeftIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

/** ホーム（home） */
export function HomeIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  );
}

/** 元の対局（棋譜を開く。book-open） */
export function BookOpenIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
    </svg>
  );
}

/** やり直す（回転矢印 1 本。自作——1 手戻すの arrow-uturn-left と紛れないように） */
export function ArrowRestartIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9" />
    </svg>
  );
}

/** 自明だった＝以後出さない（eye-slash） */
export function EyeSlashIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      strokeWidth={2}
      stroke="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

/**
 * 出題の入口のアイコン（prd/13 §7.6）。駒の形に 1 文字（詰・次・誤）、おすすめは詰と次の駒を 2 枚重ねる。
 * ⚠ heroicons ではなく自作。文字は SVG の text ではなく HTML の文字で重ねる——**ボタンのラベルと同じ書体・大きさ・太さを継ぐ**
 * （SVG の text だと駒の寸法に連れて縮み、ラベルと揃わなかった）。おすすめの重ねた駒だけは SVG の text（2 枚を 1 つの絵として描くため）
 */
const PIECE_PATH = 'M12 1.25 18.75 4.5 21.25 22.75H2.75L5.25 4.5Z';

function PieceKanjiIcon({ kanji, className = 'size-5' }: { kanji: string; className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`} aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        width="24"
        height="24"
        strokeWidth={2}
        stroke="currentColor"
        strokeLinejoin="round"
        className="absolute inset-0 size-full"
      >
        <path d={PIECE_PATH} />
      </svg>
      <span className="relative translate-y-[0.15em]">{kanji}</span>
    </span>
  );
}

/** 2 枚の駒を重ねる（後ろの駒は前の駒の形で mask する——どの背景の上でも重なりが透ける） */
function StackedPiecesIcon({ back, front, className = 'h-5' }: { back: string; front: string; className?: string }) {
  const id = useId();
  const dx = 11;
  const dy = 3;
  const w = dx + 24;
  const h = dy + 24;
  const frontAt = `translate(${dx} ${dy})`;
  const label = (k: string) => (
    <text x="12" y="17.6" textAnchor="middle" fontSize="10" fontWeight="700" fill="currentColor" stroke="none">
      {k}
    </text>
  );
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      strokeWidth={2}
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${className} w-auto`}
    >
      <defs>
        <mask id={id}>
          <rect width={w} height={h} fill="white" />
          <path transform={frontAt} d={PIECE_PATH} fill="black" stroke="black" strokeWidth={5} />
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <path d={PIECE_PATH} />
        {label(back)}
      </g>
      <g transform={frontAt}>
        <path d={PIECE_PATH} />
        {label(front)}
      </g>
    </svg>
  );
}

/** 出題の入口（おすすめ・詰将棋・次の一手・間違えた問題）のアイコン。`size` は高さの Tailwind の数値（例 `7` で 28px） */
export function DrillModeIcon({ mode, size = 7 }: { mode: 'recommend' | 'mate' | 'best' | 'wrong'; size?: 5 | 7 }) {
  const box = size === 7 ? 'size-7' : 'size-5';
  if (mode === 'recommend') return <StackedPiecesIcon back="詰" front="次" className={size === 7 ? 'h-7' : 'h-5'} />;
  return <PieceKanjiIcon kanji={{ mate: '詰', best: '次', wrong: '誤' }[mode]} className={box} />;
}
