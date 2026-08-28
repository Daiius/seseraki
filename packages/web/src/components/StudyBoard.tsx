import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  applyMove,
  handCount,
  pieceBox,
  usiToJapaneseWithPiece,
  type BasePieceKind,
  type BoardState,
  type HandPieceKind,
  type PieceKind,
  type Side,
  type SquareRef,
} from 'shared';
import { BoardGrid, HandDisplay, PIECE_DISPLAY } from './BoardGrid';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import { formatTurnScore, moveDestination } from '../lib/usi';
import {
  canTogglePromotion,
  createStudySession,
  currentState,
  isStudying,
  lastMove,
  namedEvalTarget,
  positionEvalTarget,
  resetStudy,
  tapBox,
  tapHand,
  tapSquare,
  togglePromotion,
  toggleTurn,
  undo,
  type StudySession,
} from '../lib/study';
import {
  EvalRequestTracker,
  evalStateAfterPositionChange,
  requestPositionEval,
  validateEvalTarget,
  type EvalMode,
  type EvalState,
} from '../lib/positionEval';

/**
 * 検討盤（prd/12 §3）。
 *
 * 🔴 **「検討モード」というモードは無い。** 棋譜詳細の盤がそのまま検討盤で、
 * **駒を動かした時点で検討が始まる**（それまでの見た目は今までと同じ）。
 *
 * ## 置き場所と状態の持ち方（設計判断）
 *
 * 棋譜側の手数（`moveIndex`）は `ShogiBoard` の内部 state のまま**動かさない**。
 * ここが受け取るのは「棋譜側が今表示している局面」（`baseState`）だけで、
 * **それが変わったら検討を捨てて作り直す**。こうした理由:
 *
 * - prd/12 §3.1 が「検討中に手送りしたら検討を破棄して棋譜に戻る」と決めている。
 *   `baseState` の変化 = 手送り（◀ ▶ / スライダー / `←` `→` / 分岐の再生）なので、
 *   **破棄の条件が「起点が変わったか」の 1 つに畳まれる**。手送りの経路が増えても
 *   ここに手を入れずに済む。
 * - `moveIndex` を持ち上げると `ShogiBoard` の分岐再生・キーボード・グラフ連動まで
 *   一緒に動かすことになり、M2b の範囲が UI 全体の作り直しになる。
 *
 * ⚠ **キーボードの `←` `→` は `ShogiBoard` の window リスナが握ったまま**にする。
 * 押せば手送りが起き、`baseState` が変わり、上の規則で検討が捨てられる——これは
 * prd/12 §3.1 の定めどおりの挙動なので、ここで奪い返さない（奪うと「検討中は
 * キーボードで手送りできない」という書かれていない仕様になる）。
 *
 * ## レイアウトを動かさないための構造（prd/05 §2.1 / PR #105 の教訓）
 *
 * 操作パネルは**コントローラー行より下**に出す。盤のすぐ下に挿すと、駒を動かした瞬間に
 * ◀ ▶ が下へずれて**連打中に指の下の要素が入れ替わる**。そのため情報行・コントローラー行を
 * `children` として受け取り、盤とパネルの間に挟んで描く。
 */
export interface StudyBoardProps {
  /** 棋譜側が表示している局面 */
  baseState: BoardState;
  /**
   * 棋譜側の表示局面を表す鍵。**これが変わったら検討を破棄する**（prd/12 §3.1）。
   *
   * 🔴 **`baseState` の同一性では判定できない。** 分岐（読み筋）を辿っている間の局面は
   * `applyMove` でレンダーごとに作り直されるため、参照比較だと**毎レンダー破棄**になり
   * 描画が止まらなくなる。手数・分岐位置という「どこを見ているか」を鍵にする。
   */
  baseKey: string;
  /** 棋譜側の直前手の移動先。検討を始めるまでの強調に使う */
  baseLastMoveTo: [number, number] | null;
  flipped: boolean;
  sente?: string | null;
  gote?: string | null;
  /** 情報行 + コントローラー行（盤とパネルの間に置く） */
  children?: ReactNode;
  /**
   * DEV ギャラリー用の初期状態（`/dev-gallery`）。通常の閲覧では渡さない。
   * 表示を固定して幅ごとの見え方を撮るための入口で、`ShogiBoard` の
   * `initialMoveIndex` と同じ趣旨。
   */
  initialSession?: StudySession;
  initialEval?: EvalState;
}

/** 咎め筋（PV）の再生位置。**読み専用の一時状態**（prd/12 §3.2） */
interface Replay {
  candidate: number;
  depth: number;
}

/** 操作系のボタン。モバイル 44px（375px 未満は 40px）・デスクトップは小さく */
const TOUCH_BTN = 'btn max-md:h-11 max-md:min-h-11 max-[374px]:h-10 max-[374px]:min-h-10 md:btn-sm';
const CHIP_BTN = 'btn btn-square max-md:size-11 max-[374px]:size-10 md:btn-sm md:size-8';

const BOX_ORDER: BasePieceKind[] = ['K', 'R', 'B', 'G', 'S', 'N', 'L', 'P'];
const HAND_KINDS: HandPieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

/** 手番側から数えて i 手目の手番記号 */
function symbolAt(sideToMove: Side, i: number): string {
  const sente = (i % 2 === 0) === (sideToMove === 'sente');
  return sente ? '▲' : '△';
}

export function StudyBoard({
  baseState,
  baseKey,
  baseLastMoveTo,
  flipped,
  sente,
  gote,
  children,
  initialSession,
  initialEval,
}: StudyBoardProps) {
  const [session, setSession] = useState<StudySession>(
    () => initialSession ?? createStudySession(baseState),
  );
  const [evalState, setEvalState] = useState<EvalState>(initialEval ?? { kind: 'idle' });
  const [replay, setReplay] = useState<Replay | null>(null);
  const [seenKey, setSeenKey] = useState(baseKey);
  /**
   * 走っている評価要求の番人（`EvalRequestTracker`）。
   * 🔒 **局面が変わりうる操作のたびに `cancel()` を呼ぶ**——さもないと旧局面の応答が
   * 今の盤の評価として出る（レビュー指摘 `OCL-AED22F46`）。
   */
  const trackerRef = useRef(new EvalRequestTracker());

  // 🔴 **起点が変わったら検討を捨てる**（= 手送りされた。prd/12 §3.1）。
  // 確認ダイアログは出さない（連打を妨げないため・検討は元々保存しない）。
  // レンダー中に捨てるのは「props が変わったら state を作り直す」定石で、
  // effect でやると **1 フレームだけ古い検討局面が見える**ため。
  if (seenKey !== baseKey) {
    setSeenKey(baseKey);
    setSession(createStudySession(baseState));
    setEvalState({ kind: 'idle' });
    setReplay(null);
    // 🔴 **走っている要求もこの場で捨てる。** effect の後片付けに任せると、
    //    「破棄した後・effect が走る前」に応答が届いた場合に、捨てたはずの評価が
    //    新しい起点の画面へ出てしまう（レビュー指摘 `OCL-AED22F46` と同じ穴）。
    //    `seenKey !== baseKey` で守られており、何度呼んでも安全な操作
    trackerRef.current.cancel();
  }

  // アンマウントでも走っている long-poll を捨てる（起点の変化は上で処理済み）
  useEffect(() => () => trackerRef.current.cancel(), []);

  const studying = isStudying(session);
  const state = currentState(session);

  // 咎め筋の再生中は**読み専用**（prd/12 §3.2）。盤は再生位置の局面を出し、編集は受けない
  const replayBase = evalState.kind === 'done' ? evalState.base : null;
  const replayPv =
    replay !== null && evalState.kind === 'done'
      ? evalState.candidates[replay.candidate]?.pv ?? []
      : [];
  let displayState = state;
  let displayLastMoveTo = studying
    ? moveDestination(lastMove(session) ?? '')
    : baseLastMoveTo;
  if (replay !== null && replayBase) {
    let st = replayBase;
    for (let i = 0; i < replay.depth; i++) st = applyMove(st, replayPv[i]);
    displayState = st;
    displayLastMoveTo =
      replay.depth > 0 ? moveDestination(replayPv[replay.depth - 1]) : null;
  }

  const named = namedEvalTarget(session);
  const box = pieceBox(state);
  const selection = session.selection;

  const run = async (mode: EvalMode) => {
    const target = mode === 'position' ? positionEvalTarget(session) : named;
    if (!target) return;
    const from =
      mode === 'position' ? state : session.steps[session.steps.length - 2].state;

    // 🔒 **送る前にクライアントで検証する**（往復を減らす。判定は `shared` の 1 つ）
    const violations = validateEvalTarget(from, target.move);
    if (violations.length > 0) {
      // 🔴 **走っている要求もここで捨てる。** 弾いた新局面の警告を、後から届いた
      //    旧局面の結果が上書きしてしまう（レビュー指摘 `OCL-AED22F46`）
      trackerRef.current.cancel();
      setEvalState({ kind: 'invalid', violations });
      return;
    }

    // 押し直したら前の要求を捨てる（二重送信の抑止も兼ねる）
    const { token, signal } = trackerRef.current.begin();
    setReplay(null);
    setEvalState({ kind: 'loading', mode });

    const result = await requestPositionEval(target, signal);
    // 🔒 待っている間に局面が変わっていたら**この結果は今の盤のものではない**
    if (!trackerRef.current.accepts(token)) return;
    switch (result.kind) {
      case 'aborted':
        return;
      case 'invalid':
        setEvalState({ kind: 'invalid', violations: result.violations });
        return;
      case 'busy':
        setEvalState({ kind: 'busy' });
        return;
      case 'failed':
        setEvalState({ kind: 'error', message: result.message });
        return;
      case 'done':
        setEvalState({
          kind: 'done',
          mode,
          base: from,
          candidates: result.candidates,
          source: result.source,
          fallback: result.fallback,
        });
    }
  };

  /**
   * 検討セッションを進める**唯一の口**（盤のタップ・undo・棋譜に戻る・手番トグル・
   * 成/不成・持ち駒/駒箱の出し入れは、すべてここを通る）。
   *
   * 🔒 **局面が変わったら、走っている評価要求も捨てる。** 表示を idle に戻すだけでは、
   * 後から届いた旧局面の結果が今の盤の評価として出てしまう（レビュー指摘 `OCL-AED22F46`）。
   * ⚠ 選択が変わっただけ（`steps` が同じ）なら局面は動いていないので、要求は捨てない。
   */
  const edit = (next: StudySession) => {
    setSession(next);
    if (next.steps !== session.steps) {
      trackerRef.current.cancel();
      // 🔴 **黙って消さない。** 一度でも評価に触れていれば `stale` にして
      //    「盤が変わった / もう一度評価できる」ことを言う（実機で「もう評価
      //    できないのか」と読めてしまった。値そのものは残さない）
      setEvalState(evalStateAfterPositionChange(evalState));
      setReplay(null);
    }
  };

  /**
   * 咎め筋（PV）の再生中は**読み専用**（prd/12 §3.2）。盤も編集操作も受け付けず、
   * 「戻る」で元の検討局面に帰る。**手順と undo スタックの意味を保つため。**
   * 「棋譜に戻る」だけは残す（検討ごと捨てる操作なので、迷子になったときの出口になる）。
   */
  const replaying = replay !== null;
  const onSquareClick = replaying
    ? undefined
    : (square: SquareRef) => edit(tapSquare(session, square));

  /**
   * 持ち駒を叩く口（prd/12 §3.2）。**盤上の駒と同じ 2 段選択**に揃える——
   * 持ち駒を選んでから盤のマスを叩けば打てる（`tapSquare` が `dropFromHand` を通す）。
   * 先手・後手どちらの持ち駒からも打てる（フル編集）が、**手番側の駒を打ったときだけ
   * 手番が進む**（盤上の駒を動かしたときと同じ規則。`study.ts` の `advanceTurn`）。
   *
   * ⚠ 再生中は読み専用なので渡さない（渡さなければ表示専用に戻る）。
   */
  const handClick = replaying
    ? undefined
    : (side: Side) => (kind: HandPieceKind) => edit(tapHand(session, side, kind));
  /** その側の持ち駒のうち選択中のもの（盤の選択マスと同じ見せ方で強調する） */
  const handSelection = (side: Side) =>
    selection?.kind === 'hand' && selection.side === side ? selection.piece : null;

  const topSide: Side = flipped ? 'sente' : 'gote';
  const bottomSide: Side = flipped ? 'gote' : 'sente';

  return (
    <>
      <div className="flex flex-col gap-1 max-w-fit mx-auto md:mx-0">
        <HandDisplay
          hand={displayState.hand[topSide]}
          side={topSide}
          name={topSide === 'sente' ? sente : gote}
          flipped={flipped}
          onPieceClick={handClick?.(topSide)}
          selected={handSelection(topSide)}
        />
        <div className="w-fit no-tap-select">
          <BoardGrid
            state={displayState}
            lastMoveTo={displayLastMoveTo}
            flipped={flipped}
            onSquareClick={onSquareClick}
            selected={selection?.kind === 'square' ? selection.square : null}
          />
        </div>
        <HandDisplay
          hand={displayState.hand[bottomSide]}
          side={bottomSide}
          name={bottomSide === 'sente' ? sente : gote}
          flipped={flipped}
          onPieceClick={handClick?.(bottomSide)}
          selected={handSelection(bottomSide)}
        />
      </div>

      {children}

      {/*
        操作パネル（段階的開示）。**駒を動かすまで出さない**ので、それまでの画面は
        今までと変わらない。コントローラー行より下にあるので、出ても ◀ ▶ は動かない
      */}
      {studying && (
        <div className="max-w-3xl flex flex-col gap-2 no-tap-select">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge badge-primary badge-sm">
              {replaying ? '読み筋を再生中' : '検討中'}
            </span>
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-outline')}
              onClick={() => edit(undo(session))}
              disabled={replaying}
            >
              1手戻す
            </button>
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-ghost')}
              onClick={() => edit(resetStudy(session))}
            >
              棋譜に戻る
            </button>
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-outline')}
              onClick={() => edit(toggleTurn(session))}
              disabled={replaying}
              title="手番を入れ替える"
            >
              手番 {state.sideToMove === 'sente' ? '☗先手' : '☖後手'}
            </button>
            {canTogglePromotion(session) && (
              <button
                type="button"
                className={clsx(TOUCH_BTN, 'btn-outline')}
                onClick={() => edit(togglePromotion(session))}
                disabled={replaying}
                title="直前の手を成 / 不成で指し直す"
              >
                {lastMove(session)?.endsWith('+') ? '不成にする' : '成にする'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-primary')}
              onClick={() => void run('position')}
              disabled={evalState.kind === 'loading' || replaying}
            >
              この局面を評価
            </button>
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-outline')}
              onClick={() => void run('move')}
              disabled={evalState.kind === 'loading' || named === null || replaying}
              title={
                named === null
                  ? '直前が盤上の指し手のときだけ読める（駒箱・持ち駒・手番の編集の後は押せない）'
                  : 'この手を名指しでエンジンに読ませる'
              }
            >
              この手を読む
            </button>
          </div>

          <EvalResultView
            evalState={evalState}
            replay={replay}
            onReplay={setReplay}
          />

          {!replaying && (
          <details className="text-sm">
            <summary className="cursor-pointer text-base-content/70">
              駒を出し入れする（持ち駒 / 駒箱）
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-base-content/60">
                盤の駒を選んでから持ち駒 / 駒箱を叩くと移せる。持ち駒 / 駒箱を選んでから
                盤のマスを叩くと置ける。
              </p>
              {(['sente', 'gote'] as const).map((side) => (
                <div key={`hand-${side}`} className="flex items-center gap-1 flex-wrap">
                  <button
                    type="button"
                    className={clsx(CHIP_BTN, 'btn-ghost')}
                    onClick={() => edit(tapHand(session, side))}
                    title={`${side === 'sente' ? '先手' : '後手'}の持ち駒へ`}
                  >
                    {side === 'sente' ? '☗' : '☖'}
                  </button>
                  {HAND_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={clsx(
                        CHIP_BTN,
                        selection?.kind === 'hand'
                          && selection.side === side
                          && selection.piece === kind
                          ? 'btn-secondary'
                          : 'btn-outline',
                      )}
                      onClick={() => edit(tapHand(session, side, kind))}
                    >
                      {PIECE_DISPLAY[kind as PieceKind]}
                      <span className="font-mono text-xs opacity-70">
                        {handCount(state, side, kind)}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {(['sente', 'gote'] as const).map((side) => (
                <div key={`box-${side}`} className="flex items-center gap-1 flex-wrap">
                  <span className="text-xs text-base-content/60 w-10">
                    箱{side === 'sente' ? '☗' : '☖'}
                  </span>
                  {BOX_ORDER.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={clsx(
                        CHIP_BTN,
                        selection?.kind === 'box'
                          && selection.side === side
                          && selection.piece === kind
                          ? 'btn-secondary'
                          : 'btn-outline',
                      )}
                      onClick={() => edit(tapBox(session, side, kind))}
                      disabled={box[kind] === 0 && selection === null}
                    >
                      {PIECE_DISPLAY[kind as PieceKind]}
                      <span className="font-mono text-xs opacity-70">{box[kind]}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </details>
          )}
        </div>
      )}
    </>
  );
}

/**
 * 評価結果の表示。
 *
 * ⚠ **スコアは手番側から見た値**（prd/12 §2.3）。棋譜側の `formatScore` は手数の parity で
 * 先手視点へ直すので使えない（検討局面は手数を持たない）。`formatTurnScore` を使う。
 * ⚠ **`source` を必ず出す**（prd/12 §2.6。既存解析の値とエンジンの値を黙って混ぜない）。
 */
function EvalResultView({
  evalState,
  replay,
  onReplay,
}: {
  evalState: EvalState;
  replay: Replay | null;
  onReplay: (replay: Replay | null) => void;
}) {
  // まだ一度も評価していない（`idle`）なら何も出さない
  if (evalState.kind === 'idle') return null;

  /*
    評価した後で局面が変わった状態（`stale`）。**値は消すが、手がかりは残す。**
    結果ブロックがあった場所にそのまま出すので、上の操作パネル・コントローラー行の
    位置は動かない（prd/05 §2.1）。
  */
  if (evalState.kind === 'stale') {
    return (
      <p className="text-sm text-base-content/60">
        盤が変わったので前の評価は消した。もう一度評価できる
      </p>
    );
  }

  if (evalState.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="loading loading-dots loading-md" aria-label="評価しています" />
        <span className="text-base-content/60">
          {evalState.mode === 'move' ? 'この手を読んでいます' : 'この局面を評価しています'}
          （エンジンが空くまで十数秒かかることがある）
        </span>
      </div>
    );
  }

  if (evalState.kind === 'invalid') {
    return (
      <div className="alert alert-warning text-sm">
        <div>
          <div className="font-semibold">この局面はエンジンに渡せない</div>
          <ul className="list-disc ps-5">
            {evalState.violations.map((v) => (
              <li key={`${v.code}-${v.message}`}>{v.message}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (evalState.kind === 'busy') {
    return (
      <div className="alert alert-warning text-sm">
        評価キューが一杯。worker が動いていない可能性がある
      </div>
    );
  }

  if (evalState.kind === 'error') {
    return <div className="alert alert-warning text-sm">{evalState.message}</div>;
  }

  const { base, candidates, source, fallback, mode } = evalState;
  const side = base.sideToMove;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-base-content/60">
          {mode === 'move' ? '名指し評価' : '局面評価'}
        </span>
        {/* 🔒 どこから来た値かを出す（prd/12 §2.6） */}
        <span
          className={clsx('badge badge-sm', source === 'kifu' ? 'badge-ghost' : 'badge-info')}
          title={
            source === 'kifu'
              ? '既存の棋譜解析から引いた値（解析時のエンジン設定は今と違いうる）'
              : '今のエンジンが計算した値'
          }
        >
          {source === 'kifu' ? '既存解析' : 'エンジン'}
        </span>
        {fallback && (
          <span className="badge badge-sm badge-ghost" title="手を適用した局面を評価して符号を反転した">
            反転
          </span>
        )}
      </div>
      {candidates.length === 0 && (
        <p className="text-base-content/60">候補手が返らなかった（詰みなど）</p>
      )}
      {candidates.map((c, i) => {
        // 再生中の候補だけ非 null。**`replay?.candidate === i` だと TS が絞れない**ので
        // 絞り込んだ値そのものを持つ
        const active = replay !== null && replay.candidate === i ? replay : null;
        const pvLen = c.pv.length;
        return (
          <div key={c.rank} className={clsx('rounded-lg p-2', active !== null && 'bg-base-200')}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-base-content/50">{c.rank}</span>
              <span className="font-bold">
                {symbolAt(side, 0)}
                {usiToJapaneseWithPiece(base, c.move)}
              </span>
              <span className="text-base-content/70">
                {formatTurnScore(c.scoreType, c.scoreValue, side)}
              </span>
              <span className="text-xs text-base-content/40">d{c.depth}</span>
            </div>
            {pvLen > 0 && (
              <>
                <div className="mt-1 font-mono text-xs text-base-content/60">
                  {(() => {
                    let st = base;
                    const nodes: string[] = [];
                    for (let j = 0; j < pvLen; j++) {
                      nodes.push(`${symbolAt(side, j)}${usiToJapaneseWithPiece(st, c.pv[j])}`);
                      st = applyMove(st, c.pv[j]);
                    }
                    return nodes.join(' ');
                  })()}
                </div>
                {/* 咎め筋の再生は**読み専用の一時状態**。「戻る」で検討局面へ帰る */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className={clsx(TOUCH_BTN, 'btn-outline')}
                    disabled={active === null}
                    onClick={() =>
                      onReplay(
                        active !== null && active.depth > 1
                          ? { candidate: i, depth: active.depth - 1 }
                          : null,
                      )
                    }
                    aria-label="読み筋を戻る"
                  >
                    <ChevronLeftIcon />
                  </button>
                  <span className="font-mono text-base-content/60 w-12 text-center">
                    {active?.depth ?? 0}/{pvLen}
                  </span>
                  <button
                    type="button"
                    className={clsx(TOUCH_BTN, 'btn-outline')}
                    disabled={active !== null && active.depth >= pvLen}
                    onClick={() =>
                      onReplay({ candidate: i, depth: (active?.depth ?? 0) + 1 })
                    }
                    aria-label="読み筋を進む"
                  >
                    <ChevronRightIcon />
                  </button>
                  {active !== null && (
                    <button
                      type="button"
                      className={clsx(TOUCH_BTN, 'btn-ghost')}
                      onClick={() => onReplay(null)}
                    >
                      戻る
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
