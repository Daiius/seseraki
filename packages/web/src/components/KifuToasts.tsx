import { type ReactNode } from 'react';
import clsx from 'clsx';
import { type AnalysisProfile } from '../lib/analysisProgress';
import { AnalyzingRadial } from './AnalyzingRadial';

/**
 * 棋譜詳細（`/kifus/$id`）の通知を画面右上に浮かせる器（daisyUI `toast`）。
 *
 * 🔒 **本文のレイアウトに場所を取らせない**（決定・2026-09-27。prd/05 §2.5）。通知を本文に
 * インラインで置くと、出たり消えたりするたびに盤や再生コントロールが上下にずれる。
 * 複数が同時に出たら daisyUI の toast のとおり縦に積む。
 *
 * 位置と重なりの決め方:
 * - **top**: navbar（`__root.tsx`・`min-height: 4rem`・fixed ではない）の高さ + 本文の上余白
 *   （`main` の `p-4`）= `5rem`。スクロールしていない状態で本文の上端に揃う。
 * - **右端**: 詳細ヘッダーのケバブ「⋯」（44px・本文の右端）を避けて、その左に置く
 *   （`1rem` + `2.75rem` + 隙間 `0.5rem` = `4.25rem`）。解析中の pill は数分出続けるので、
 *   取り返しのつかない操作の入口を覆わないことを優先した。幅は `max-width` で画面内に収め、
 *   狭い幅でも横スクロールを生まない。
 * - **z-index**: `15`。盤のまとまり（`ShogiBoard` の `sticky top-0 z-10`）より上、ケバブの
 *   ドロップダウン（`z-20`）と navbar（`z-30`）のメニューより下——開いたメニューは覆わない。
 *
 * `floating={false}` は DEV ギャラリー用で、fixed を外してその場に並べる。
 */
export function ToastStack({
  children,
  floating = true,
}: {
  children: ReactNode;
  floating?: boolean;
}) {
  return (
    <div
      className={clsx(
        floating
          ? 'toast toast-top toast-end z-[15] top-20 end-[4.25rem] max-w-[min(24rem,calc(100vw_-_5.25rem))]'
          : 'flex flex-col items-end gap-2',
      )}
    >
      {children}
    </div>
  );
}

/** 閉じるボタン（× ）。エラーは自動で消さないので、利用者が閉じる手段を置く */
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs btn-square self-start"
      aria-label="閉じる"
      onClick={onClick}
    >
      ✕
    </button>
  );
}

/**
 * 解析中の進捗 pill（小さな円環 + 「解析中」）。
 *
 * 🔴 **段階（`profile`）は文言に出さない**（prd/05 §2.5・決定 2026-09-05 後段）。
 * 段階は円環の濃さで示す（quick 進行中は半透明・full 進行中は通常）。
 *
 * N/M は `title` / `aria-label` に入れ、目に見える文字は円環の中央の % だけにする。
 * 「◯前に更新」の経過時間は細かすぎるので出さない（決定・2026-09-27）。
 *
 * `estimated`（標本の間を埋めた推定値・小数）は**円環の伸びにだけ**使う。
 * **N/M と % は実データ（`analyzed`）のまま**——数字まで推定にすると
 * 「何局面終わったか」が嘘になる（決定・2026-09-07。prd/05 §2.5）。
 */
export function AnalyzingToast({
  profile,
  analyzed,
  estimated,
  total,
}: {
  profile: AnalysisProfile;
  analyzed: number;
  /** 円環に出す推定値（省略時は実データのまま） */
  estimated?: number;
  total: number;
}) {
  const text = `解析中 ${analyzed}/${total}`;
  return (
    <div
      role="status"
      aria-label={text}
      title={text}
      className="flex items-center gap-2 self-end rounded-full bg-base-100 py-1 ps-1 pe-3 text-sm shadow-lg border border-base-300"
    >
      <AnalyzingRadial
        profile={profile}
        analyzed={analyzed}
        estimated={estimated}
        total={total}
        size="toast"
      />
      <span aria-hidden>解析中</span>
    </div>
  );
}

/**
 * 削除・再解析の結果通知。成功・情報は呼び出し側で数秒後に消し、エラーは × で閉じるまで残す
 * （見落とすと「押しても何も起きない」に見えるため）。
 */
export function ActionResultToast({
  kind,
  message,
  onClose,
}: {
  kind: 'error' | 'info';
  message: string;
  onClose: () => void;
}) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={clsx(
        'alert shadow-lg py-2 flex items-start gap-2',
        kind === 'error' ? 'alert-error' : 'alert-info',
      )}
    >
      <span className="flex-1 min-w-0 break-words">{message}</span>
      <CloseButton onClick={onClose} />
    </div>
  );
}

/**
 * 解析失敗の通知。再解析ボタンを中に持つ（失敗棋譜の再試行の入口）。
 *
 * ⚠ 表示条件（`analysisError` があれば出す）は呼び出し側で緩めてある（prd/05 §1.1d）。
 * quick 完了後に詳細解析が失敗した棋譜は、**quick の結果を見せたまま**この失敗表示が出る。
 * 文言は段階で変えない（決定・2026-09-05 後段）。
 */
export function AnalysisErrorToast({
  error,
  onReanalyze,
  onClose,
  busy,
}: {
  error: string;
  onReanalyze: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    // 狭い幅でも本文に横幅を回すため、ボタンは本文の下に置く（横に並べると 320px 幅で
    // 本文が 1 語ずつに割れた）
    <div
      role="alert"
      className="alert alert-error shadow-lg py-2 flex flex-col items-stretch gap-1"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 font-semibold">解析失敗</div>
        <CloseButton onClick={onClose} />
      </div>
      {/* `break-all` は短い語まで途中で割るので使わない。長い一語（パスや指し手列）だけを
          折り返す `overflow-wrap: anywhere` にする */}
      <div className="text-sm font-mono [overflow-wrap:anywhere] opacity-90">
        {error}
      </div>
      {/* 押せない間も赤地の上で読めるよう、daisyUI の既定（背景に溶ける薄い灰色）を上書きする */}
      <button
        className="btn btn-sm self-end disabled:bg-base-100/70 disabled:text-base-content/70 disabled:border-transparent"
        onClick={onReanalyze}
        disabled={busy}
      >
        再解析
      </button>
    </div>
  );
}
