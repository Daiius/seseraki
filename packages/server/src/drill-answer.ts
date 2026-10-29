/**
 * 出題の採点（prd/13 §5）。**純関数**——DB もエンジンも見ない。
 *
 * 🔴 **採点は server に置く。** 正解手と候補手をクライアントへ先に渡すと、
 * **答えが見えている状態で出題することになる**（prd/13 §7 の「棋譜詳細から出題しない」と同じ理由）。
 *
 * 🔴 **`cpl.ts` の閾値を流用しない**（prd/13 §5.1）。疑問手閾値（既定 300）を正解の線にすると
 * 正解がいくつもある局面ができる。**許容差は閲覧者の設定**として要求ごとに届く。
 */
import {
  applyMove,
  dropDestinations,
  isInCheck,
  moveDestinations,
  type BoardState,
  type PieceKind,
  type Side,
} from 'shared';

export type DrillVerdict = 'correct' | 'close' | 'wrong';

/** 採点の線引き（prd/13 §5.1）。閲覧者の設定（web）から要求ごとに届く */
export interface DrillScoring {
  /** これ以内の損失は**正解**（既定 100cp。「実質的に正解が 1 つ」に寄せる値） */
  correctMargin: number;
  /** これ以内なら**惜しい**（既定は疑問手閾値 300cp） */
  closeMargin: number;
}

export const DEFAULT_SCORING: DrillScoring = { correctMargin: 100, closeMargin: 300 };

/** 採点に要る出題の材料（`drills` の一部） */
export interface DrillAnswerKey {
  kind: 'mate' | 'best';
  answerMove: string;
  answerScoreType: string;
  answerScoreValue: number;
  answerPv: string[] | null;
  candidates: { rank: number; move: string; scoreType: string; scoreValue: number }[];
}

/** 採点した手のスコア（候補手の行 / エンジンの名指し評価、どちらも同じ形） */
export interface ScoredMove {
  scoreType: string;
  scoreValue: number;
}

export interface Scored {
  verdict: DrillVerdict;
  /** 最善との差。**mate が絡む回答では null**（prd/13 §5.1） */
  lossCp: number | null;
}

/**
 * 損失（cp）から 3 段階を決める。
 *
 * ⚠ **負の損失も正解**——2 回の探索は深さが揃わず、実手の方が良い値になることがある
 * （`lossLabel` が負の損失に色を付けないのと同じ理由）。
 */
export function verdictOf(lossCp: number, scoring: DrillScoring): DrillVerdict {
  if (lossCp <= scoring.correctMargin) return 'correct';
  if (lossCp <= scoring.closeMargin) return 'close';
  return 'wrong';
}

/**
 * 1 手を採点する（prd/13 §5.1）。
 *
 * 🔴 **cp 差を取る前にスコア型で分岐する。** 候補手のスコアには `cp` と `mate` があり、
 * mate が絡む変化で cp 差を計算しないのは `cpl.ts` と同じ方針（prd/01 §5）。
 */
export function scoreMove(
  key: DrillAnswerKey,
  move: ScoredMove,
  scoring: DrillScoring,
): Scored {
  if (move.scoreType === 'mate') {
    // 正の mate は**最善が何であれ上回らない**ので、差を取らずに正解。
    // 0 以下（自分が詰まされる / 既に詰み）は不正解
    return { verdict: move.scoreValue > 0 ? 'correct' : 'wrong', lossCp: null };
  }
  if (key.answerScoreType === 'mate') {
    // 最善が詰みで回答が cp。**詰みを逃している**ので不正解（差は測れない）
    return { verdict: 'wrong', lossCp: null };
  }
  const lossCp = key.answerScoreValue - move.scoreValue;
  return { verdict: verdictOf(lossCp, scoring), lossCp };
}

/**
 * 出題時点の候補手から採点する。**候補に無ければ `null`**——エンジンへ回す合図
 * （prd/13 §5.1。候補内はエンジン往復ゼロで即答する）。
 */
export function scoreFromCandidates(
  key: DrillAnswerKey,
  move: string,
  scoring: DrillScoring,
): Scored | null {
  const found = key.candidates.find((c) => c.move === move);
  if (!found) return null;
  return scoreMove(key, found, scoring);
}

/**
 * `moves` が `expected` の先頭と一致するか（**受方の応手まで含めて**照合する）。
 *
 * 🔴 **解答で受け取った手順が、その問いのものかを確かめるのに使う**（レビュー `OCL-41F41851`）。
 * 任意の派生局面を作らせると、**別の局面で採点して出題局面の最善値と比べる**ことになり、
 * 採点も解答履歴も問いと噛み合わなくなる。
 */
export function isPrefixOf(moves: string[], expected: string[]): boolean {
  if (moves.length > expected.length) return false;
  return moves.every((move, i) => move === expected[i]);
}

export type MateStep =
  /** 正解手順どおり。`reply` は受方の応手（無ければ詰み上がり） */
  | { state: 'match'; reply: string | null; solved: boolean }
  /** 正解手順から外れた。エンジンに聞く（別解かもしれない） */
  | { state: 'deviated' };

/**
 * 詰みの指し継ぎを 1 手進める（prd/13 §5.2）。
 *
 * `line` は**出題局面からの全手順**（受方の応手を含む・最後がユーザーの手）。
 * 正解手順は `answerPv` をそのまま使い、**一致している間はエンジンを呼ばない**。
 *
 * ⚠ **別解に入ったら以降の正解手順はエンジンが返した pv に差し替える**（呼び出し側の責務）。
 * ここは「いま持っている手順と一致するか」だけを見る。
 */
export function mateStep(pv: string[] | null, line: string[]): MateStep {
  if (!pv || line.length === 0) return { state: 'deviated' };
  if (line.length > pv.length) return { state: 'deviated' };
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== pv[i]) return { state: 'deviated' };
  }
  const reply = pv[line.length] ?? null;
  // 読み筋を使い切った ＝ 詰み上がり。⚠ 受方の応手が残っているなら詰みではない
  return { state: 'match', reply, solved: reply === null };
}

export type MateLineMatch =
  /** どの手順の先頭とも合わない（任意の派生局面を作らせない。400） */
  | { state: 'mismatch' }
  /** ユーザーの手まで一致した手順がある。`reply` は受方の応手（無ければ詰み上がり） */
  | { state: 'match'; reply: string | null; solved: boolean }
  /**
   * ここまでの手順は合うが、ユーザーの手で外れた。エンジンに聞く（別解かもしれない）。
   * `remainingPlies` は**今の局面からの正解手順の残りの長さ**（ユーザーが指すはずだった手を含む）。並べた順に見て
   * 最初に合った手順（覚えた別解があればそれ）で数える——詰将棋の判定の上限を決める（prd/13 §5.5）
   */
  | { state: 'deviated'; remainingPlies: number };

/**
 * 詰みの解答の手順を、**いま受け付ける正解手順のどれか**に照らす（prd/13 §5.2・§5.3）。
 *
 * 🔴 **元の正解手順（`answerPv`）と覚えた別解の両方を受ける**（2026-10-19 決定）。覚えた別解だけで
 * 照らすと、「最初からやり直す」で元の手順を指したときに 400 になる。
 * 一致した手順で受方の応手を選ぶ——並べた順に見て、**ユーザーの手まで一致した最初の手順**を使う。
 *
 * @param candidates 受け付ける正解手順（覚えた別解・元の pv の順。null / 空は飛ばす）
 * @param line 出題局面からの全手順（最後がユーザーの手）
 */
export function matchMateLine(candidates: (string[] | null)[], line: string[]): MateLineMatch {
  const lines = candidates.filter((c): c is string[] => Array.isArray(c) && c.length > 0);
  const prefix = line.slice(0, -1);
  const fitting = lines.filter((c) => isPrefixOf(prefix, c));
  if (fitting.length === 0) return { state: 'mismatch' };
  for (const candidate of fitting) {
    const step = mateStep(candidate, line);
    if (step.state === 'match') return step;
  }
  return { state: 'deviated', remainingPlies: fitting[0].length - prefix.length };
}

/**
 * 「諦めて答えを見る」の手順が、その問いのものか（prd/13 §5.3。2026-10-19 決定）。
 *
 * - `best` は**空のみ**（1 手も答えていない）
 * - `mate` は確定済みの手順（最後は受方の応手か空 ＝ **偶数手**）で、受け付ける正解手順の**どれかの先頭と一致**
 */
export function isGiveUpLine(
  kind: 'mate' | 'best',
  line: string[],
  candidates: (string[] | null)[],
): boolean {
  if (kind === 'best') return line.length === 0;
  if (line.length % 2 !== 0) return false;
  if (line.length === 0) return true;
  return candidates.some((c) => Array.isArray(c) && isPrefixOf(line, c));
}

/** USI の升表記 → 盤の添字（`1a` = 右上） */
function squareIndex(usi: string): { row: number; col: number } | null {
  const file = Number(usi[0]);
  const rank = usi.charCodeAt(1) - 'a'.charCodeAt(0);
  if (!Number.isInteger(file) || file < 1 || file > 9) return null;
  if (rank < 0 || rank > 8) return null;
  return { row: rank, col: 9 - file };
}

/**
 * その手が**駒の動き方として指せるか**（レビュー `OCL-1A2B07B9`）。
 *
 * 🔴 **`validateMoveOnPosition` に足さない。** あちらは検討盤（フル編集）も通る道で、
 * **合法性を問わないのが仕様**（prd/12 §2.5）。歩を横に動かせることは検討盤では正しい。
 * 出題の解答は「実際に指せた手」でなければ意味がないので、**この経路だけ**で見る。
 *
 * 🔒 **合法手生成器ではない**——選んだ 1 枚の行き先を見るだけで、王手放置は見ない
 * （prd/13 §3。そこはエンジンの担当）。打ち歩詰めは `dropDestinations` が外す
 * （エンジンを落とすので、手前の `validateMoveOnPosition` も `pawn_drop_mate` で弾く）。
 */
export function isReachableMove(state: BoardState, move: string): boolean {
  const drop = /^([PLNSGBR])\*([1-9][a-i])$/.exec(move);
  if (drop) {
    const to = squareIndex(drop[2]);
    if (!to) return false;
    return dropDestinations(state, state.sideToMove, drop[1] as PieceKind).some(
      (d) => d.row === to.row && d.col === to.col,
    );
  }
  const board = /^([1-9][a-i])([1-9][a-i])\+?$/.exec(move);
  if (!board) return false;
  const from = squareIndex(board[1]);
  const to = squareIndex(board[2]);
  if (!from || !to) return false;
  return moveDestinations(state, from).some((d) => d.row === to.row && d.col === to.col);
}

/**
 * 名指し評価が**候補なし**で返ったとき、その手で詰み上がったのかを見る（prd/13 §5.2）。
 *
 * `searchmoves` 非対応の worker は「手を適用した局面を評価する」フォールバックに落ちるため、
 * **その手が即詰みなら相手に指す手が無く候補が空になる**。これを「詰みません」と読むと、
 * **別解の即詰みを取りこぼす**（レビュー `OCL-7ABC2973`）。
 *
 * 🔒 **判定は `shared` の `gameover` と同じ観測事実**——受方の玉が王手されている、の 1 点だけ。
 * 王手の確認を省かない（候補が空になるのは入玉宣言でも起きうる。prd/05 §2.2）。
 */
export function isMateAfter(state: BoardState, move: string, attacker: Side): boolean {
  return givesCheck(state, move, attacker);
}

/**
 * その手を指した局面で、**受方の玉が攻方に王手されているか**（`shared` の `isInCheck`＝`isAttackedBy`）。
 *
 * 🔴 **詰将棋（kind=mate）の解答はどの手にもこれを要求する**（prd/13 §5.2。2026-10-19 決定）。
 * エンジンの mate は静かな手（王手でない手）や回り道も詰みと数えるので、判定をエンジンに任せると
 * 詰め損なっても延々と指し継げる。出題の抽出（`classifyMateLine` の `checkmate`）と同じ条件を判定でも課す。
 * 🔒 新しいルールの実装ではない（prd/13 §3）。読めない手は false
 */
export function givesCheck(state: BoardState, move: string, attacker: Side): boolean {
  let next: BoardState;
  try {
    next = applyMove(state, move);
  } catch {
    return false;
  }
  return isInCheck(next, attacker === 'sente' ? 'gote' : 'sente') === true;
}

/** USI の指し手の形（打ち・移動・成り）。`applyMove` に渡す前の形の確認に使う */
const USI_MOVE = /^(?:[PLNSGBR]\*\d[a-i]|\d[a-i]\d[a-i]\+?)$/;

/**
 * その手を指した局面（prd/13 §5.4）。**出題局面に `line` の 1 手前までを積む**。
 *
 * - `line` があれば手順どおりに進める。読めない手が混ざったら `null`（数字を捏造しない）。
 * - `line` を持たない既存の行は、**次の一手だけ**出題局面をそのまま使える（1 手なので同じ）。
 *   🔒 **詰将棋は `null` を返す**——どの局面で指した手か分からないまま表記を作らない。
 */
export function stateOfAnswer(
  base: BoardState,
  line: string[] | null,
  move: string,
  kind: 'mate' | 'best',
): BoardState | null {
  if (!line || line.length === 0) return kind === 'best' ? base : null;
  // 手順の最後は記録された手そのもの。食い違う行は表記を作らない
  if (line[line.length - 1] !== move) return null;
  let state = base;
  for (const step of line.slice(0, -1)) {
    // ⚠ **`applyMove` は読めない手で例外を投げない**（壊さないよう手番だけ進める）。
    // 形を先に確かめないと、**黙って違う盤面の上で表記を作る**ことになる
    if (!USI_MOVE.test(step)) return null;
    state = applyMove(state, step);
  }
  return state;
}
