/**
 * 検討盤のセッション状態（prd/12 §3）。
 *
 * 🔒 **ロジックはここ（`.ts`）に置き、コンポーネントに埋めない。** web のテストは
 * `src` 配下の `*.test.ts` だけを対象にする（`vitest.config.ts`）ので、`.tsx` に書いた
 * 分岐は一切テストできない。タップ 2 段の解決・undo スタック・USI 手の組み立て・
 * 評価の送り先の決定は、すべてこのファイルの純関数で行う。
 *
 * 🔒 **盤面編集そのものは `shared/position-edit.ts` を組み合わせるだけ**（M2a）。
 * ここで駒の動かし方を再実装しない。
 *
 * 🔒 **`BoardState` は不変**。各操作は新しい `StudySession` を返し、元は書き換えない
 * （undo スタックが壊れるため）。
 *
 * ## 操作モデル: 選択 → 対象 の 2 段（prd/12 §3.1）
 *
 * 選べるものは 2 種類（盤のマス / 駒台の駒）で、**選んだ状態で別の場所を叩くと
 * そこが行き先になる**。ドラッグ&ドロップは採らない。
 *
 * | 選択 → 叩いた先 | 起きること |
 * |---|---|
 * | マス → マス | `movePiece`（重ねた駒は動かした側の持ち駒へ） |
 * | マス → 駒台 | `moveToHand`（その側の持ち駒になる） |
 * | 駒台の駒 → マス | `dropFromHand`（打つ） |
 *
 * 同じものをもう一度叩けば選択解除。**行き先を選ぶ前なら選び直せる**ので、盤マスが
 * 44px 基準を下回る例外（prd/12 §3.3）をこの 2 段が支えている。
 *
 * 🔴 **駒箱は持たない**（prd/12 §3.2・決定 2026-08-28）。駒箱は「盤にも持ち駒にもない駒」の
 * 置き場だが、実際には**盤から抜いた駒の退避先でしかない**——駒台がその役を兼ねられる。
 * 駒の総数は元から変えられないので、失われる機能もない。
 * ⚠ `shared` の `pieceBox` は残っているが、**web からはもう使わない**（server / MCP 向け）。
 */
import {
  canPromote,
  dropFromHand,
  handCount,
  movePiece,
  moveToHand,
  pieceAt,
  positionSfen,
  toggleSideToMove,
  unpromoted,
  type BoardState,
  type HandPieceKind,
  type PieceKind,
  type Side,
  type SquareRef,
} from 'shared';

/** 選択中のもの。行き先を叩くまで保持する */
export type StudySelection =
  | { kind: 'square'; square: SquareRef }
  | { kind: 'hand'; side: Side; piece: HandPieceKind };

/** 手順 1 段。`steps[0]` は起点（棋譜の局面）で `move` は常に null */
export interface StudyStep {
  state: BoardState;
  /**
   * この局面に至った**盤上の手**（USI）。駒箱・持ち駒・手番の編集で進んだ段は null。
   * 名指し評価（「この手を読む」）はこれが非 null のときだけ出せる。
   */
  move: string | null;
}

/**
 * 検討セッション。**一本道 + undo / redo**（prd/12 §3.2。分岐ツリーは持たない）。
 * セッション内限定で保存しない。
 *
 * 🔴 **undo スタックではなく「手順の配列 + 現在位置」で持つ**（決定・2026-08-28）。
 * 検討中は ◀ ▶ が undo / redo に変わる（prd/12 §3.1）ので、**戻した先から
 * やり直せる**必要がある。捨ててしまう undo スタックでは redo が作れない。
 */
export interface StudySession {
  /** 手順の全体。`steps[0]` が起点で、`cursor` より後ろは「戻したぶん」 */
  steps: StudyStep[];
  /** 今どこを見ているか（0 = 起点）。`steps.length - 1` 未満なら redo できる */
  cursor: number;
  selection: StudySelection | null;
}

/** 棋譜の局面を起点にセッションを作る */
export function createStudySession(base: BoardState): StudySession {
  return { steps: [{ state: base, move: null }], cursor: 0, selection: null };
}

/** 現在の検討局面 */
export function currentState(session: StudySession): BoardState {
  return session.steps[session.cursor].state;
}

/** 起点（棋譜の局面） */
export function baseState(session: StudySession): BoardState {
  return session.steps[0].state;
}

/**
 * 検討が始まっているか（＝1 段でも進めたか）。
 * **これが true になって初めて操作パネルを出す**（段階的開示。prd/12 §3.1）。
 *
 * 🔴 **`cursor` では判定しない。** 起点まで戻しても検討からは抜けない
 * （prd/12 §3.1・決定 2026-08-28）——抜けると同じ ◀ が 1 回のタップで
 * 「undo」から「棋譜の手送り」へ意味を変えることになり分かりにくい。
 * 抜けるのは明示的に「棋譜に戻る」を押したときだけ。
 */
export function isStudying(session: StudySession): boolean {
  return session.steps.length > 1;
}

/** 現在位置の段に至った盤上の手（無ければ null） */
export function lastMove(session: StudySession): string | null {
  return session.steps[session.cursor].move;
}

/** 1 手戻せるか（◀ の有効・無効） */
export function canUndo(session: StudySession): boolean {
  return session.cursor > 0;
}

/** やり直せるか（▶ の有効・無効） */
export function canRedo(session: StudySession): boolean {
  return session.cursor < session.steps.length - 1;
}

/* ---------- USI 座標 ---------- */

/** `board[row][col]` の添字 → USI 座標（例 `{row:6,col:2}` → `7g`） */
export function usiSquare({ row, col }: SquareRef): string {
  return `${9 - col}${String.fromCharCode(97 + row)}`;
}

/** USI 座標（例 `7g`）→ `board` の添字 */
export function squareOfUsi(usi: string): SquareRef {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

/** 盤上の移動（`7g7f` / 成りは `7g7f+`） */
export function usiMoveOf(from: SquareRef, to: SquareRef, promote = false): string {
  return `${usiSquare(from)}${usiSquare(to)}${promote ? '+' : ''}`;
}

/** 駒打ち（`P*5e`） */
export function usiDropOf(kind: HandPieceKind, to: SquareRef): string {
  return `${kind}*${usiSquare(to)}`;
}

/* ---------- 内部ヘルパー ---------- */

function sameSquare(a: SquareRef, b: SquareRef): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * 1 段進める。**局面が変わらなかったら段を積まない**（`position-edit` の関数は
 * 不正な入力で state をそのまま返すので、同一性で「効かなかった」を判定できる）。
 *
 * 🔴 **戻した先で新しい手を指したら、その先の redo 分は捨てる**（prd/12 §3.2）。
 * 手順は一本道のままにする——残すと分岐ツリーになり、後続候補に回した話に踏み込む。
 */
function push(
  session: StudySession,
  state: BoardState,
  move: string | null,
): StudySession {
  if (state === currentState(session)) return { ...session, selection: null };
  const steps = session.steps.slice(0, session.cursor + 1);
  steps.push({ state, move });
  return { steps, cursor: steps.length - 1, selection: null };
}

/**
 * 指した側の手番だったら手番を進める。
 *
 * ⚠ **`movePiece` 自体は手番を触らない**（M2a の純関数は「編集」なので当然）。
 * ただし検討盤では「手番側の駒を動かす」＝**指し手**なので、そのまま手番を渡さないと
 * 直後の「この局面を評価」が**相手玉を取れる局面**として弾かれ、意味も合わない。
 * 相手側の駒を動かしたときは編集とみなして手番を触らない（手番トグルで直せる）。
 */
function advanceTurn(next: BoardState, moverSide: Side, before: BoardState): BoardState {
  if (next === before) return next;
  return moverSide === before.sideToMove ? toggleSideToMove(next) : next;
}

/* ---------- タップの解決 ---------- */

/** 盤のマスを叩いた */
export function tapSquare(session: StudySession, square: SquareRef): StudySession {
  const state = currentState(session);
  const sel = session.selection;

  if (sel === null) {
    // 1 段目: 駒のあるマスだけ選べる（空きマスを叩いても何も起きない）
    return pieceAt(state, square)
      ? { ...session, selection: { kind: 'square', square } }
      : session;
  }

  if (sel.kind === 'square') {
    if (sameSquare(sel.square, square)) return { ...session, selection: null };
    const piece = pieceAt(state, sel.square);
    if (!piece) return { ...session, selection: null };
    const moved = movePiece(state, sel.square, square);
    return push(
      session,
      advanceTurn(moved, piece.side, state),
      usiMoveOf(sel.square, square),
    );
  }

  // 持ち駒から打つ
  const dropped = dropFromHand(state, sel.side, sel.piece, square);
  return push(
    session,
    advanceTurn(dropped, sel.side, state),
    usiDropOf(sel.piece, square),
  );
}

/**
 * 駒台を叩いた。`piece` を省くと**受け皿**（盤の駒を選んでいる間だけ出る）を叩いた扱い。
 *
 * 🔴 **これが駒箱の代わり**（prd/12 §3.2・決定 2026-08-28）。盤の駒を選んだ状態で
 * 駒台を叩けば、その駒はその側の持ち駒になる（成駒は生駒に戻る）。駒箱は
 * 「盤にも持ち駒にもない駒」の置き場だが、実際には**盤から抜いた駒の退避先でしかない**
 * ので、駒台がその役を兼ねれば UI に出す理由が無くなる。駒の総数は元から変えられない
 * ので、失われる機能もない。
 *
 * ⚠ 選択中のものがあるときは**叩いた駒種ではなく選択中の駒**が動く（行き先として
 * 振る舞う）。選択が無いときだけ、叩いた駒種そのものを選ぶ——**受け皿を叩いても
 * 何も起きない**（そこから選択が始まったりはしない）。
 */
export function tapHand(
  session: StudySession,
  side: Side,
  piece?: HandPieceKind,
): StudySession {
  const state = currentState(session);
  const sel = session.selection;

  if (sel === null) {
    if (!piece || handCount(state, side, piece) <= 0) return session;
    return { ...session, selection: { kind: 'hand', side, piece } };
  }

  if (sel.kind === 'square') {
    // 盤の駒を駒台へ。⚠ **玉は持ち駒にできない**ので盤から消えるだけになる
    //（`moveToHand` の仕様）
    return push(session, moveToHand(state, sel.square, side), null);
  }

  if (sel.side === side && sel.piece === piece) {
    return { ...session, selection: null };
  }
  // 別の持ち駒を叩いたら選び直し（持ち駒同士の受け渡しは用途が無い）
  return piece && handCount(state, side, piece) > 0
    ? { ...session, selection: { kind: 'hand', side, piece } }
    : { ...session, selection: null };
}

/* ---------- パネルの操作 ---------- */

/** 手番を入れ替える（prd/12 §2.3。手番を問わず評価できる） */
export function toggleTurn(session: StudySession): StudySession {
  return push(session, toggleSideToMove(currentState(session)), null);
}

/**
 * 1 段戻す（◀）。**起点までしか戻らない**（起点で押しても何も起きない）。
 * ⚠ 手順そのものは捨てない——戻したぶんは `redo` でやり直せる。
 */
export function undo(session: StudySession): StudySession {
  if (!canUndo(session)) return { ...session, selection: null };
  return { ...session, cursor: session.cursor - 1, selection: null };
}

/** 戻したぶんを 1 段やり直す（▶） */
export function redo(session: StudySession): StudySession {
  if (!canRedo(session)) return { ...session, selection: null };
  return { ...session, cursor: session.cursor + 1, selection: null };
}

/**
 * 検討の起点まで戻す（≪）。**検討からは抜けない**（手順は残り、▶ でやり直せる）。
 * 棋譜へ戻るのは `resetStudy`（「棋譜に戻る」ボタン）だけ。
 */
export function undoAll(session: StudySession): StudySession {
  if (!canUndo(session)) return { ...session, selection: null };
  return { ...session, cursor: 0, selection: null };
}

/** 検討の最後まで進める（≫） */
export function redoAll(session: StudySession): StudySession {
  if (!canRedo(session)) return { ...session, selection: null };
  return { ...session, cursor: session.steps.length - 1, selection: null };
}

/** 棋譜の局面へ戻す（検討を捨てる） */
export function resetStudy(session: StudySession): StudySession {
  return createStudySession(baseState(session));
}

/** 直前の盤上の手を、成 / 不成で指し直せるか */
export function canTogglePromotion(session: StudySession): boolean {
  return promotionRetry(session) !== null;
}

/**
 * 直前の盤上の手の成り / 不成を切り替える（指し直す）。
 *
 * タップ 2 段では成りを聞かないので、**指した後にここで切り替える**。
 * 段を積み増さず**直前の段を差し替える**（成 / 不成は 1 つの手の 2 つの形なので、
 * undo 2 回で元へ戻る形にすると手順の意味がずれる）。
 */
export function togglePromotion(session: StudySession): StudySession {
  const retry = promotionRetry(session);
  if (!retry) return session;
  // 現在位置の段を差し替える。⚠ その先の redo 分は元の手から続いていたので捨てる
  const steps = session.steps.slice(0, session.cursor);
  steps.push({ state: retry.state, move: retry.move });
  return { steps, cursor: steps.length - 1, selection: null };
}

function promotionRetry(
  session: StudySession,
): { state: BoardState; move: string } | null {
  if (session.cursor < 1) return null;
  const last = session.steps[session.cursor];
  const prevStep = session.steps[session.cursor - 1];
  const move = last.move;
  // 駒打ちは成って打てない（`P*5e` に `+` は付かない）
  if (!move || !/^[1-9][a-i][1-9][a-i]\+?$/.test(move)) return null;

  const promoted = move.endsWith('+');
  const from = squareOfUsi(move.slice(0, 2));
  const to = squareOfUsi(move.slice(2, 4));
  const piece = pieceAt(prevStep.state, from);
  if (!piece) return null;
  // 成れない駒（金・玉）と、元から成っている駒を動かした手は切り替えの対象外
  if (!promoted && !canPromote(piece.kind)) return null;
  if (!promoted && unpromoted(piece.kind) !== piece.kind) return null;

  const moved = movePiece(prevStep.state, from, to, { promote: !promoted });
  return {
    state: advanceTurn(moved, piece.side, prevStep.state),
    move: usiMoveOf(from, to, !promoted),
  };
}

/**
 * USI の手順をタップ操作としてそのまま流し、セッションを組み立てる。
 *
 * **テストと DEV ギャラリー（`/dev-gallery`）で「検討中の状態」を固定するための入口。**
 * 盤面をハードコードせず、実際のタップと同じ経路（`tapSquare` / `tapHand`）を通すので、
 * 操作モデルを変えたらここも一緒に壊れる（＝嘘をつかない）。
 */
export function applyStudyMoves(base: BoardState, moves: string[]): StudySession {
  let session = createStudySession(base);
  for (const move of moves) {
    const drop = move.match(/^([PLNSGBR])\*([1-9][a-i])$/);
    if (drop) {
      session = tapHand(
        session,
        currentState(session).sideToMove,
        drop[1] as HandPieceKind,
      );
      session = tapSquare(session, squareOfUsi(drop[2]));
      continue;
    }
    session = tapSquare(session, squareOfUsi(move.slice(0, 2)));
    session = tapSquare(session, squareOfUsi(move.slice(2, 4)));
    if (move.endsWith('+')) session = togglePromotion(session);
  }
  return session;
}

/* ---------- 評価の送り先 ---------- */

/**
 * 評価の送り先。`sfen` と `move` がそのまま `POST /api/positions/evaluate` の body になる。
 *
 * 🔴 **基点（`from`）も一緒に返す**（レビュー指摘 `OCL-753E7A28`）。送る SFEN の元になった
 * 局面は、**クライアント検証にも結果の保存（咎め筋の再生の基点）にも要る**。呼び出し側で
 * 別に計算すると、`cursor` が末尾に無いとき（undo して redo 分が残っているとき）に
 * 簡単にずれる——実際、cursor 方式へ変えたときに名指し評価の基点だけが配列末尾基準の
 * まま取り残されていた。**送信対象と基点は 1 つの関数から導出する。**
 */
export interface EvalTarget {
  /** 送る局面（正規化 SFEN） */
  sfen: string;
  /** 名指し評価の対象手（局面評価は null） */
  move: string | null;
  /** `sfen` の元になった局面そのもの。検証と PV 再生の基点 */
  from: BoardState;
}

/** 「この局面を評価」: 現在の検討局面をそのまま送る */
export function positionEvalTarget(session: StudySession): EvalTarget {
  const from = currentState(session);
  return { sfen: positionSfen(from), move: null, from };
}

/**
 * 「この手を読む」: **直前の手を、その手を指す前の局面で**名指しする。
 *
 * ⚠ 送る SFEN は「1 つ前の段」。名指し評価は `go searchmoves <手>` なので、
 * 手を適用した後の局面を送ると別の手を読むことになる。
 * 直前の段が編集（駒箱・持ち駒・手番）なら名指しできないので null を返す。
 */
export function namedEvalTarget(session: StudySession): EvalTarget | null {
  if (session.cursor < 1) return null;
  const move = lastMove(session);
  if (!move) return null;
  // ⚠ **`cursor` の 1 つ手前**。配列の末尾ではない（undo して redo 分が残っていると
  //    末尾は「まだやり直していない先の局面」で、送る手とも噛み合わない）
  const from = session.steps[session.cursor - 1].state;
  return { sfen: positionSfen(from), move, from };
}
