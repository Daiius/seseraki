import { useRef, useState, type ReactNode, type Ref } from 'react';
import clsx from 'clsx';
import { Link } from '@tanstack/react-router';
import {
  applyMove,
  positionSfen,
  usiToJapaneseWithPiece,
  type BoardState,
} from 'shared';
import {
  turnSymbol,
  formatScore,
  formatScoreShort,
  mateLineOf,
  moveDestination,
  toSenteEval,
} from '../lib/usi';
import { StudyBoard } from './StudyBoard';
import type { StudySession } from '../lib/study';
import { BoardControls } from './BoardControls';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import {
  computeMoveLosses,
  formatLoss,
  labelOf,
  labelText,
  type MoveLabel,
  type MoveLoss,
  type Thresholds,
} from '../lib/cpl';
import { EvalGraph } from './EvalGraph';
import type { AnalysisProfile } from '../lib/analysisProgress';

const ICON_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 2,
  stroke: 'currentColor',
  className: 'size-5',
} as const;

const IconSearch = () => (
  <svg {...ICON_PROPS} className="size-4 md:hidden">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m2.1-5.4a7.5 7.5 0 11-15 0 7.5 7.5 0 0115 0z" />
  </svg>
);

interface Analysis {
  id: number;
  moveNumber: number;
  /**
   * 解析段階（prd/05 §1.1d）。full の進行中は 1 棋譜の中で quick と full が混ざりうる。
   * 🔴 **UI は段階を文字で示さない**（決定・2026-09-05 後段）——混在は仕様だが、
   * 直後に詳細解析で上書きされる一時的な状態にモバイルの横幅を割かない。
   * API から読める値としては持つ（来歴・キューの段階判定に使う）。
   */
  profile: AnalysisProfile;
  candidates: {
    id: number;
    rank: number;
    move: string;
    scoreType: string;
    scoreValue: number;
    pv: string[] | null;
    depth: number;
  }[];
}

interface Props {
  usiMoves: string[];
  /** usiMoves から構築済みの全局面（ページ側で 1 度だけ構築して渡す） */
  positions: BoardState[];
  analyses: Analysis[];
  sente?: string | null;
  gote?: string | null;
  /**
   * 主体の手番（prd/11 §4）。**server が導出した値**を渡す。
   * ⚠ null は「自分の側が決まらない」——理由（両対局者とも候補に一致 / 名前候補が未設定 /
   * 自分の対局ではない）はここでは区別しない。**全体の件数は `/settings` で見える**
   *
   * 🔒 **必須にする**（`?` を付けない）。省略できると、渡し忘れたときに
   * 「主体側が決まらない」と同じ見た目になり、**盤の反転も自分視点の評価も静かに消える**。
   */
  subjectSide: 'sente' | 'gote' | null;
  /** 悪手判定の閾値（ページ側で localStorage から読み込んで配る） */
  thresholds: Thresholds;
  /**
   * 表示を開始する手数（既定 0 = 初期局面）。
   * **DEV ギャラリーで表示状態を固定するための入口**（`/dev-gallery`）。通常の閲覧は
   * 初期局面から始めるので渡さない。範囲外の値は端に丸める。
   */
  initialMoveIndex?: number;
  /**
   * 検討セッションの初期状態。**DEV ギャラリー用**（`initialMoveIndex` と同じ趣旨）。
   * 検討中の見え方——候補手を出さない・評価値グラフから手送りできない
   * （prd/12 §3.1・決定 2026-08-29）——を実物のまま並べるための入口で、通常は渡さない。
   */
  initialStudySession?: StudySession;
}


export function ShogiBoard({ usiMoves, positions, analyses, sente, gote, subjectSide, thresholds, initialMoveIndex = 0, initialStudySession }: Props) {
  const sortedAnalyses = [...analyses].sort((a, b) => a.moveNumber - b.moveNumber);
  const losses = computeMoveLosses(sortedAnalyses, usiMoves);
  const userSide = subjectSide ?? null;

  const totalMoves = positions.length - 1;
  const [moveIndex, setMoveIndex] = useState(
    Math.min(Math.max(initialMoveIndex, 0), totalMoves),
  );
  const [flipped, setFlipped] = useState(userSide === 'gote');
  const [branchRank, setBranchRank] = useState<number | null>(null);
  const [branchDepth, setBranchDepth] = useState(0);
  const candidateListRef = useRef<HTMLDivElement>(null);

  const goToMain = (newIndex: number) => {
    setMoveIndex(newIndex);
    setBranchRank(null);
    setBranchDepth(0);
    // 本筋を進めたら、開いている候補手 details は内容が変わるので自動で閉じる
    candidateListRef.current
      ?.querySelectorAll<HTMLDetailsElement>('details[open]')
      .forEach((d) => {
        d.open = false;
      });
  };

  // 本筋を 1 手単位で動かす共通口（キーボード操作・盤面の左右タップ）。
  // 端での操作は局面が動かないので何もしない（goToMain は開いている候補手 details を
  // 閉じるため、呼ぶだけで閲覧中の読み筋が消える）。分岐が残っているときは解除のため呼ぶ。
  const navigateMain = (next: number) => {
    if (next !== moveIndex || branchRank !== null) goToMain(next);
  };

  // moveIndex N の盤面 = N 手指した後の局面
  // この局面に至った手の解析 = moveNumber N-1 の解析結果
  // moveIndex 0 の場合は moveNumber 0（初期局面からの候補手）
  const prevAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === (moveIndex > 0 ? moveIndex - 1 : 0),
  );

  // 現在の局面（moveIndex）の解析 → 実手後の局面評価値
  const currentAnalysis = sortedAnalyses.find(
    (a) => a.moveNumber === moveIndex,
  );
  const currentBest = currentAnalysis?.candidates.find((c) => c.rank === 1);

  const evalMoveNumber = moveIndex > 0 ? moveIndex - 1 : 0;

  // 初期局面では「直前の実手」が無いので判定を出さない（evalMoveNumber は 0 に丸められている）
  const currentLoss = moveIndex > 0 ? losses.get(evalMoveNumber) ?? null : null;

  // 分岐モード判定と分岐用データの算出
  const branchCandidate = branchRank !== null
    ? prevAnalysis?.candidates.find((c) => c.rank === branchRank) ?? null
    : null;
  const branchPv = branchCandidate?.pv ?? null;
  const branchActive = branchRank !== null
    && branchDepth > 0
    && branchPv !== null
    && branchPv.length > 0;

  // 表示用：盤面・直前手・直前手前局面・直前手の手番
  let displayState: BoardState;
  let displayedMove: string | undefined;
  let displayedMovePreState: BoardState | undefined;
  let displayedMoveNum = 0;

  if (branchActive && branchPv) {
    const base = positions[evalMoveNumber];
    let st = base;
    let preSt = base;
    for (let i = 0; i < branchDepth; i++) {
      preSt = st;
      st = applyMove(st, branchPv[i]);
    }
    displayState = st;
    displayedMove = branchPv[branchDepth - 1];
    displayedMovePreState = preSt;
    displayedMoveNum = evalMoveNumber + (branchDepth - 1);
  } else {
    displayState = positions[moveIndex];
    if (moveIndex > 0) {
      displayedMove = usiMoves[moveIndex - 1];
      displayedMovePreState = positions[moveIndex - 1];
      displayedMoveNum = moveIndex - 1;
    }
  }

  const lastMoveTo = displayedMove ? moveDestination(displayedMove) : null;

  // 情報行は 1 行に収める（下記）ので、長い符号は truncate される。
  // 全文へ到達する手段として title に同じ文字列を渡すため、ここで 1 度だけ作る。
  const displayedMoveText = displayedMove && displayedMovePreState
    ? `${turnSymbol(displayedMoveNum)}${usiToJapaneseWithPiece(displayedMovePreState, displayedMove)}`
    : null;

  // 情報行に出す局面評価値。分岐を辿っている間は分岐先の値、それ以外は現在局面の最善値。
  // 同じ値を 2 つの形で出す: 広い画面は形勢の言葉つき、狭い画面は短い形（§2.1 / usi.ts）。
  const shownScore = branchActive && branchCandidate
    ? {
        type: branchCandidate.scoreType,
        value: branchCandidate.scoreValue,
        at: evalMoveNumber,
        pv: branchCandidate.pv,
      }
    : currentBest
      ? {
          type: currentBest.scoreType,
          value: currentBest.scoreValue,
          at: moveIndex,
          pv: currentBest.pv,
        }
      : null;
  // `score mate N` は plies（応手込み）なので、読み筋を辿って形が判ったときだけ「N手詰」を名乗る
  const shownMateLine = shownScore
    ? mateLineOf(positions[shownScore.at], shownScore.type, shownScore.value, shownScore.pv)
    : undefined;
  const posEvalText = shownScore
    ? formatScore(shownScore.type, shownScore.value, shownScore.at, shownMateLine)
    : null;
  const posEvalShortText = shownScore
    ? formatScoreShort(shownScore.type, shownScore.value, shownScore.at, shownMateLine)
    : null;

  const onBranchForward = (rank: number, pv: string[]) => {
    if (branchRank === rank) {
      setBranchDepth(Math.min(branchDepth + 1, pv.length));
    } else {
      setBranchRank(rank);
      setBranchDepth(1);
    }
  };

  const onBranchBack = (rank: number) => {
    if (branchRank !== rank) return;
    const next = branchDepth - 1;
    if (next <= 0) {
      setBranchRank(null);
      setBranchDepth(0);
    } else {
      setBranchDepth(next);
    }
  };

  /**
   * キーボードでの棋譜の手送り（prd/05 §2.1）。`←` `→` で 1 手戻る / 進む、
   * `Home` `End` で最初 / 最後へ。分岐中の `←` `→` は分岐内を移動し、
   * 先頭で戻ると本筋へ復帰する（`Home` `End` は常に本筋）。
   *
   * 🔴 **window のリスナは `StudyBoard` が 1 本だけ張る**（prd/12 §3.1・決定 2026-08-28）。
   * 検討中は同じキーが undo / redo になるため、切り替えは検討状態を持つ側に置く。
   * ここは「検討していないときに何をするか」だけを渡す。
   */
  const keyboardNav = {
    back: () => {
      if (branchActive && branchRank !== null) onBranchBack(branchRank);
      else navigateMain(Math.max(0, moveIndex - 1));
    },
    forward: () => {
      if (branchActive && branchRank !== null && branchPv) onBranchForward(branchRank, branchPv);
      else navigateMain(Math.min(totalMoves, moveIndex + 1));
    },
    first: () => navigateMain(0),
    last: () => navigateMain(totalMoves),
  };

  return (
    <div className="flex flex-col">
      {/*
        盤面 + 検討盤（prd/12 §3）。**盤のタップは駒の選択**なので、
        🔴 かつてここにあった「盤面の左右半分タップで 1 手送り」は廃止した
        （決定・2026-08-28。prd/05 §2.1 / prd/12 §3.1）。手送りは下のコントローラー行と
        キーボードに一本化してある。

        検討中の状態は `StudyBoard` が持つ。情報行とコントローラー行を `children` として
        渡し、操作パネルが**それより下**に出るようにしている（パネルが現れても ◀ ▶ の
        位置が動かない。prd/05 §2.1）。
        🔴 **検討中はコントローラー行が検討の操作になる**（◀ ▶ = undo / redo・
        ≪ ≫ = 起点 / 最後へ・スライダーは無効。prd/12 §3.1・決定 2026-08-28）。
        割り当ての切り替えに使う `study` は `StudyBoard` から受け取る。
      */}
      <StudyBoard
        baseState={displayState}
        // 「今どこを見ているか」。分岐中の局面はレンダーごとに作り直されるので、
        // 局面オブジェクトの同一性ではなくこの鍵で作り直しを判定させる
        baseKey={`${moveIndex}:${branchRank ?? '-'}:${branchDepth}`}
        baseLastMoveTo={lastMoveTo}
        flipped={flipped}
        sente={sente}
        gote={gote}
        keyboardNav={keyboardNav}
        // 🔒 直前の手の採点の色分けは**棋譜側の悪手マーカーと同じ閾値**で判定する
        //    （prd/12 §3.2・決定 2026-08-29。1 つの画面に基準を 2 つ持たない）
        thresholds={thresholds}
        // スクロール時に上端へ固定するグループ: 盤面 + コンパクト行 + コントローラー + 操作パネル
        initialSession={initialStudySession}
        groupClassName="sticky top-0 z-10 bg-base-100 shadow-sm flex flex-col gap-3 pb-2"
        /*
          スクロール領域: 候補手 + 評価値グラフ。
          🔴 **検討中かどうかで出し分けるのでここに渡す**（prd/12 §3.1・決定 2026-08-29）。
          検討状態は `StudyBoard` が持つので、`study.studying` を受け取って判断する
          ——`ShogiBoard` に同じ状態をもう 1 つ持たせない。
        */
        footer={(study) => (
          <div className="flex flex-col gap-3 pt-3">
            {/*
              候補手一覧（読み筋付き）。
              🔴 **検討中は出さない**（決定・2026-08-29）。この一覧は棋譜側の `moveIndex` に
              紐づいており、**検討で駒を動かしても一切変わらない**。盤の局面と対応しない
              候補手を同じ画面に置くと、どの局面の話なのか読めなくなる。
              🔒 さらに、ここの「分岐を進む」は `branchRank` / `branchDepth` を動かす
              ＝ `StudyBoard` の `baseKey` を変えるので、**検討セッションが黙って捨てられる**。
              prd/12 §3.1 の「検討を抜けるのは『棋譜に戻る』だけ」に反する出口だった。
            */}
            {!study.studying && prevAnalysis && prevAnalysis.candidates.length > 0 && (
              <div className="max-w-3xl">
                <CandidateList
                  ref={candidateListRef}
                  candidates={prevAnalysis.candidates}
                  played={moveIndex > 0 ? usiMoves[moveIndex - 1] : undefined}
                  evalMoveNumber={evalMoveNumber}
                  positions={positions}
                  moveIndex={moveIndex}
                  loss={currentLoss}
                  label={currentLoss ? labelOf(currentLoss, thresholds) : null}
                  branchRank={branchRank}
                  branchDepth={branchDepth}
                  onBranchForward={onBranchForward}
                  onBranchBack={onBranchBack}
                />
              </div>
            )}

            {/*
              評価値グラフ。
              🔴 **検討中も出したまま**（決定・2026-08-29）。グラフは「棋譜全体の評価値の推移」で
              あって現在局面に紐づく主張が弱く、検討しながら見る価値がある。
              🔒 ただし**クリックによる手送りは無効にする**——`goToMain` は `moveIndex` を
              動かす＝検討を黙って捨てるので、候補手と同じ「余計な出口」になる。
              `onClickMove` を渡さなければクリック層そのものが描かれない。
              ⚠ 現在位置マーカーは棋譜側の `moveIndex`（＝検討の起点）を指したままでよい。
              ⚠ 押せないことは**薄さで示すに留める**（目立たせすぎない）。
            */}
            <div
              className={clsx(study.studying && 'opacity-60')}
              title={study.studying ? '検討中はグラフから手送りできない（棋譜に戻ると押せる）' : undefined}
            >
              <EvalGraph
                analyses={sortedAnalyses}
                currentMove={moveIndex}
                onClickMove={study.studying ? undefined : goToMain}
                losses={losses}
                thresholds={thresholds}
                userSide={userSide}
                branch={
                  branchActive && branchCandidate
                    ? {
                        moveNumber: evalMoveNumber + 1,
                        value: toSenteEval(
                          branchCandidate.scoreType,
                          branchCandidate.scoreValue,
                          evalMoveNumber,
                        ),
                      }
                    : null
                }
              />
            </div>
          </div>
        )}
      >
      {(study) => (
      <>

      {/*
        コンパクト情報行: 指し手 | 評価値 | 手数/N + 分岐バッジ

        🔒 **高さを内容で変えない。** 以前は `flex-wrap` だったため、符号や評価値
        （「先手勝ち(必至・15手で詰み)」など）が伸びると右ブロックが折り返して行が 2 行になり、
        **下のコントローラー行が丸ごと下へずれた**。連打中にずれると、指の下に来た
        「この局面を探す」を踏んで /positions へ飛ぶ。
        対策は「折り返さない・はみ出しは truncate で吸収・高さは min-h-6 で固定」。
        符号は棋譜を読むための情報なので、truncate しても title で全文へ到達できるようにする。
      */}
      <div className="flex items-center gap-x-3 min-h-6 text-sm max-w-3xl no-tap-select">
        <div className="flex items-center gap-x-3 min-w-0">
          {displayedMoveText ? (
            <span className="font-bold text-base truncate" title={displayedMoveText}>
              {displayedMoveText}
            </span>
          ) : (
            <span className="text-base-content/40 whitespace-nowrap">初期局面</span>
          )}
          {posEvalText && (
            // 幅が足りないときは符号より先に評価値を削る（符号を優先して読ませる）。
            // ⚠ 分岐を辿っている間は md 未満で**評価値そのものを隠す**——分岐バッジが
            //   加わると 390px では符号と評価値が両方 truncate され、ホバーの無い
            //   モバイルでは title からも全文に届かなくなるため。分岐中の評価値は
            //   候補手の行にも出ている重複情報なので、符号の方を残す。
            //   幅の足りる md 以上は従来どおり出す。
            <span
              className={clsx(
                'font-semibold truncate shrink-[3]',
                branchActive && 'text-base-content/50 hidden md:block',
              )}
              title={posEvalText}
            >
              {/* 狭い画面は短い形。勝者（cp は符号 / mate は ▲△）は落とさない */}
              <span className="md:hidden">{posEvalShortText}</span>
              <span className="hidden md:inline">{posEvalText}</span>
            </span>
          )}
        </div>
        <div className="ml-auto shrink-0 flex items-center gap-2 whitespace-nowrap">
          {/*
            局面検索へ（prd/10 §6.3）。**表示中の局面**を鍵にして横断検索へ飛ぶ。
            モバイルはラベルを畳んでアイコンだけにする（右ブロックを細くして、
            符号・評価値に 1 行ぶんの幅を残すため）。
          */}
          <Link
            to="/positions"
            search={{ pos: positionSfen(displayState) }}
            className="btn btn-ghost btn-xs"
            aria-label="この局面を探す"
            title="この局面を通った他の棋譜と、そこからの分岐を見る"
          >
            <IconSearch />
            <span className="hidden md:inline">この局面を探す</span>
          </Link>
          <span className="font-mono text-base-content/60">
            {moveIndex} / {totalMoves}
          </span>
          {branchActive && (
            <span className="badge badge-sm badge-primary">分岐</span>
          )}
        </div>
      </div>

      <BoardControls
        study={study}
        moveIndex={moveIndex}
        totalMoves={totalMoves}
        branchActive={branchActive}
        onGoTo={goToMain}
        onFlip={() => setFlipped(!flipped)}
      />
      </>
      )}
      </StudyBoard>
    </div>
  );
}

function CandidateList({
  ref,
  candidates,
  played,
  evalMoveNumber,
  positions,
  moveIndex,
  loss,
  label,
  branchRank,
  branchDepth,
  onBranchForward,
  onBranchBack,
}: {
  ref?: Ref<HTMLDivElement>;
  candidates: Analysis['candidates'];
  played: string | undefined;
  evalMoveNumber: number;
  positions: BoardState[];
  moveIndex: number;
  loss: MoveLoss | null;
  label: MoveLabel;
  branchRank: number | null;
  branchDepth: number;
  onBranchForward: (rank: number, pv: string[]) => void;
  onBranchBack: (rank: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const INITIAL_COUNT = 3;
  const hasMore = candidates.length > INITIAL_COUNT;
  const visible = expanded ? candidates : candidates.slice(0, INITIAL_COUNT);

  // 段階（悪手 / 疑問手）と詰み系で色分けする。悪手と詰み系は error、疑問手は warning。
  const isSevere = label === 'blunder' || label === 'mate';
  const lossText = loss ? formatLoss(loss) : null;

  return (
    <div ref={ref}>
      <div className="mb-1 flex items-center gap-2 text-sm text-base-content/60">
        <span>候補手</span>
        {/* CPL が第一級の指標なので、ラベルが付かない手でも損失そのものは常に出す */}
        {label && loss && (
          <span
            className={clsx(
              'badge badge-sm',
              isSevere ? 'badge-error' : 'badge-warning',
            )}
          >
            {labelText(loss, label)}
          </span>
        )}
        {lossText && <span className="font-mono">{lossText}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {visible.map((c) => {
          const isPlayed = played && c.move === played;
          const isNotBest = c.rank === 1 && played && !isPlayed;
          const prevState = positions[moveIndex > 0 ? moveIndex - 1 : 0];
          const isActiveBranch = branchRank === c.rank && branchDepth > 0;
          const pvLen = c.pv?.length ?? 0;
          const hasPv = pvLen > 0;
          return (
            <details
              name="candidates"
              key={c.rank}
              className={clsx(
                'group rounded-lg p-2 text-sm',
                isPlayed && 'bg-base-200',
                isNotBest && isSevere && 'border border-error/30',
                isNotBest && label === 'dubious' && 'border border-warning/30',
                isActiveBranch && 'border-l-4 border-l-primary pl-3',
              )}
            >
              <summary className="flex items-center gap-2 list-none cursor-pointer md:cursor-default [&::-webkit-details-marker]:hidden">
                <span className="font-mono text-base-content/50">
                  {c.rank}
                </span>
                <span className="font-bold">
                  {turnSymbol(evalMoveNumber)}
                  {usiToJapaneseWithPiece(prevState, c.move)}
                </span>
                <span className="text-base-content/70">
                  {formatScore(
                    c.scoreType,
                    c.scoreValue,
                    evalMoveNumber,
                    mateLineOf(prevState, c.scoreType, c.scoreValue, c.pv),
                  )}
                </span>
                <span className="text-xs text-base-content/40">
                  d{c.depth}
                </span>
                {isPlayed && (
                  <span className="text-xs text-success">実手</span>
                )}
                {isNotBest && label === 'mate' && (
                  <span className="text-xs text-error">×</span>
                )}
                {isNotBest && label === 'blunder' && (
                  <span className="text-xs text-error">{turnSymbol(evalMoveNumber)}</span>
                )}
                {isNotBest && label === 'dubious' && (
                  <span className="text-xs text-warning">※</span>
                )}
                {hasPv && (
                  <span className="ml-auto text-xs text-base-content/40 md:hidden">
                    PV{pvLen} <span className="inline-block transition-transform group-open:rotate-180">▼</span>
                  </span>
                )}
              </summary>
              {hasPv && c.pv && (
                <>
                  <div className="mt-1 font-mono text-xs text-base-content/60 pl-5">
                    {(() => {
                      let st = prevState;
                      const activeIdx = isActiveBranch ? branchDepth - 1 : -1;
                      const nodes: ReactNode[] = [];
                      for (let j = 0; j < c.pv.length; j++) {
                        const turn = turnSymbol(evalMoveNumber + j);
                        const text = `${turn}${usiToJapaneseWithPiece(st, c.pv[j])}`;
                        if (j > 0) nodes.push(' ');
                        if (j === activeIdx) {
                          nodes.push(
                            <strong key={j} className="text-base-content font-bold">
                              {text}
                            </strong>,
                          );
                        } else {
                          nodes.push(<span key={j}>{text}</span>);
                        }
                        st = applyMove(st, c.pv[j]);
                      }
                      return nodes;
                    })()}
                  </div>
                  <div className="mt-2 flex items-center gap-2 pl-5 no-tap-select">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => onBranchBack(c.rank)}
                      disabled={!isActiveBranch}
                      title="分岐を戻る"
                    >
                      <ChevronLeftIcon />
                    </button>
                    <span className="text-sm font-mono text-base-content/60 w-12 text-center">
                      {isActiveBranch ? branchDepth : 0}/{pvLen}
                    </span>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => onBranchForward(c.rank, c.pv!)}
                      disabled={isActiveBranch && branchDepth >= pvLen}
                      title="分岐を進む"
                    >
                      <ChevronRightIcon />
                    </button>
                  </div>
                </>
              )}
            </details>
          );
        })}
      </div>
      {hasMore && (
        <button
          className="btn btn-ghost btn-xs w-full mt-1"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={clsx('transition-transform', expanded && 'rotate-180')}>
            ▼
          </span>
        </button>
      )}
    </div>
  );
}
