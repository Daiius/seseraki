import { usiToJapaneseWithPiece, type BoardState } from 'shared';
import { applyStudyMoves, currentState } from './study';

/*
  出題の手順の再生（prd/13 §7.9）。正解手順・咎め筋を問題の盤で 1 手ずつ送る。
  棋譜再生画面の読み筋の再生（prd/05 §2.2）と同じ感覚にする——手順を選ぶと盤がその局面になり、
  盤の下の ≪ ◀ ▶ ≫ と ← → Home End で送る。ここは盤を持たない純粋な計算だけ。
*/

/** 再生できる手順 1 本 */
export interface ReplayLine {
  /** 一覧の中での見出し（「正解手順」「詰み手順」「咎め筋」） */
  label: string;
  /** 手順を始める局面 */
  base: BoardState;
  moves: string[];
  /**
   * 再生を始める位置。🔒 **選んだ瞬間に盤が飛ばない位置**にする——盤に出ている手順がこの手順の先頭と
   * 一致していればその手数、一致しなければ 0（始める局面）
   */
  start: number;
}

/** 再生の位置（どの手順の何手目まで。0 は始める局面） */
export interface ReplayCursor {
  line: number;
  position: number;
}

/** 手順の局面と、1 手ずつの日本語の表記を作る（`states[k]` は k 手指した後） */
export function linePositions(line: Pick<ReplayLine, 'base' | 'moves'>): { states: BoardState[]; texts: string[] } {
  const session = applyStudyMoves(line.base, line.moves);
  const states = session.steps.map((step) => step.state);
  const texts = line.moves.map((move, i) => usiToJapaneseWithPiece(states[i], move));
  return { states, texts };
}

/** 盤に出ている手順（`played`）が手順の先頭と一致していればその手数、でなければ 0 */
export function startPositionOf(moves: readonly string[], played: readonly string[]): number {
  if (played.length > moves.length) return 0;
  return played.every((move, i) => moves[i] === move) ? played.length : 0;
}

/**
 * 正解手順。読み筋が無い・正解手から始まらない（保存の取り違え）ときは正解手 1 手だけにする
 * ——正解の表示（`answerMove`）と食い違う手順は出さない
 */
export function answerMovesOf(answerMove: string, answerPv: readonly string[] | null): string[] {
  if (answerPv && answerPv.length > 0 && answerPv[0] === answerMove) return [...answerPv];
  return [answerMove];
}

/**
 * 解答後に再生できる手順（prd/13 §7.9）。
 * - **正解手順**（詰将棋は「詰み手順」）: 出題局面から。次の一手はエンジンの読み筋
 * - **咎め筋**: 出題局面から、盤に出ている手順（答えた手まで）に続けて相手の咎めの手を並べる。
 *   🔒 **答えた手から始める**——自分の手と、それをどう咎められるかを一続きで見せる
 */
export function revealLines(input: {
  kind: 'mate' | 'best';
  base: BoardState;
  /** 盤に出ている、出題局面からの手順（答えた手まで） */
  played: readonly string[];
  answerMove: string;
  answerPv: readonly string[] | null;
  refutation: readonly string[] | undefined;
}): ReplayLine[] {
  const { kind, base, played } = input;
  const answer = answerMovesOf(input.answerMove, input.answerPv);
  const lines: ReplayLine[] = [
    {
      label: kind === 'mate' ? '詰み手順' : '正解手順',
      base,
      moves: answer,
      start: startPositionOf(answer, played),
    },
  ];
  if (input.refutation && input.refutation.length > 0 && played.length > 0) {
    lines.push({
      label: '咎め筋',
      base,
      moves: [...played, ...input.refutation],
      start: played.length,
    });
  }
  return lines;
}

/**
 * 詰将棋の途中で間違えた手の咎め筋（prd/13 §7.9）。解いている局面から、間違えた手と相手の咎めの手。
 * 始める位置は 0（間違えた手は盤から取り消してあるので、盤は始める局面と同じ）
 */
export function missLine(solving: BoardState, wrongMove: string, refutation: readonly string[]): ReplayLine | null {
  if (refutation.length === 0) return null;
  return { label: '咎め筋', base: solving, moves: [wrongMove, ...refutation], start: 0 };
}

/**
 * 再生の最初の位置。🔒 **盤に出ている局面を変えない手順を選ぶ**——後ろ（咎め筋）から順に、盤に出ている手順
 * （`played`。手順を始める局面から）がその手順の先頭と一致するものを選ぶ。どれとも一致しなければ null
 * （回り道で詰ませた・正解手順と違う手で答えた。盤は答えた局面のまま、手順を選ぶか送ると再生に入る）
 */
export function initialCursor(lines: readonly ReplayLine[], played: readonly string[]): ReplayCursor | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line.start === played.length && startPositionOf(line.moves, played) === played.length) {
      return { line: index, position: line.start };
    }
  }
  return null;
}

/** 手順を選び直す。同じ手順なら位置はそのまま、違う手順ならその手順の始める位置へ */
export function selectLine(lines: readonly ReplayLine[], cursor: ReplayCursor | null, line: number): ReplayCursor | null {
  const target = lines[line];
  if (!target) return cursor;
  if (cursor?.line === line) return cursor;
  return { line, position: target.start };
}

/** 再生に入っていないときに送りの行が指す位置（先頭の手順の始める局面） */
export const IDLE_CURSOR: ReplayCursor = { line: 0, position: 0 };

/** 位置を動かす（端で止める） */
export function moveCursor(lines: readonly ReplayLine[], cursor: ReplayCursor, to: number): ReplayCursor {
  const length = lines[cursor.line]?.moves.length ?? 0;
  return { line: cursor.line, position: Math.max(0, Math.min(length, to)) };
}

/** 再生の位置の局面（盤に出すもの）と、直前の手（最終手の強調に使う） */
export function cursorState(lines: readonly ReplayLine[], cursor: ReplayCursor): { state: BoardState; lastMove: string | null } | null {
  const line = lines[cursor.line];
  if (!line) return null;
  const session = applyStudyMoves(line.base, line.moves.slice(0, cursor.position));
  return {
    state: currentState(session),
    lastMove: cursor.position > 0 ? line.moves[cursor.position - 1] : null,
  };
}
