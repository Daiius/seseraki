import type { ReactNode, SyntheticEvent } from 'react';
import clsx from 'clsx';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/**
 * 候補手 1 本の行と、その読み筋（PV）の再生（prd/05 §2.2・prd/12 §3.2）。
 *
 * 🔒 **棋譜側の候補手一覧（`ShogiBoard` の `CandidateList`）と検討盤の評価結果（`EvalResultView`）が共用する**
 * ——prd/12 §3.2「候補手は棋譜側の候補手一覧と同じ形に畳む・独自の見せ方を作らない」を、描画を 1 つにすることで守る。
 * **再生の状態（どの候補を何手目まで）は呼び出し側が持つ**（棋譜側は `branchRank` / `branchDepth`、検討盤は `replay`）。
 * ここは描くだけ。
 *
 * - md 未満は畳む（`summary` の右端に `PV{n} ▼`）。md 以上は常時展開（`app.css` の `details[name=…]` の規則）
 * - `name` で排他アコーディオンにする（棋譜側と検討盤で別の名前にして、開閉の単位を混ぜない）
 * - 🔴 **再生位置の手は読み筋の中で太字にする**（太字以外の装飾は足さない。prd/12 §3.2）
 */
export function CandidateLine({
  name,
  className,
  active = false,
  onToggle,
  rank,
  moveText,
  scoreText,
  depth,
  marks,
  pv,
  replay,
}: {
  /** 排他アコーディオンの名前 */
  name: string;
  /** `details` に足すクラス（実手・悪手の枠など） */
  className?: string;
  /** この候補の読み筋を再生している（{@link PvLine} の `active`） */
  active?: boolean;
  onToggle?: (e: SyntheticEvent<HTMLDetailsElement>) => void;
  rank: number;
  /** 手番記号付きの指し手（例 `▲７六歩(77)`） */
  moveText: string;
  scoreText: string;
  depth: number;
  /** 深さの後ろに並べる印（棋譜側の「実手」・悪手の記号など） */
  marks?: ReactNode;
  /** 読み筋を 1 手ずつ日本語にしたもの（`lib/usi.ts` の `pvTexts`）。空なら読み筋と再生は出さない */
  pv: string[];
  replay: PvReplayControls;
}) {
  return (
    <PvLine
      name={name}
      className={className}
      active={active}
      onToggle={onToggle}
      collapse="mobile"
      countText={`PV${pv.length}`}
      summary={
        <>
          <span className="font-mono text-base-content/50">{rank}</span>
          <span className="font-bold">{moveText}</span>
          <span className="text-base-content/70">{scoreText}</span>
          <span className="text-xs text-base-content/40">d{depth}</span>
          {marks}
        </>
      }
      texts={pv}
      position={replay.position}
    >
      <PvReplay {...replay} pvLen={pv.length} />
    </PvLine>
  );
}

/**
 * 読み筋 1 本の外枠（見出しの行 + 畳める手の並び）。🔒 **棋譜側の候補手（`CandidateLine`）と出題の手順の再生（`DrillReplay`）が共用する**。
 *
 * - `name` で排他アコーディオンにする（開いているのは 1 本だけ）
 * - 畳んだ見出しの右端に手数（`PV{n}` / `{n}手`）と ▼ を出す
 * - 🔴 **再生している読み筋は左に太い線を引く**（`active`。棋譜側の分岐の再生と同じ印）。どれを再生しているかを、開閉と別に示す
 * - `collapse="mobile"` は md 未満だけ畳む（md 以上は `app.css` の `details[name=…]` の規則で常時展開。棋譜側の候補手）。
 *   `"always"` はどの幅でも畳む（出題の手順。再生していない手順を畳む）
 * - 開閉を呼び出し側が持つときは `open` と `onSummaryClick` を渡す（見出しを叩いたときの既定の開閉は止める）
 */
export function PvLine({
  name,
  className,
  active = false,
  open,
  onToggle,
  onSummaryClick,
  collapse,
  countText,
  summary,
  texts,
  position,
  children,
}: {
  name: string;
  className?: string;
  active?: boolean;
  /** 開閉を呼び出し側が持つ（省けば `details` の既定の開閉） */
  open?: boolean;
  onToggle?: (e: SyntheticEvent<HTMLDetailsElement>) => void;
  /** 見出しを叩いた（渡したら既定の開閉は止める） */
  onSummaryClick?: () => void;
  collapse: 'mobile' | 'always';
  /** 畳んだ見出しの右端に出す手数 */
  countText: string;
  /** 見出しの行の中身 */
  summary: ReactNode;
  /** 手の並び（手番記号付き）。空なら畳む中身を出さない */
  texts: readonly string[];
  /** 再生位置（{@link PvMoves}。再生していなければ 0） */
  position: number;
  /** 手の並びの下に置くもの（棋譜側の ◀ n/N ▶） */
  children?: ReactNode;
}) {
  const mobileOnly = collapse === 'mobile';
  return (
    <details
      name={name}
      open={open}
      className={clsx('group rounded-lg p-2', className, active && 'border-l-4 border-l-primary pl-3')}
      onToggle={onToggle}
    >
      <summary
        className={clsx(
          'flex items-center gap-2 list-none cursor-pointer [&::-webkit-details-marker]:hidden',
          mobileOnly && 'md:cursor-default',
        )}
        onClick={
          onSummaryClick
            ? (e) => {
                e.preventDefault();
                onSummaryClick();
              }
            : undefined
        }
      >
        {summary}
        {texts.length > 0 && (
          <span className={clsx('ml-auto shrink-0 text-xs text-base-content/40', mobileOnly && 'md:hidden')}>
            {countText}{' '}
            <span className="inline-block transition-transform group-open:rotate-180">▼</span>
          </span>
        )}
      </summary>
      {texts.length > 0 && (
        <>
          <div className="mt-1 font-mono text-xs text-base-content/60 pl-5">
            <PvMoves texts={texts} position={position} />
          </div>
          {children}
        </>
      )}
    </details>
  );
}

/**
 * 読み筋の手の並び。🔴 **太字にするのは `position - 1` の手——いま盤に出ている局面へ至った直前の手**（prd/12 §3.2）。
 * 太字以外の装飾は足さない（{@link PvLine} の中で使う）
 */
export function PvMoves({ texts, position }: { texts: readonly string[]; position: number }) {
  return texts.flatMap((text, j) => {
    const node =
      j === position - 1 ? (
        <strong key={j} className="text-base-content font-bold">
          {text}
        </strong>
      ) : (
        <span key={j}>{text}</span>
      );
    return j > 0 ? [' ', node] : [node];
  });
}

/** 読み筋の再生ボタン（◀ `n/N` ▶）。状態は呼び出し側が持つ */
export interface PvReplayControls {
  /** 再生している手数（この候補を再生していなければ 0） */
  position: number;
  onBack: () => void;
  onForward: () => void;
  backDisabled: boolean;
  forwardDisabled: boolean;
  /** ボタンのクラス（棋譜側は `btn btn-sm`、検討盤は表示サイズの設定に従う） */
  buttonClassName: string;
  /** ボタンの名前（`aria-label`） */
  labels: { back: string; forward: string };
  /** 名前を `title`（ホバーの説明）にも出す */
  titled?: boolean;
  /** 再生ボタンの後ろに並べるもの（検討盤の「再生をやめる」） */
  extra?: ReactNode;
}

function PvReplay({
  position,
  pvLen,
  onBack,
  onForward,
  backDisabled,
  forwardDisabled,
  buttonClassName,
  labels,
  titled = false,
  extra,
}: PvReplayControls & { pvLen: number }) {
  return (
    <div className="mt-2 flex items-center gap-2 pl-5 no-tap-select">
      <button
        type="button"
        className={clsx(buttonClassName, 'btn-outline')}
        onClick={onBack}
        disabled={backDisabled}
        aria-label={labels.back}
        title={titled ? labels.back : undefined}
      >
        <ChevronLeftIcon />
      </button>
      <span className="text-sm font-mono text-base-content/60 w-12 text-center">
        {position}/{pvLen}
      </span>
      <button
        type="button"
        className={clsx(buttonClassName, 'btn-outline')}
        onClick={onForward}
        disabled={forwardDisabled}
        aria-label={labels.forward}
        title={titled ? labels.forward : undefined}
      >
        <ChevronRightIcon />
      </button>
      {extra}
    </div>
  );
}
