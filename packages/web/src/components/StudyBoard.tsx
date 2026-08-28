import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  applyMove,
  usiToJapaneseWithPiece,
  type BoardState,
  type HandPieceKind,
  type PieceKind,
  type Side,
  type SquareRef,
} from 'shared';
import { BoardGrid, HandDisplay } from './BoardGrid';
import {
  ArrowUturnLeftIcon,
  ArrowsRightLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './icons';
import { formatTurnScore, moveDestination } from '../lib/usi';
import { DEFAULT_THRESHOLDS, lossLabel, type Thresholds } from '../lib/cpl';
import {
  canPutSelectionOnHand,
  canRedo,
  canTogglePromotion,
  canUndo,
  createStudySession,
  currentState,
  isLastMovePromoted,
  isStudying,
  lastMove,
  lastMoveGradeTarget,
  positionEvalTarget,
  redo,
  redoAll,
  resetStudy,
  tapHand,
  tapSquare,
  togglePromotion,
  toggleTurn,
  undo,
  undoAll,
  type StudySession,
} from '../lib/study';
import {
  EvalRequestTracker,
  evalStateAfterPositionChange,
  gradeLastMove,
  headlineCandidate,
  requestPositionEval,
  validateEvalTarget,
  type EvalSource,
  type EvalState,
  type MoveGrade,
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
 * **それが変わったら検討を作り直す**。`moveIndex` を持ち上げると `ShogiBoard` の
 * 分岐再生・グラフ連動まで一緒に動かすことになり、範囲が UI 全体の作り直しになるため。
 *
 * ## 検討中はコントローラー行が検討の操作になる（決定・2026-08-28）
 *
 * 🔴 **かつての「検討中に手送りしたら検討を破棄する」は撤回された**（prd/12 §3.1）。
 * 検討中は ◀ ▶ が undo / redo、≪ ≫ が起点 / 最後へ、スライダーは無効になる。
 * 検討を抜けるのは「棋譜に戻る」を押したときだけ。
 *
 * そのため**コントローラー行の意味を切り替えるのはここ**（検討状態を持つ側）にある:
 *
 * - 情報行・コントローラー行は `children` を**関数**で受け取り（`StudyControls` を渡す）、
 *   `ShogiBoard` 側がボタンの割り当てを切り替える。
 * - キーボードの `←` `→` `Home` `End` も**この 1 か所**で受ける（`keyboardNav`）。
 *   window のリスナを 2 つに割ると、どちらが先に走るかで挙動が決まってしまう。
 *
 * ## レイアウトを動かさないための構造（prd/05 §2.1 / PR #105 の教訓）
 *
 * 操作パネルは**コントローラー行より下**に出す。盤のすぐ下に挿すと、駒を動かした瞬間に
 * ◀ ▶ が下へずれて**連打中に指の下の要素が入れ替わる**。そのため情報行・コントローラー行を
 * `children` として受け取り、盤とパネルの間に挟んで描く。
 */

/**
 * 検討中にコントローラー行（◀ ▶ ≪ ≫ / スライダー）へ割り当てる操作。
 * `studying` が false のときは棋譜の手送りのまま——切り替えは呼び出し側が行う。
 */
export interface StudyControls {
  /** 検討中か（バッジと、コントローラー行の意味の切り替え） */
  studying: boolean;
  /** ◀ を押せるか（起点まで戻していれば false） */
  canUndo: boolean;
  /** ▶ を押せるか（最後まで進んでいれば false） */
  canRedo: boolean;
  /** ◀ 1 手戻す */
  undo: () => void;
  /** ▶ 戻したのをやり直す */
  redo: () => void;
  /** ≪ 検討の起点まで戻す（検討からは抜けない） */
  undoAll: () => void;
  /** ≫ 検討の最後まで進める */
  redoAll: () => void;
}

/** 検討していないときのキーボード手送り（分岐移動を含む。`ShogiBoard` が渡す） */
export interface KeyboardNav {
  back: () => void;
  forward: () => void;
  first: () => void;
  last: () => void;
}
export interface StudyBoardProps {
  /** 棋譜側が表示している局面 */
  baseState: BoardState;
  /**
   * 棋譜側の表示局面を表す鍵。**これが変わったら検討を作り直す**。
   *
   * ⚠ 検討中は手送りができない（コントローラーは undo / redo になる）ので、
   * 通常これが変わるのは検討を始める前だけ。棋譜そのものが差し替わったときの保険でもある。
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
  /**
   * 情報行 + コントローラー行（盤とパネルの間に置く）。
   * **検討の操作（`StudyControls`）を受け取る関数**にしてある——検討中は
   * コントローラー行の意味が undo / redo に変わるため（prd/12 §3.1）。
   */
  children?: (controls: StudyControls) => ReactNode;
  /** 検討していないときのキーボード手送り。省略するとキーボードは何もしない */
  keyboardNav?: KeyboardNav;
  /**
   * 盤 + `children` + 操作パネルを**1 つの要素にまとめる**ためのクラス。
   * 呼び出し側がスクロール追従（`sticky`）のグループを作るために渡す。
   * 省略すると余計な要素を挟まない（`/dev-gallery` はそのまま）。
   */
  groupClassName?: string;
  /**
   * 操作パネルより**下**（＝ `groupClassName` のグループの外）に置く領域。
   *
   * 🔒 **検討中かどうかで出し分けたいものはここへ渡す**（prd/12 §3.1・決定 2026-08-29）。
   * 検討状態はこのコンポーネントが持つので、`children` と同じく `StudyControls` を渡す形にして
   * **検討中かの出所を 1 つに保つ**——呼び出し側に同じ状態をもう 1 つ持たせない。
   * （候補手一覧・評価値グラフはスクロール領域にあるので `children` の位置には置けない）
   */
  footer?: (controls: StudyControls) => ReactNode;
  /**
   * 悪手判定の閾値（prd/05 §2.5）。**直前の手の採点の色分けに使う**（prd/12 §3.2）。
   *
   * 🔒 **棋譜側の悪手マーカーと同じ供給元を使う**（`useThresholds` → `ShogiBoard` → ここ）。
   * 1 つの画面に「損失」の基準が 2 つあると、棋譜のグラフでは無印の損失が検討盤では
   * 警告色になる、という食い違いが起きる。
   * ⚠ 省略時は既定値（`/dev-gallery` のように供給元が無い文脈でも壊れず動く）。
   */
  thresholds?: Thresholds;
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

/**
 * アイコンだけのボタン（検討の操作パネル。prd/12 §3.2・決定 2026-08-29）。
 *
 * 🔒 **正方形にする**——高さだけ 44px にしても幅が潰れればタップの的は小さいままで、
 * prd/05 §2.1 の 44px 基準を満たさない。高さと同じ幅を明示して `px-0` で内側の余白を消す。
 * 🔒 **`shrink-0`**——同じ行の「評価する」が残り幅いっぱいに伸びる（案 A）ので、
 * 縮められる側にしておくとアイコンボタンから先に潰れる。
 */
const ICON_BTN = `${TOUCH_BTN} shrink-0 px-0 max-md:w-11 max-[374px]:w-10 md:w-8`;

/**
 * 文字（`成` / `☗先手`）を入れる小さなボタン。**幅は下限だけ決めて内容で伸ばす**——
 * `不成` や手番の記号はアイコンより広く、固定幅だと収まらない。
 */
const GLYPH_BTN = `${TOUCH_BTN} shrink-0 px-2 gap-1 max-md:min-w-11 max-[374px]:min-w-10 md:min-w-8`;


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
  keyboardNav,
  groupClassName,
  footer,
  thresholds = DEFAULT_THRESHOLDS,
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

  const gradeTarget = lastMoveGradeTarget(session);
  const selection = session.selection;

  /**
   * 「評価する」（prd/12 §3.2・決定 2026-08-29）。**ボタンは 1 つ**。
   *
   * 主は**現在の検討局面の局面評価**。加えて**直前が盤上の指し手なら 1 手前の局面も
   * 並行して評価**し、直前の手の採点（最善との差 = 損失）を出す。
   *
   * 🔒 **副次の要求が主を壊さないこと。** 1 手前の評価が失敗・busy・abort でも、
   * 主の局面評価の結果は必ず出す（採点だけ省く）。`requestPositionEval` は例外を
   * 投げないので、`Promise.all` でまとめても主が落ちることはない。
   *
   * 🔒 **世代（token）は 1 つ、`AbortSignal` は共有**（レビュー指摘 `OCL-AED22F46`）。
   * `begin()` を 2 回呼ぶと 1 本目が自分自身の 2 本目に捨てられ、判定が崩れる。
   */
  const run = async () => {
    const target = positionEvalTarget(session);
    // 🔴 **基点は送り先と同じ関数から取る**（レビュー指摘 `OCL-753E7A28`）。
    //    ここで別に数え直すと、undo して redo 分が残っているときに
    //    「送った局面」と「検証・PV 再生の基点」がずれる。
    const from = target.from;

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
    setEvalState({ kind: 'loading' });

    // 採点用の副次要求。⚠ **弾かれたら黙って採点だけ諦める**（主の警告にはしない）
    const grading =
      gradeTarget !== null
      && validateEvalTarget(gradeTarget.target.from, null).length === 0
        ? gradeTarget
        : null;

    const [result, gradeResult] = await Promise.all([
      requestPositionEval(target, signal),
      grading ? requestPositionEval(grading.target, signal) : Promise.resolve(null),
    ]);
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
          base: from,
          candidates: result.candidates,
          source: result.source,
          // ⚠ 採点は**取れたときだけ**。1 手前が失敗・busy・abort なら null
          grade:
            grading !== null && gradeResult?.kind === 'done'
              ? gradeLastMove({
                  from: grading.target.from,
                  move: grading.move,
                  current: headlineCandidate(result.candidates),
                  previousCandidates: gradeResult.candidates,
                  previousSource: gradeResult.source,
                })
              : null,
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
    // ⚠ **局面が変わったか**で見る。undo / redo は `steps` を作り直さず `cursor` だけ
    //    動かすので、配列の同一性で見ると評価結果が古い局面のまま残る
    if (currentState(next) !== currentState(session)) {
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
  /**
   * コントローラー行（◀ ▶ ≪ ≫）へ渡す検討の操作（prd/12 §3.1・決定 2026-08-28）。
   * ⚠ 咎め筋の再生中は読み専用なので、押せない状態にして手順を動かさせない。
   */
  const controls: StudyControls = {
    studying,
    canUndo: studying && !replaying && canUndo(session),
    canRedo: studying && !replaying && canRedo(session),
    undo: () => edit(undo(session)),
    redo: () => edit(redo(session)),
    undoAll: () => edit(undoAll(session)),
    redoAll: () => edit(redoAll(session)),
  };

  /**
   * キーボード操作（prd/05 §2.1 / prd/12 §3.1）。🔒 **window のリスナはここ 1 本に集める。**
   * 2 つに割ると、検討中にどちらが先に走るかで挙動が決まってしまう。
   *
   * - 検討中: `←` `→` が undo / redo、`Home` `End` が検討の起点 / 最後へ
   *   （コントローラー行の ◀ ▶ ≪ ≫ と同じ割り当て）
   * - それ以外: 棋譜の手送りへ流す（分岐内の移動も `keyboardNav` が持つ）
   *
   * ⚠ 入力欄（スライダー・メモ等）にフォーカスがある間と修飾キー併用時はブラウザ既定に譲る。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable
          || target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT')
      ) return;

      const nav: KeyboardNav | null = controls.studying
        ? {
            back: () => { if (controls.canUndo) controls.undo(); },
            forward: () => { if (controls.canRedo) controls.redo(); },
            first: () => { if (controls.canUndo) controls.undoAll(); },
            last: () => { if (controls.canRedo) controls.redoAll(); },
          }
        : keyboardNav ?? null;
      if (nav === null) return;

      switch (e.key) {
        case 'ArrowLeft': nav.back(); break;
        case 'ArrowRight': nav.forward(); break;
        case 'Home': nav.first(); break;
        case 'End': nav.last(); break;
        default: return;
      }
      // ページのスクロールを起こさない
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controls, keyboardNav]);

  const handClick = replaying
    ? undefined
    : (side: Side) => (kind: HandPieceKind) => edit(tapHand(session, side, kind));
  /** その側の持ち駒のうち選択中のもの（盤の選択マスと同じ見せ方で強調する） */
  const handSelection = (side: Side) =>
    selection?.kind === 'hand' && selection.side === side ? selection.piece : null;

  /**
   * 駒台の受け皿（「+」ボタン）。**盤の駒を選んでいる間だけ**渡す（prd/12 §3.2）。
   * 渡さなければボタン自体が描かれないので、見えることと押せることが 1 つの条件で決まる。
   *
   * 🔴 **これが駒箱の代わり。** 駒箱は「盤にも持ち駒にもない駒」の置き場だが、実際には
   * 盤から抜いた駒の**退避先でしかない**。駒台がその役を兼ねれば UI に出す理由が無くなる
   * ——駒の総数は元から変えられないので、失われる機能もない。
   * 先手・後手どちらの駒台にも置ける（相手の持ち駒にできる。フル編集）。
   *
   * 🔴 **玉を選んでいるときは出さない**（`canPutSelectionOnHand`）。玉は持ち駒に
   * できず、駒箱を廃止した今は**盤へ戻す手段が undo しか無い**（レビュー指摘
   * `OCL-3528F9AD`）。見えることと押せることは今までどおりこの 1 本で決まる。
   */
  const trayClick = (side: Side) =>
    !replaying && canPutSelectionOnHand(session)
      ? () => edit(tapHand(session, side))
      : undefined;

  const topSide: Side = flipped ? 'sente' : 'gote';
  const bottomSide: Side = flipped ? 'gote' : 'sente';

  /*
    盤 + 情報行 / コントローラー行（`children`）+ 操作パネル。**この 3 つで 1 グループ**で、
    呼び出し側は `groupClassName` で `sticky` にする。`footer` はこのグループの外（下）に出る
    ので、スクロールしていく領域（候補手・評価値グラフ）を置ける。
  */
  const group = (
    <>
      <div className="flex flex-col gap-1 max-w-fit mx-auto md:mx-0">
        <HandDisplay
          hand={displayState.hand[topSide]}
          side={topSide}
          name={topSide === 'sente' ? sente : gote}
          flipped={flipped}
          onPieceClick={handClick?.(topSide)}
          selected={handSelection(topSide)}
          onTrayClick={trayClick(topSide)}
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
          onTrayClick={trayClick(bottomSide)}
        />
      </div>

      {children?.(controls)}

      {/*
        操作パネル（段階的開示）。**駒を動かすまで出さない**ので、それまでの画面は
        今までと変わらない。コントローラー行より下にあるので、出ても ◀ ▶ は動かない
      */}
      {studying && (
        <div className="max-w-3xl flex flex-col gap-2 no-tap-select">
          {/*
            🔴 **操作は 1 行に収める**（prd/12 §3.2・決定 2026-08-29）。以前は
            「棋譜に戻る / 手番 / 成にする」と「評価する」が 2 行に分かれ、390px で
            折り返していた。**アイコン化で 4 つを 1 行に**畳む。
            ⚠ 320px のような狭い幅では折り返して 2 行になる（許容）。パネルは
            コントローラー行より**下**にあるので、折り返しても盤・◀ ▶ は動かない
            （prd/05 §2.1 / PR #105 の教訓）。
            🔒 アイコンのみのボタンには **`aria-label` を必ず付ける**（`title` も残す）。
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
              className={clsx(ICON_BTN, 'btn-outline')}
              onClick={() => edit(resetStudy(session))}
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
              className={clsx(GLYPH_BTN, 'btn-outline')}
              onClick={() => edit(toggleTurn(session))}
              disabled={replaying}
              aria-label={`手番を入れ替える（今は${state.sideToMove === 'sente' ? '先手' : '後手'}番）`}
              title="手番を入れ替える"
            >
              <ArrowsRightLeftIcon className="size-4 shrink-0" />
              {/*
                ⚠ **記号は少し大きく**（決定 2026-08-29）。390px の実機で ☗ と ☖ の
                塗り分けが判別しづらかった。**文字（先 / 後）を足すのではなく、
                今ある記号を読める大きさにする**（1 行に収める意味が無くなるため）。
              */}
              <span className="shrink-0 text-base leading-none">
                {state.sideToMove === 'sente' ? '☗' : '☖'}
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
              className={clsx(GLYPH_BTN, 'btn-outline')}
              onClick={() => edit(togglePromotion(session))}
              disabled={replaying || !canTogglePromotion(session)}
              aria-label={
                isLastMovePromoted(session)
                  ? '直前の手を不成で指し直す'
                  : '直前の手を成で指し直す'
              }
              title={
                canTogglePromotion(session)
                  ? '直前の手を成 / 不成で指し直す'
                  : '直前が盤上の手・駒打ちで、成れる駒のときだけ切り替えられる'
              }
            >
              {isLastMovePromoted(session) ? '不成' : '成'}
            </button>
            {/*
              🔴 **評価ボタンは 1 つ**（prd/12 §3.2・決定 2026-08-29）。かつての
              「この手を読む」（名指し評価）は返る数字が局面評価と同じで符号だけ反転して
              いたため web から外した。直前が盤上の指し手なら、この 1 押しで 1 手前の
              局面も評価して**直前の手の採点**まで出す（API の名指し評価は MCP 向けに残る）。
              🔒 **ここだけラベルを残す**（主操作をアイコンに畳まない）。

              🔴 **幅の規則は md を境に変える**（決定 2026-08-29）:
              **md 未満は残り幅いっぱい**（`flex-1`）、**md 以上は内容ぶんの幅**。
              - モバイルでは「成」の出入りで空く幅をこのボタンが吸うので、行の見え方が安定する
                （実測 390px では残り幅いっぱいでも内容幅との差は 10px しかない——アイコン 3 つと
                「検討中」バッジで幅がほぼ埋まっているため。**害が無く、揃う利点だけ残る**）
              - デスクトップでは残り幅いっぱいにすると**「評価する」が 534px の帯**になる
                （棋譜詳細の行幅 736px で実測）。**狙いだったモバイルでは効かず、
                デスクトップだけ壊れる**ので、md 以上は内容ぶんに戻す
            */}
            <button
              type="button"
              className={clsx(TOUCH_BTN, 'btn-primary', 'max-md:flex-1 max-md:min-w-24')}
              onClick={() => void run()}
              disabled={evalState.kind === 'loading' || replaying}
              title={
                gradeTarget === null
                  ? 'この局面をエンジンに評価させる'
                  : 'この局面を評価し、直前の手が最善とどれだけ離れていたかも出す'
              }
            >
              評価する
            </button>
          </div>

        </div>
      )}
    </>
  );

  return (
    <>
      {groupClassName ? <div className={groupClassName}>{group}</div> : group}
      {/*
        🔴 **評価結果は sticky グループの外**（prd/12 §3.1・決定 2026-08-29）。
        結果まで固定すると、390×900 の実測で**グループの高さが 1077px**（ビューポート 900px）に
        なり、**下端が画面に入らない＝その下の評価値グラフに事実上たどり着けない**。
        固定する価値があるのは**盤と、盤を動かす操作**であって、結果の読み物ではない。
        外へ出すと「盤を上端に見ながらスクロールして読み筋を再生する」使い方はむしろ成立しやすい。

        🔒 これで**結果の高さが変わっても盤・コントローラー行・操作ボタン行は動かない**
        （prd/05 §2.1）。`stale` / `loading` / `invalid` / `busy` も同じ場所に出る。
        ⚠ `idle`（まだ一度も評価していない）のときは器ごと出さない（余白を作らない）。
      */}
      {studying && evalState.kind !== 'idle' && (
        <div className="max-w-3xl pt-3 no-tap-select">
          <EvalResultView
            evalState={evalState}
            replay={replay}
            onReplay={setReplay}
            thresholds={thresholds}
          />
        </div>
      )}
      {footer?.(controls)}
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
  thresholds,
}: {
  evalState: EvalState;
  replay: Replay | null;
  onReplay: (replay: Replay | null) => void;
  thresholds: Thresholds;
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
          評価しています（エンジンが空くまで十数秒かかることがある）
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

  const { base, candidates, source, grade } = evalState;
  const side = base.sideToMove;
  // 🔴 **この局面の評価値を 1 つ、単独で出す。**
  //    候補手リストの 1 行目に埋もれていると「評価値が 1 つ決まるはずなのに無い」と
  //    読めてしまう（実機で踏んだ）。棋譜閲覧の情報行（prd/05 §2.1）と同じく、
  //    見る場所を 1 か所に決める
  const headline = headlineCandidate(candidates);

  return (
    <div className="flex flex-col gap-1 text-sm">
      {/*
        🔴 **評価値と出所を 1 行にまとめる**（決定 2026-08-29）。以前は「局面評価 [エンジン]」と
        「この局面の評価値 +42 (先手有利)」の 2 段だったが、ボタンが 1 つになって
        「どちらの評価か」を言う必要が無くなったので、見る場所も 1 行に畳む。
        評価値は**手番側から見た値**（prd/12 §2.3）。棋譜側の `formatScore` は手数の
        parity で先手視点へ直すので使えない。
        🔒 結果ブロックの中に収めるので、上の操作パネル・コントローラー行は動かない。
      */}
      <div className="flex items-baseline gap-2 flex-wrap">
        {headline && (
          <span className="text-lg font-bold">
            {formatTurnScore(headline.scoreType, headline.scoreValue, side)}
          </span>
        )}
        {/* 🔒 どこから来た値かを出す（prd/12 §2.6） */}
        <SourceBadge source={source} />
      </div>
      {grade && <MoveGradeView grade={grade} thresholds={thresholds} />}
      {candidates.length === 0 && (
        <p className="text-base-content/60">候補手が返らなかった（詰みなど）</p>
      )}
      {/*
        候補手 1 本。🔴 **棋譜側の候補手一覧（`ShogiBoard` の `CandidateList`）と同じ形に畳む**
        （prd/12 §3.2・決定 2026-08-29。ユーザ要望「通常の解析画面の候補手表示の様に」）。
        独自の見せ方を作らず、**同じ `details` + `summary`** に揃える:

        - **md 未満は畳む**（既定は閉じる）。`summary` の右端に `PV{n} ▼` の手がかりを出す
        - **md 以上は常時展開**（`app.css` の `details[name='study-candidates']` の規則。
          棋譜側の `candidates` と同じ 1 か所にまとめてある）
        - `name` を持たせて**排他アコーディオン**にする（1 本開くと他が閉じる）。
          棋譜側とは別の名前にして、開閉の単位を混ぜない

        ⚠ **咎め筋の再生（読み専用の一時状態。§3.2）が畳んだ中に入る。**
        閉じたまま再生中だと、**盤が読み専用のまま操作子だけ画面から消える**——
        戻る手段が無くなる。そこで **`details` が閉じたら再生を解除する**（`onToggle`）。
        排他アコーディオンで他の候補を開いたときも同じ経路で解除される。
      */}
      {candidates.map((c, i) => {
        // 再生中の候補だけ非 null。**`replay?.candidate === i` だと TS が絞れない**ので
        // 絞り込んだ値そのものを持つ
        const active = replay !== null && replay.candidate === i ? replay : null;
        const pvLen = c.pv.length;
        return (
          <details
            name="study-candidates"
            key={c.rank}
            className={clsx('group rounded-lg p-2', active !== null && 'bg-base-200')}
            onToggle={(e) => {
              // 🔒 閉じたら再生を解除する（上記のコメントの理由）。
              //    md 以上は CSS で常時展開だが、`open` 属性自体は動くので同じ経路を通る
              //    ——盤が検討局面へ戻るだけで、読めなくなるものは無い
              if (!e.currentTarget.open && active !== null) onReplay(null);
            }}
          >
            <summary className="flex items-center gap-2 list-none cursor-pointer md:cursor-default [&::-webkit-details-marker]:hidden">
              <span className="font-mono text-base-content/50">{c.rank}</span>
              <span className="font-bold">
                {symbolAt(side, 0)}
                {usiToJapaneseWithPiece(base, c.move)}
              </span>
              <span className="text-base-content/70">
                {formatTurnScore(c.scoreType, c.scoreValue, side)}
              </span>
              <span className="text-xs text-base-content/40">d{c.depth}</span>
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
                <div className="mt-2 flex items-center gap-2 pl-5">
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
          </details>
        );
      })}
    </div>
  );
}

/**
 * 値の出所（prd/12 §2.6）。🔒 **必ず出す**——既存解析の値と今のエンジンの値を黙って混ぜない。
 * 主の局面評価と、直前の手の採点に使った 1 手前の評価は**別々の要求**なので、
 * それぞれの行に出す（片方だけ既存解析ということが起きる）。
 */
function SourceBadge({ source }: { source: EvalSource }) {
  return (
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
  );
}

/**
 * 直前の手の採点（prd/12 §3.2・決定 2026-08-29）。
 *
 * 「評価する」を押したとき、直前が盤上の指し手なら 1 手前の局面も評価している。
 * その最善手と、指した手（現局面の評価の符号反転）を**同じ視点**で並べて差を見せる。
 *
 * ⚠ **視点は指した側**（`grade.from.sideToMove`）。現局面の視点（相手番）とは反転している
 * ので、上の評価値の行とは符号が逆に見える——だから**「直前の手」と明示した別ブロック**に置く。
 * ⚠ **損失の数値は両方 `cp` のときだけ**（`mate` の引き算は意味を持たない。{@link scoreLoss}）。
 */
function MoveGradeView({
  grade,
  thresholds,
}: {
  grade: MoveGrade;
  thresholds: Thresholds;
}) {
  const side = grade.from.sideToMove;
  const symbol = symbolAt(side, 0);
  /*
    🔒 **色は棋譜側の悪手マーカーと同じ閾値・同じ判定**（`cpl.ts` の `lossLabel`）。
    実機で「損失 5」が警告色になり、探索誤差を咎めているように見えた——同じ画面に
    「損失」の基準が 2 つあってはいけない（決定 2026-08-29）。閾値は設定から来る（§2.5）。
  */
  const label = lossLabel(grade.loss, thresholds);
  return (
    <div className="rounded-lg bg-base-200 p-2 flex flex-col gap-1">
      {/*
        🔴 **この行に出所バッジを出さない**（決定 2026-08-29）。ここの評価値は
        **主の局面評価の符号反転**で得た値なので、出所は結果ヘッダーのバッジと同じ。
        並べると「この数字は 1 手前の評価から来た」と読めてしまい、prd/12 §2.6 の
        「値の出所を黙って混ぜない」に反する（実機で実際にそう読めた）。
      */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-base-content/60 whitespace-nowrap">直前の手</span>
        <span className="font-bold whitespace-nowrap">
          {symbol}
          {usiToJapaneseWithPiece(grade.from, grade.move)}
        </span>
        <span className="whitespace-nowrap">
          {formatTurnScore(grade.playedScoreType, grade.playedScoreValue, side)}
        </span>
      </div>
      {/*
        🔒 **出所バッジはこちら**（= 1 手前の局面の評価から来た値）。主の評価とは別の要求なので、
        片方だけ既存解析ということが起きる（prd/12 §2.6）。
        ⚠ **最善手だったときも出す。** 「最善手」という結論そのものが 1 手前の評価から
        導かれているので、出所を言う相手はこの行しかない。
      */}
      {grade.isBest ? (
        /* 指した手が 1 手前の rank 1 そのもの。**損失は出さない**（数字より結論が要る） */
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-success">最善手</span>
          <SourceBadge source={grade.source} />
        </div>
      ) : (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base-content/60 whitespace-nowrap">最善</span>
          <span className="font-bold whitespace-nowrap">
            {symbol}
            {usiToJapaneseWithPiece(grade.from, grade.best.move)}
          </span>
          <span className="whitespace-nowrap">
            {formatTurnScore(grade.best.scoreType, grade.best.scoreValue, side)}
          </span>
          <SourceBadge source={grade.source} />
          {grade.loss === null ? (
            /* 🔒 `mate` が絡むときは**両者を並べるに留める**（引き算に意味が無い） */
            <span className="text-base-content/60 whitespace-nowrap">
              （詰みが絡むので損失は出さない）
            </span>
          ) : (
            <span
              className={clsx(
                'whitespace-nowrap font-semibold',
                label === 'dubious' && 'text-warning',
                label === 'blunder' && 'text-error',
              )}
            >
              損失 {grade.loss}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
