import { useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_THRESHOLDS,
  type BoardState,
  type HandPieceKind,
  type Side,
  type SquareRef,
  type Thresholds,
} from 'shared';
import { BoardWithHands, pickerOf } from './BoardGrid';
import { EvalResultView, type Replay } from './StudyEvalResult';
import { StudyPanel } from './StudyPanel';
import { moveDestination } from '../lib/usi';
import {
  canPutSelectionOnHand,
  canTogglePromotion,
  cancelPromotion,
  choosePromotion,
  clearSelection,
  commitReplay,
  createStudySession,
  currentState,
  historyButtons,
  isChoosingPromotion,
  isLastMovePromoted,
  isStudying,
  lastMove,
  lastMoveGradeTarget,
  redo,
  redoAll,
  resetStudy,
  resolvePromotion,
  tapHand,
  tapSquare,
  togglePromotion,
  toggleTurn,
  undo,
  undoAll,
  type StudySession,
} from '../lib/study';
import type { EvalState } from '../lib/positionEval';
import { useStudyEval } from '../lib/useStudyEval';

/**
 * 検討中にコントローラー行（◀ ▶ ≪ ≫ / スライダー）へ割り当てる操作。
 * `studying` が false のときは棋譜の手送りのまま——切り替えは呼び出し側が行う。
 *
 * 🔴 **「評価する」も含む**（決定・2026-09-01）。以前は検討中だけ操作パネルに出す
 * ボタンだったが、コントローラー行の 7 つ目として常設した——棋譜再生中・棋譜側の
 * 読み筋（分岐）を辿っている最中でも押せる（局面さえあれば評価は意味を持つため。
 * prd/12 §3.2）。**検討中かの出所を 1 つに保つのと同じ理由で、評価の状態も
 * `BoardControls` に別に持たせず、ここから渡す。**
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
  /**
   * 評価する。盤に出ている局面（棋譜再生中ならその局面・棋譜側の読み筋を辿っている
   * 最中ならその分岐先・検討中なら検討局面）をエンジンに評価させる。
   * ⚠ **押しても検討モードには入らない**（手順を積まないので `studying` は立たない）。
   * 咎め筋（PV）を再生中に押したときだけ、その読み筋を手順へ確定してから評価する
   * （既存の `run()` の挙動そのまま）。
   */
  evaluate: () => void;
  /** 評価要求が実行中か（ボタンをスピナーへ差し替えて disabled にするための状態） */
  evaluating: boolean;
  /**
   * 直前の手の採点対象があるか（`lastMoveGradeTarget` が非 null）。
   * ⚠ 検討中でカーソルが起点より進んでいるときだけ true になる——棋譜再生中は
   * 常に false（採点は出さない。prd/12 §3.2「棋譜側では直前の手の採点を出さない」）。
   */
  grading: boolean;
  /**
   * 成 / 不成の選択待ちか（prd/12 §3.2）。🔴 **この間はコントローラー行のどのボタンも、操作せずにその手を取り消す**
   * （レビュー `OCL-919E71C1`）。◀ ▶ ≪ ≫・評価するは上の各操作が自前で振り替えるので、ここを見るのは盤面反転だけ
   */
  choosing: boolean;
  /** 選択待ちの手を取り消す（指す前の局面へ） */
  cancelChoice: () => void;
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
  const [replay, setReplay] = useState<Replay | null>(null);
  const [seenKey, setSeenKey] = useState(baseKey);
  /** 評価の要求と結果（走っている要求の番人も持つ。`lib/useStudyEval.ts`） */
  const studyEval = useStudyEval(initialEval);
  const { evalState } = studyEval;

  // 🔴 **起点が変わったら検討を捨てる**（= 手送りされた。prd/12 §3.1）。
  // 確認ダイアログは出さない（連打を妨げないため・検討は元々保存しない）。
  // レンダー中に捨てるのは「props が変わったら state を作り直す」定石で、
  // effect でやると **1 フレームだけ古い検討局面が見える**ため。
  if (seenKey !== baseKey) {
    setSeenKey(baseKey);
    setSession(createStudySession(baseState));
    setReplay(null);
    // 🔴 **走っている要求もこの場で捨てる**（`reset` の中。effect の後片付けに任せると、
    //    「破棄した後・effect が走る前」に応答が届いた場合に、捨てたはずの評価が
    //    新しい起点の画面へ出てしまう。レビュー指摘 `OCL-AED22F46` と同じ穴）
    studyEval.reset();
  }

  const studying = isStudying(session);

  const replayPv =
    replay !== null && evalState.kind === 'done'
      ? evalState.candidates[replay.candidate]?.pv ?? []
      : [];
  /**
   * 🔴 **咎め筋（PV）の再生は「確定前のプレビュー」**（prd/12 §3.2・決定 2026-09-01）。
   * 再生位置までの読み筋を手順へ積んだ**派生セッション**を作り、**盤・直前手の強調・
   * 手番の記号・成 / 不成の可否・評価の送り先を、すべてここから読む**。
   *
   * 🔒 **こうすると「確定」という特別な処理がどこにも要らない**——再生中に盤を触ったら
   * `shown` に操作を適用して `setSession` するだけで、そこまでの読み筋が手順に積まれる。
   * 表示と確定が同じ関数（`commitReplay`）を通るので、**見ていた局面と確定する局面が
   * ずれようがない。**
   *
   * ⚠ `replay` が非 null の間は `evalState.kind === 'done'` かつ
   * `evalState.base === currentState(session)`（局面が変われば `edit` が再生を解除して
   * `stale` にする）。PV の基点は現在の検討局面そのもの。
   */
  const shown = replay !== null ? commitReplay(session, replayPv, replay.depth) : session;
  /** 盤に出す局面（＝再生中はプレビュー、そうでなければ現在の検討局面） */
  const state = currentState(shown);
  const displayLastMoveTo =
    studying || replay !== null
      ? moveDestination(lastMove(shown) ?? '')
      : baseLastMoveTo;

  const gradeTarget = lastMoveGradeTarget(shown);
  const selection = shown.selection;

  /**
   * 「評価する」（prd/12 §3.2）。要求そのもの（主の局面評価と 1 手前の採点）は `lib/useStudyEval.ts` の `run`。
   */
  const evaluate = () => {
    // 🔴 **再生中に押したら、そこまでの読み筋を確定してから評価する**
    //    （prd/12 §3.2・決定 2026-09-01）。押せば評価結果が入れ替わり、**再生していた
    //    候補手そのものが画面から消える**ので、確定しないと盤だけが「もうどこにも根拠の
    //    無い局面」を指したまま新しい評価が出る。⚠ `setSession` は非同期なので、
    //    以降は render 内で作った `shown` をそのまま使う（state の反映は待たない）
    // 🔒 **解除も同時に**——検証で弾かれて早期 return する経路があるので、確定だけして
    //    再生が残ると「読み筋を再生中」のバッジだけが居座る
    if (replay !== null) {
      setSession(shown);
      setReplay(null);
    }
    void studyEval.run(shown);
  };

  /**
   * 検討セッションを進める**唯一の口**（盤のタップ・undo・棋譜に戻る・手番トグル・
   * 成/不成・持ち駒/駒箱の出し入れは、すべてここを通る）。
   *
   * ⚠ **渡すのは `shown`（＝再生中なら確定済みの派生セッション）に操作を適用した結果**。
   * 再生中に触れば、そこまでの読み筋が手順に積まれた状態で編集が乗る（prd/12 §3.2）。
   *
   * 🔴 **何も起きなかったら確定もしない**（`next === shown`）。選択していない状態で
   * 空きマスを叩いた等の no-op で読み筋が確定してしまうと、**触っただけで手順が伸びる**。
   *
   * 🔒 **局面が変わったら、走っている評価要求も捨てる。** 表示を idle に戻すだけでは、
   * 後から届いた旧局面の結果が今の盤の評価として出てしまう（レビュー指摘 `OCL-AED22F46`）。
   * ⚠ 選択が変わっただけ（`steps` が同じ）なら局面は動いていないので、要求は捨てない。
   */
  const edit = (next: StudySession) => {
    if (next === shown) return;
    setSession(next);
    // 🔴 **確定したらプレビューは役目を終える。** 局面が変わったかに関わらず解除する
    //    （再生中の「駒を選んだだけ」でも確定は起きている）
    setReplay(null);
    // ⚠ **局面が変わったか**で見る。undo / redo は `steps` を作り直さず `cursor` だけ
    //    動かすので、配列の同一性で見ると評価結果が古い局面のまま残る。
    // ⚠ 比べる相手は `shown` ではなく **`session`**——出ている評価結果は
    //    `currentState(session)` に対するもの（`evalState.base`）なので、確定して
    //    局面が動いた時点で `stale` にしなければならない
    if (currentState(next) !== currentState(session)) {
      // 走っている要求を捨て、出ている結果は `stale` にする（`useStudyEval` の `positionChanged`）
      studyEval.positionChanged();
    }
  };

  /**
   * 🔴 **咎め筋（PV）の再生中も盤は触れる**（prd/12 §3.2・決定 2026-09-01）。触ったら
   * そこまでの読み筋が手順に確定し（`shown`）、その上に編集が乗る。
   * ⚠ **確定の合図は「バッジが『検討中』へ戻り、盤はその場に留まる」**——駒を選んだ
   * 1 段目で確定するので、**盤が動く前に確定したことが見える**。
   */
  const replaying = replay !== null;

  /**
   * 咎め筋の再生位置を動かす口（候補手の中の ◀ ▶ / 「再生をやめる」/ 畳んだとき）。
   * ⚠ **再生を始めたら選択を落とす**——選択は検討局面の座標を指しているので、
   * プレビュー局面をそのまま出すと**別の駒の上にハイライトが残る**（prd/12 §3.2）。
   */
  const changeReplay = (next: Replay | null) => {
    if (next !== null) setSession(clearSelection(session));
    setReplay(next);
  };

  /**
   * 成 / 不成の選択待ち（prd/12 §3.2・2026-10-30。出題と同じ口: `lib/study.ts` の `resolvePromotion`）。
   * 任意成りの手を指したら盤の上で選ばせる。成らなければいけない手は聞かずに成り、打つ手は聞かない。
   *
   * 🔒 **選択待ちの間は、ほかの操作を「その手の取り消し」に振り替える**（`guard`）——盤の選択肢の外・駒台・
   * 操作パネル・コントローラー行・キーボードのどれも、操作そのものは行わずに指す前へ戻すだけ。
   * 選択待ちのセッションへ別の操作を重ねると、不成の形で仮に置いた手が手順に残る。
   * ⚠ 「棋譜に戻る」だけは振り替えない（検討ごと捨てるので、仮の手も一緒に消える）。
   * ⚠ 仮に指した時点で局面は変わる（`edit`）ので、出ていた評価は `stale` になる。取り消しても戻らない
   */
  const choosing = isChoosingPromotion(session);
  const cancelChoice = () => edit(cancelPromotion(session));
  const guard = (action: () => void) => () => (choosing ? cancelChoice() : action());

  const onSquareClick = (square: SquareRef) => {
    if (choosing) return cancelChoice();
    edit(resolvePromotion(shown, tapSquare(shown, square)));
  };

  /**
   * コントローラー行（◀ ▶ ≪ ≫）へ渡す検討の操作（prd/12 §3.1・決定 2026-08-28）。
   *
   * 🔴 **咎め筋の再生中は無効のまま**（確定の引き金にしない。prd/12 §3.2・決定 2026-09-01）。
   * これらは編集ではなく**手順のカーソル移動**なので、引き金にすると ◀ は
   * 「N 手確定してから 1 手戻す」になる——**画面は 1 手戻っただけに見えるのに、手順は
   * N-1 手伸びる**。確定は「盤がその場に留まったまま自分のものになる」ことが見えて成立する
   * ので、**位置を動かす操作を引き金にしてはいけない**。⚠ 再生の ◀ ▶（候補手の中）と
   * 隣り合うため、両方が同時に効くと**並んだ矢印が別々の履歴を動かす**ことにもなる。
   */
  const controls: StudyControls = {
    studying,
    // 成 / 不成の選択待ちの間は ◀ ▶ ≪ ≫ も押せる（押したら取り消し。`guard`・`historyButtons`）
    ...historyButtons(session, replaying),
    choosing,
    cancelChoice,
    undo: guard(() => edit(undo(session))),
    redo: guard(() => edit(redo(session))),
    undoAll: guard(() => edit(undoAll(session))),
    redoAll: guard(() => edit(redoAll(session))),
    // 🔒 **`run()` の中身には触らない**（レビュー指摘 `OCL-AED22F46` / `OCL-BE4CEA52` /
    //    `OCL-17AFF653` の集積地。決定・2026-09-01。`lib/useStudyEval.ts`）。変えるのは「呼べる場所」だけ
    evaluate: guard(evaluate),
    evaluating: evalState.kind === 'loading',
    grading: gradeTarget !== null,
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
   * 🔒 **成 / 不成の選択待ちの間は `Escape` と手送りのキーで、その手を取り消す**（ボタンと同じ振り替え）。
   * 手送りのキーをそのまま流すと、仮に置いた手の上で undo / redo が走る。
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

      if (choosing) {
        if (!['Escape', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        cancelChoice();
        e.preventDefault();
        return;
      }

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
  }, [controls, keyboardNav, choosing, cancelChoice]);

  /**
   * 持ち駒を叩く口（prd/12 §3.2）。**盤上の駒と同じ 2 段選択**に揃える——
   * 持ち駒を選んでから盤のマスを叩けば打てる（`tapSquare` が `dropFromHand` を通す）。
   * 先手・後手どちらの持ち駒からも打てる（フル編集）が、**手番側の駒を打ったときだけ
   * 手番が進む**（盤上の駒を動かしたときと同じ規則。`study.ts` の `advanceTurn`）。
   *
   * ⚠ 再生中も渡す（触れば確定する）。盤のマスと同じ扱い。
   */
  const handClick = (side: Side) => (kind: HandPieceKind) =>
    choosing ? cancelChoice() : edit(tapHand(shown, side, kind));

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
    canPutSelectionOnHand(shown) ? () => edit(tapHand(shown, side)) : undefined;

  /*
    盤 + 情報行 / コントローラー行（`children`）+ 操作パネル。**この 3 つで 1 グループ**で、
    呼び出し側は `groupClassName` で `sticky` にする。`footer` はこのグループの外（下）に出る
    ので、スクロールしていく領域（候補手・評価値グラフ）を置ける。
  */
  const group = (
    <>
      <BoardWithHands
        className="flex flex-col gap-1 max-w-fit mx-auto md:mx-0"
        boardClassName="w-fit no-tap-select"
        state={state}
        flipped={flipped}
        lastMoveTo={displayLastMoveTo}
        names={{ sente, gote }}
        selection={selection}
        onSquareClick={onSquareClick}
        promotionChoice={pickerOf(session, (promote) => edit(choosePromotion(session, promote)), cancelChoice)}
        onHandPieceClick={handClick}
        onTrayClick={trayClick}
      />

      {children?.(controls)}

      {/*
        操作パネル（段階的開示）。**駒を動かすまで出さない**ので、それまでの画面は
        今までと変わらない。コントローラー行より下にあるので、出ても ◀ ▶ は動かない
      */}
      {studying && (
        <StudyPanel
          replaying={replaying}
          sideToMove={state.sideToMove}
          canTogglePromotion={canTogglePromotion(shown)}
          lastMovePromoted={isLastMovePromoted(shown)}
          onReset={() => edit(resetStudy(session))}
          onToggleTurn={guard(() => edit(toggleTurn(shown)))}
          onTogglePromotion={guard(() => edit(togglePromotion(shown)))}
        />
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

        🔴 **`studying` を条件から外した**（決定・2026-09-01）。「評価する」がコントローラー行の
        7 つ目として常設され、棋譜再生中・棋譜側の読み筋を辿っている最中でも押せるようになったため、
        結果もその状態のまま出す。**棋譜側の候補手一覧（`ShogiBoard` の footer）はこれとは別物**
        で、隠したり置き換えたりしない——分岐の再生操作子がそちら側にあるため
        （`EvalResultView` に「この局面の評価」の見出しを足して、どちらの一覧の話か読めるようにする）。
      */}
      {evalState.kind !== 'idle' && (
        <div className="max-w-3xl pt-3 no-tap-select">
          <EvalResultView
            evalState={evalState}
            replay={replay}
            onReplay={changeReplay}
            thresholds={thresholds}
          />
        </div>
      )}
      {footer?.(controls)}
    </>
  );
}
