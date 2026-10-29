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
  /** `details` に足すクラス（実手・悪手の枠・再生中の強調など） */
  className?: string;
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
  const pvLen = pv.length;
  return (
    <details name={name} className={clsx('group rounded-lg p-2', className)} onToggle={onToggle}>
      <summary className="flex items-center gap-2 list-none cursor-pointer md:cursor-default [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-base-content/50">{rank}</span>
        <span className="font-bold">{moveText}</span>
        <span className="text-base-content/70">{scoreText}</span>
        <span className="text-xs text-base-content/40">d{depth}</span>
        {marks}
        {pvLen > 0 && (
          <span className="ml-auto text-xs text-base-content/40 md:hidden">
            PV{pvLen}{' '}
            <span className="inline-block transition-transform group-open:rotate-180">▼</span>
          </span>
        )}
      </summary>
      {pvLen > 0 && (
        <>
          <div className="mt-1 font-mono text-xs text-base-content/60 pl-5">
            {pv.flatMap((text, j) => {
              // 🔴 太字にするのは `position - 1` の手——**いま盤に出ている局面へ至った直前の手**
              const node =
                j === replay.position - 1 ? (
                  <strong key={j} className="text-base-content font-bold">
                    {text}
                  </strong>
                ) : (
                  <span key={j}>{text}</span>
                );
              return j > 0 ? [' ', node] : [node];
            })}
          </div>
          <PvReplay {...replay} pvLen={pvLen} />
        </>
      )}
    </details>
  );
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
