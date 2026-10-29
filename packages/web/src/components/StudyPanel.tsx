import clsx from 'clsx';
import type { Side } from 'shared';
import { ArrowUturnLeftIcon, ArrowsRightLeftIcon } from './icons';
import { useDisplaySize } from '../lib/displaySize';
import { controlButtonsOf } from '../lib/touchTargets';

/**
 * 検討盤の操作パネル（バッジ + 棋譜に戻る + 手番 + 成 / 不成。prd/12 §3.1）。`StudyBoard` から切り出した。
 * **検討中だけ出す**（段階的開示）のは呼び出し側。操作の中身（検討セッションの更新）も呼び出し側が持つ。
 *
 * 🔒 操作ボタンの大きさは棋譜の操作行（`BoardControls`）と同じ設定で切り替わる（`lib/touchTargets.ts`）。
 */
export function StudyPanel({
  replaying,
  sideToMove,
  canTogglePromotion,
  lastMovePromoted,
  onReset,
  onToggleTurn,
  onTogglePromotion,
}: {
  /** 咎め筋（PV）を再生中か（バッジの文言） */
  replaying: boolean;
  /** 今の手番（手番ボタンの記号） */
  sideToMove: Side;
  /** 「成 / 不成」を押せるか（`lib/study.ts` の `canTogglePromotion`） */
  canTogglePromotion: boolean;
  /** 直前の手が今「成った形」か（ボタンの文言） */
  lastMovePromoted: boolean;
  onReset: () => void;
  onToggleTurn: () => void;
  onTogglePromotion: () => void;
}) {
  const btn = controlButtonsOf(useDisplaySize().displaySize.controlSize);
  return (
    <div className="max-w-3xl flex flex-col gap-2 no-tap-select">
      {/*
        🔴 **操作は 1 行に収める**（prd/12 §3.2・決定 2026-08-29）。以前は
        「棋譜に戻る / 手番 / 成にする」と「評価する」が 2 行に分かれ、390px で
        折り返していた。**アイコン化で 1 行に**畳む。
        ⚠ 320px のような狭い幅では折り返して 2 行になる（許容）。パネルは
        コントローラー行より**下**にあるので、折り返しても盤・◀ ▶ は動かない
        （prd/05 §2.1 / PR #105 の教訓）。
        🔒 アイコンのみのボタンには **`aria-label` を必ず付ける**（`title` も残す）。

        🔴 **「評価する」はここには無い**（決定・2026-09-01。以前はここにあった）。
        棋譜再生中・棋譜側の読み筋を辿っている最中でも押せるよう、
        コントローラー行（`BoardControls`）の 7 つ目へ移した——ここに置いたままだと
        **検討していないと押せない**ままになる。「主操作をアイコンに畳まない」も
        同時に撤回した——行の一員になった以上、他の 6 つと同じアイコン + `btn-outline`
        の流儀に揃える（prd/12 §3.2）。
      */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="badge badge-primary badge-sm shrink-0">
          {replaying ? '読み筋を再生中' : '検討中'}
        </span>
        {/*
          🔴 「1手戻す」ボタンは置かない。**◀ が undo を担う**（prd/12 §3.1・
          決定 2026-08-28）。「検討中」バッジが出ていれば棋譜と違う状態にいることは
          分かるので、専用ボタンを増やすより既存の操作子に意味を持たせる。
        */}
        <button
          type="button"
          // 🔴 **枠を付ける**（決定 2026-08-29）。アイコンのみになった以上、枠が
          //    無いとボタンだと分からず、44px のタップ範囲も画面から読めない。
          //    手番・成と同じ見た目に揃える（`btn-ghost` から変更）
          className={clsx(btn.icon, 'btn-outline')}
          onClick={onReset}
          aria-label="棋譜に戻る"
          title="棋譜に戻る（検討を捨てる）"
        >
          <ArrowUturnLeftIcon />
        </button>
        {/*
          🔴 **手番の記号（☗ / ☖）は落とさない**（決定 2026-08-29）。このボタンは
          操作であると同時に「**今どちらの手番か**」の状態表示を兼ねている——手番を
          自由に入れ替えられる検討盤で記号を消すと、今どちら番なのかが画面から消える
          （評価値の視点は手番側なので、読み違いに直結する。prd/12 §2.3）。
        */}
        <button
          type="button"
          className={clsx(btn.glyph, 'btn-outline')}
          onClick={onToggleTurn}
          aria-label={`手番を入れ替える（今は${sideToMove === 'sente' ? '先手' : '後手'}番）`}
          title="手番を入れ替える"
        >
          <ArrowsRightLeftIcon className="size-4 shrink-0" />
          {/*
            ⚠ **記号は少し大きく**（決定 2026-08-29）。390px の実機で ☗ と ☖ の
            塗り分けが判別しづらかった。**文字（先 / 後）を足すのではなく、
            今ある記号を読める大きさにする**（1 行に収める意味が無くなるため）。
          */}
          <span className="shrink-0 text-base leading-none">
            {sideToMove === 'sente' ? '☗' : '☖'}
          </span>
        </button>
        {/*
          ⚠ **条件付きで出入りする**（`canTogglePromotion`）。アイコンではなく
          「成」「不成」の字にしたのは、成 / 不成という将棋の概念に対応する図像が
          無く、字の方が短く読めるため。
        */}
        {/*
          🔴 **出し入れせず、押せないときは無効にする**（決定 2026-08-29）。
          条件付きで消していたので、**成れる手かどうかで操作行の幅が変わり
          他のボタンの位置がズレた**（prd/05 §2.1 の「位置を動かさない」に反する）。
          ⚠ アイコンではなく「成」「不成」の字にしたのは、成 / 不成という将棋の概念に
          対応する図像が無く、字の方が短く読めるため。
          🔴 **駒打ちの直後も押せる**（決定 2026-08-29）——検討盤は合法性を問わない
          フル編集なので、打った駒を成らせるのは局面編集として筋が通る。
          ⚠ その段は採点の対象から外れる（`study.ts` の `StudyStep.faithful`）。
        */}
        <button
          type="button"
          className={clsx(btn.glyph, 'btn-outline')}
          onClick={onTogglePromotion}
          disabled={!canTogglePromotion}
          aria-label={
            lastMovePromoted
              ? '直前の手を不成で指し直す'
              : '直前の手を成で指し直す'
          }
          title={
            canTogglePromotion
              ? '直前の手を成 / 不成で指し直す'
              : '直前が盤上の手・駒打ちで、成れる駒のときだけ切り替えられる'
          }
        >
          {lastMovePromoted ? '不成' : '成'}
        </button>
      </div>
    </div>
  );
}
