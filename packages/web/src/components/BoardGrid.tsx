import clsx from 'clsx';
import type { BoardState, HandPieceKind, PieceKind, Side, SquareRef } from 'shared';
import type { StudySelection } from '../lib/study';
import { PlusIcon } from './icons';

/**
 * 盤の見た目（9x9 + 筋段のラベル）と持ち駒表示。
 *
 * 🔒 **盤の見た目は 1 箇所に保つ。** 棋譜詳細（`ShogiBoard` → `StudyBoard`）と
 * 局面検索（`routes/positions.tsx`）の両方がここを使う。複製しない。
 *
 * ⚠ `ShogiBoard` から切り出したのは、検討盤（`StudyBoard`）が盤を描くため。
 * `ShogiBoard` に置いたままだと `ShogiBoard → StudyBoard → ShogiBoard` の循環 import になる。
 *
 * マスの寸法は CSS（`app.css` の `--sq`）が**幅と高さから算出**する（prd/12 §3.3）。
 * **持ち駒も同じ寸法**にして、そのままタップして打てるようにする（prd/12 §3.2）。
 * ここには固定寸法を書かない。
 */

export const PIECE_DISPLAY: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

export const HAND_ORDER: HandPieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

/** 盤の上側・下側に座る側（反転していなければ後手が上、反転中は先手が上） */
export function handSidesOf(flipped: boolean): { top: Side; bottom: Side } {
  return flipped ? { top: 'sente', bottom: 'gote' } : { top: 'gote', bottom: 'sente' };
}

/**
 * 駒を 180 度回して赤くするか。盤の駒・持ち駒・成 / 不成の選択肢のすべてがこれを使う。
 * 🔒 **上側に座る側の駒を回す**（{@link handSidesOf} と同じ割り当てから導く）
 */
export function isUpsideDown(side: Side, flipped: boolean): boolean {
  return handSidesOf(flipped).top === side;
}

const COL_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
const ROW_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function HandDisplay({
  hand,
  side,
  name,
  flipped = false,
  onPieceClick,
  selected,
  onTrayClick,
}: {
  hand: Partial<Record<PieceKind, number>>;
  side: 'sente' | 'gote';
  name?: string | null;
  /** 盤の反転。反転中は先手の駒を 180 度回す（盤の駒と同じ規則） */
  flipped?: boolean;
  /**
   * 持ち駒を叩いたときに呼ぶ（検討盤のタップ 2 段。prd/12 §3.1）。
   * ⚠ **渡さなければ表示専用**（駒はボタンにならない）。局面検索（`/positions`）は
   * 渡さないので、寸法が揃うだけで叩けはしない。
   */
  onPieceClick?: (kind: HandPieceKind) => void;
  /** 選択中の持ち駒。盤の選択マスと同じ見せ方で強調する */
  selected?: HandPieceKind | null;
  /**
   * 駒台の受け皿（「+」ボタン）を叩いたときに呼ぶ。盤の駒を選んでいる間だけ渡す想定で、
   * **渡したときだけ「+」が出る**（prd/12 §3.2）。
   *
   * 🔒 **見えることと押せることを 1 つの条件で決める。** 渡さなければボタン自体が
   * 描かれないので、「押せるのに見えない / 見えるのに押せない」が起きない。
   * 選んでいないときに「+」が並んでいても意味が読めないため、そのときは渡さない。
   */
  onTrayClick?: () => void;
}) {
  const pieces = HAND_ORDER.flatMap((kind) => {
    const count = hand[kind];
    return count ? [{ kind, count }] : [];
  });
  const symbol = side === 'sente' ? '☗' : '☖';
  const label = name ?? (side === 'sente' ? '先手' : '後手');
  // 盤の駒と同じ規則: 相手側（反転中は先手側）の駒を 180 度回して赤くする
  const rotate = isUpsideDown(side, flipped);

  /*
    🔒 **行の高さは中身によらず 1 マスぶん**（`.shogi-hand-row`）。受け皿の「+」は
    駒と同じ寸法（`.shogi-hand-piece`）なので、出入りしても行の高さは変わらない
    （prd/05 §2.1・盤ごと下の操作ボタンがずれない）。

    🔴 **「+」は駒の並びの左端（＝空き側）に置く。** 駒の並びは `ml-auto` で**右に
    寄せてある**ので、左端に足すと**ボタンは空き部分へ伸びるだけで、既に並んでいる駒は
    1px も動かない**。末尾（右端）に足すと、出入りのたびに駒が左右へずれる。
    位置としても、空き部分に接する側にあるので「ここに置ける」と読める。

    🔴 **色は盤の選択ハイライトと同じ `secondary` 系で塗る。** 破線の枠 + 弱色では
    「押せる場所」だと分からなかった（実機の指摘）。⚠ その前は**行全体**を薄く光らせて
    いて「目立ちすぎる」と言われている——**面積が駒 1 個ぶんに限られていることが前提**で
    色を強めている。行全体を光らせる形には戻さない。
  */
  const addButton = onTrayClick ? (
    <button
      type="button"
      className="shogi-hand-piece flex items-center justify-center rounded bg-secondary text-secondary-content ring-2 ring-secondary ring-inset"
      aria-label={`${label}の駒台へ置く`}
      title="選んでいる駒をこの駒台へ移す"
      onClick={onTrayClick}
    >
      {/* ⚠ 寸法は CSS で当てる。`className` は既定の `size-5` を置き換えるので、
          寸法クラスを持たない値を渡すと iOS で潰れる（`icons.tsx` 冒頭） */}
      <PlusIcon className="shogi-hand-add-icon" />
    </button>
  ) : null;

  return (
    <div className="shogi-hand-row text-sm lg:text-base flex items-center gap-1 no-tap-select">
      <span className="font-semibold whitespace-nowrap">{symbol}{label}</span>
      <div className="ml-auto flex items-center">
        {addButton}
        {/* 「なし」は空のときだけ。⚠ 「+」が出ているならそちらが空きを示すので出さない */}
        {pieces.length === 0 && addButton === null && (
          <span className="text-base-content/50">なし</span>
        )}
        {pieces.map(({ kind, count }) => {
          const isSelected = selected === kind;
          const className = clsx(
            'shogi-hand-piece relative flex items-center justify-center font-bold rounded',
            isSelected && 'bg-secondary/40 ring-2 ring-secondary ring-inset',
          );
          const content = (
            <>
              <span className={clsx('inline-block', rotate && 'rotate-180 text-error')}>
                {PIECE_DISPLAY[kind]}
              </span>
              {/* 枚数は右上に上付きで重ねる。1 枚なら出さない（盤の駒と同じ密度に保つ） */}
              {count > 1 && (
                <span className="shogi-hand-count absolute right-0 top-0 font-mono text-base-content/70">
                  {count}
                </span>
              )}
            </>
          );
          if (!onPieceClick) {
            return (
              <div key={kind} className={className}>
                {content}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={kind}
              className={className}
              aria-label={`${label}の持ち駒 ${PIECE_DISPLAY[kind]}${count}枚`}
              onClick={() => onPieceClick(kind)}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 盤の上に重ねる「成」「不成」の選択（出題。prd/13 §7.1・2026-10-29）。
 * 成った駒と成らない駒の 2 つを、行き先のマスの上に並べて出す（多くの将棋アプリと同じ形）。
 */
export interface PromotionChoice {
  /** 行き先のマス（`board` の添字。反転していても盤の向きで渡す） */
  square: SquareRef;
  /** 動かした駒の側（駒の向きを盤と揃える） */
  side: Side;
  /** 成らない形の駒 */
  piece: PieceKind;
  onChoose: (promote: boolean) => void;
  /** 選択肢の外（盤のほかのマス・筋段のラベル）を叩いた */
  onCancel: () => void;
}

export function BoardGrid({
  state,
  lastMoveTo,
  flipped,
  onSquareClick,
  selected,
  destinations,
  promotionChoice,
}: {
  state: BoardState;
  lastMoveTo: [number, number] | null;
  flipped: boolean;
  /**
   * マスを叩いたときに呼ぶ（検討盤のタップ 2 段。prd/12 §3.1）。
   * ⚠ **渡さなければ従来どおりの表示専用**（マスはボタンにならない）。局面検索
   * （`/positions`）は渡さないので挙動が変わらない。
   */
  onSquareClick?: (square: SquareRef) => void;
  /** 選択中のマス（タップ 1 段目）。行き先を選ぶまで強調する */
  selected?: SquareRef | null;
  /**
   * 着手可能マス（出題。prd/13 §3）。**渡さなければ何も変わらない**——検討盤は
   * フル編集で「動けるマス」という概念自体を持たないので渡さない。
   * 🔒 **盤の見た目の助けであって、合否の判定には使わない**（判定は server。prd/13 §5）。
   */
  destinations?: SquareRef[] | null;
  /**
   * 成 / 不成の選択を盤の上に重ねる（出題。prd/13 §7.1）。**渡さなければ何も変わらない**。
   * 出している間は盤全体を覆い、選択肢の外を叩くと `onCancel` を呼ぶ（マスの `onSquareClick` は呼ばない）
   */
  promotionChoice?: PromotionChoice | null;
}) {
  const colLabels = flipped ? [...COL_LABELS].reverse() : COL_LABELS;
  const rowLabels = flipped ? [...ROW_LABELS].reverse() : ROW_LABELS;
  const rowOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const colOrder = flipped ? [8, 7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div className={clsx('shogi-board', promotionChoice && 'relative')}>
      {/* 筋番号（1行目） */}
      {colLabels.map((col) => (
        <div
          key={`col-${col}`}
          className="shogi-label flex items-end justify-center text-base-content/50"
        >
          {col}
        </div>
      ))}
      <div />
      {/* 盤面 9x9 + 段番号 */}
      {rowOrder.flatMap((rowIdx, ri) => [
        ...colOrder.map((colIdx) => {
          const sq = state.board[rowIdx][colIdx];
          const isLastMove = lastMoveTo !== null && lastMoveTo[0] === rowIdx && lastMoveTo[1] === colIdx;
          const isSelected = selected != null && selected.row === rowIdx && selected.col === colIdx;
          const className = clsx(
            'shogi-square border border-base-300 flex items-center justify-center font-bold',
            isLastMove && 'bg-primary/15',
            // 行き先の候補。⚠ **選択マスより弱く**——強調が同じ強さだと、
            // どこを選んでいるのかが読めなくなる
            destinations?.some((d) => d.row === rowIdx && d.col === colIdx) &&
              'bg-info/20',
            // 選択中は最後手の強調より優先させる（今まさに操作している場所なので）
            isSelected && 'bg-secondary/40 ring-2 ring-secondary ring-inset',
          );
          const content = sq && (
            <span
              className={clsx(
                'inline-block',
                isUpsideDown(sq.side, flipped) && 'rotate-180 text-error',
              )}
            >
              {PIECE_DISPLAY[sq.kind]}
            </span>
          );
          const key = `${rowIdx}-${colIdx}`;
          if (!onSquareClick) {
            return (
              <div key={key} className={className}>
                {content}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={key}
              className={className}
              aria-label={`${9 - colIdx}${ROW_LABELS[rowIdx]}`}
              onClick={() => onSquareClick({ row: rowIdx, col: colIdx })}
            >
              {content}
            </button>
          );
        }),
        <div
          key={`row-${ri}`}
          className="shogi-label flex items-center justify-center text-base-content/50"
        >
          {rowLabels[ri]}
        </div>,
      ])}
      {promotionChoice && <PromotionPicker choice={promotionChoice} flipped={flipped} />}
    </div>
  );
}

/**
 * 盤と上下の駒台（検討盤・出題の解く画面。prd/12 §3.2・prd/13 §7.1）。
 *
 * 🔒 **駒台の上下（どちらの持ち駒をどちらに置くか）は {@link handSidesOf} の 1 か所で決める**——
 * 呼び出し側ごとに反転の割り当てを書くと、片方だけ逆になる。
 * ⚠ 器（`className`）を渡さなければ 3 つの要素をそのまま並べる（呼び出し側の並べ方に任せる）。
 */
export function BoardWithHands({
  state,
  flipped,
  lastMoveTo = null,
  names,
  selection,
  onSquareClick,
  destinations,
  promotionChoice,
  onHandPieceClick,
  onTrayClick,
  className,
  boardClassName,
}: {
  state: BoardState;
  flipped: boolean;
  lastMoveTo?: [number, number] | null;
  /** 駒台に出す対局者名（省けば「先手」「後手」） */
  names?: { sente?: string | null; gote?: string | null };
  /** 選択中のマス・持ち駒（`lib/study.ts` のタップ 2 段）。持ち駒は持ち主の駒台でだけ強調する */
  selection?: StudySelection | null;
  onSquareClick?: (square: SquareRef) => void;
  destinations?: SquareRef[] | null;
  promotionChoice?: PromotionChoice | null;
  /** その側の持ち駒を叩く口。**undefined を返した側は表示専用**（駒はボタンにならない） */
  onHandPieceClick?: (side: Side) => ((kind: HandPieceKind) => void) | undefined;
  /** その側の駒台の受け皿（「+」）。undefined を返した側には出ない（{@link HandDisplay} の `onTrayClick`） */
  onTrayClick?: (side: Side) => (() => void) | undefined;
  /** 3 つを包む器のクラス。省けば包まない */
  className?: string;
  /** 盤だけを包む器のクラス。省けば包まない */
  boardClassName?: string;
}) {
  const { top, bottom } = handSidesOf(flipped);
  const hand = (side: Side) => (
    <HandDisplay
      hand={state.hand[side]}
      side={side}
      name={names?.[side]}
      flipped={flipped}
      onPieceClick={onHandPieceClick?.(side)}
      selected={selection?.kind === 'hand' && selection.side === side ? selection.piece : null}
      onTrayClick={onTrayClick?.(side)}
    />
  );
  const grid = (
    <BoardGrid
      state={state}
      lastMoveTo={lastMoveTo}
      flipped={flipped}
      onSquareClick={onSquareClick}
      selected={selection?.kind === 'square' ? selection.square : null}
      destinations={destinations}
      promotionChoice={promotionChoice}
    />
  );
  const content = (
    <>
      {hand(top)}
      {boardClassName ? <div className={boardClassName}>{grid}</div> : grid}
      {hand(bottom)}
    </>
  );
  return className ? <div className={className}>{content}</div> : content;
}

/**
 * 成 / 不成の選択（{@link PromotionChoice}）。盤全体を薄く覆う「取り消し」の面の上に、2 つの駒を横に並べる。
 *
 * 🔒 **選択肢は行き先のマスを中心に置き、盤の外へはみ出す分だけ内側へ寄せる**（端の筋・段でも全体が盤に収まる）。
 * 位置は盤の見た目の向き（反転を解いた後）の行・列から、`--sq` の倍数で決める。
 * 🔒 **選択肢の 1 つは 44px を下回らない**（`.shogi-promotion-pick`。`lib/touchTargets.ts` の基準）——
 * 盤のマスはモバイルで 40px 以下になるので、マスの寸法に合わせると押し分けにくい。
 */
function PromotionPicker({ choice, flipped }: { choice: PromotionChoice; flipped: boolean }) {
  // 見た目の行・列（反転中は上下左右が逆）。中心は筋番号の行（0.5 マス）の下から数える
  const visualRow = flipped ? 8 - choice.square.row : choice.square.row;
  const visualCol = flipped ? 8 - choice.square.col : choice.square.col;
  const style = {
    left: `clamp(0px, calc(var(--sq) * ${visualCol + 0.5} - var(--pick)), calc(var(--sq) * 9 - var(--pick) * 2))`,
    top: `clamp(calc(var(--sq) * 0.5), calc(var(--sq) * ${visualRow + 1} - var(--pick) / 2), calc(var(--sq) * 9.5 - var(--pick)))`,
  };
  // 盤の駒と同じ規則: 相手側（反転中は先手側）の駒を 180 度回して赤くする
  const rotate = isUpsideDown(choice.side, flipped);
  const options = [
    { promote: true, kind: `+${choice.piece}` as PieceKind, label: '成る' },
    { promote: false, kind: choice.piece, label: '成らない' },
  ];
  return (
    <div className="shogi-promotion absolute inset-0 z-10">
      <button
        type="button"
        className="absolute inset-0 bg-base-content/20 cursor-default"
        aria-label="指した手を取り消す"
        onClick={choice.onCancel}
      />
      <div
        role="group"
        aria-label="成りますか"
        className="absolute flex rounded shadow-lg ring-2 ring-secondary bg-base-100"
        style={style}
      >
        {options.map(({ promote, kind, label }) => (
          <button
            type="button"
            key={label}
            className="shogi-promotion-pick flex items-center justify-center font-bold hover:bg-secondary/30"
            aria-label={`${label}（${PIECE_DISPLAY[kind]}）`}
            onClick={() => choice.onChoose(promote)}
          >
            <span className={clsx('inline-block', rotate && 'rotate-180 text-error')}>
              {PIECE_DISPLAY[kind]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
