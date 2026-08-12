/**
 * 「起こりうる手」を先に並べて、読みといちばん整合するものを選ぶ
 *
 * `inferMove` は差分から手を導く。**読めたマスが足りていれば強い**が、
 * 移動先が未確定だと「どの駒がそこへ来たか」が決まらず、成ったかどうかも
 * 決められない（`solveUnknowns` が曖昧として諦めるのはここ）。
 *
 * 向きを逆にすると、その困りかたが消える。合法手はルールで閉じた集合なので、
 * **未確定のマスは「情報が無い」として飛ばせばよい**——読めたマスだけで
 * 候補が 1 つに絞れることが多い。
 *
 * ⚠ **読みの置き換えではない。** 追跡中の盤面が間違っていれば候補も丸ごと
 * 間違う（誤りが自己強化する）。`inferMove` で決まらなかったときの
 * second opinion として使う。
 */

import type { BoardState, PieceKind, Square } from 'shared';
import { generateMoves, type CandidateMove } from './movegen.ts';
import { isUnknown, type VisionSquare } from './uncertain.ts';

export interface CandidateScore {
  move: CandidateMove;
  /**
   * **駒があるかどうか**が食い違った数。
   *
   * ⭐ こちらは信用してよい。駒の有無はマス内側の輝度の散らばりで見ており、
   * 空マス 2〜9 / 駒あり 51〜71 と完全に 2 山へ割れる（間に 40 以上の隙間）。
   */
  occupancyConflicts: number;
  /**
   * 駒はあるが**駒種か向きが違った**数。
   *
   * ⚠ こちらは当てにならない。似た字（金と全）は 0.8 相関し、ポインタや
   * ハイライトが乗れば簡単に順位が入れ替わる。**ここを直すのがルールの仕事。**
   */
  identityConflicts: number;
  /** 上の 2 つの合計 */
  conflicts: number;
  /** 読めたマスのうち、この手の結果と一致した数 */
  agrees: number;
  /** この手を指した後の盤面 */
  board: Square[][];
}

function applyToBoard(board: Square[][], move: CandidateMove): Square[][] {
  const next = board.map((r) => r.slice());
  if (move.from) next[move.from.row][move.from.col] = null;
  next[move.to.row][move.to.col] = { kind: move.becomes, side: move.side };
  return next;
}

function sameSquare(a: Square, b: Square): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.side === b.side;
}

/**
 * 候補手それぞれについて、読みとどれだけ合うかを数える。
 *
 * ⚠ **未確定のマスは数えない**（一致にも食い違いにも入れない）。
 * 「読めなかった」ことを「違っていた」と混ぜると、正しい候補が沈む。
 *
 * ⚠ 追跡中の盤面に古い読み違えが残っていると、**すべての候補に等しく
 * 食い違いが乗る**。だから「食い違いが 0 か」ではなく「食い違いが最も
 * 少ないのが 1 つに決まるか」で判断する。
 */
export function scoreCandidates(
  before: BoardState,
  read: VisionSquare[][],
  moves: CandidateMove[],
): CandidateScore[] {
  return moves.map((move) => {
    const board = applyToBoard(before.board, move);
    let occupancyConflicts = 0;
    let identityConflicts = 0;
    let agrees = 0;
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const seen = read[row][col];
        if (isUnknown(seen)) continue;
        const expected = board[row][col];
        if (sameSquare(seen, expected)) agrees++;
        else if (!seen !== !expected) occupancyConflicts++;
        else identityConflicts++;
      }
    }
    return {
      move,
      occupancyConflicts,
      identityConflicts,
      conflicts: occupancyConflicts + identityConflicts,
      agrees,
      board,
    };
  });
}

export type PickFailure =
  /** 候補が 1 つも無い（詰んでいるか、盤面が壊れている） */
  | 'no-candidates'
  /** いちばん合う候補が複数あり、決められない */
  | 'ambiguous'
  /** いちばん合う候補でも食い違いが多すぎる。1 手では説明が付かない */
  | 'too-many-conflicts';

export interface PickResult {
  best: CandidateScore | null;
  failure: PickFailure | null;
  /** 同点で並んだ候補（`ambiguous` のとき中身が入る） */
  tied: CandidateScore[];
}

export interface PickOptions {
  /**
   * 採用してよい食い違いの上限。
   *
   * 0 にすると、追跡中の盤面に古い誤りが 1 つでもあると何も選べなくなる。
   * 1 なら「読めているマスが 1 つだけずれている」までは許す。
   */
  maxConflicts?: number;
  /**
   * どちらの手番か分からないときに true。両者の手を候補に入れる。
   *
   * 途中の局面から仕切り直したときは手番が分からない。候補が倍になるが、
   * **狭める方に間違えると正しい手が消える**ので、分からないなら広く取る。
   */
  anySide?: boolean;
  /**
   * 同点になったときの決め手。小さいほど良い候補として並べ替える。
   *
   * 成るか成らないかで割れたときに、**移動先のマスの絵**を見て決めるために使う。
   * ⭐ ここが効くのは「候補が必ず X か +X の 2 つ」だからで、
   * **生駒のテンプレートは必ず持っている**ため、成駒のテンプレートが
   * 1 枚も無くても決められる。
   */
  tieBreak?: (a: CandidateScore, b: CandidateScore) => number;
}

/**
 * 読みといちばん整合する手を 1 つ選ぶ。
 *
 * 決められなければ理由を返す。**曖昧なまま選ぶくらいなら選ばない**——
 * 誤った手を 1 つ通すと、以後の盤面がすべてずれる。
 */
export function pickCandidate(
  before: BoardState,
  read: VisionSquare[][],
  options: PickOptions = {},
): PickResult {
  const maxConflicts = options.maxConflicts ?? 1;
  const moves = options.anySide
    ? [
        ...generateMoves({ ...before, sideToMove: 'sente' }),
        ...generateMoves({ ...before, sideToMove: 'gote' }),
      ]
    : generateMoves(before);
  if (moves.length === 0) return { best: null, failure: 'no-candidates', tied: [] };

  // ⭐ **駒の有無を先に見て、駒種は後で見る。** 同列に数えると決められない。
  //
  // 実際に踏んだ形（16:32）: 相手が金を打ったのに `▽全` と読まれた。
  // 正解の `G*8f` は「8f に駒があること」は合っていて、駒種だけが違う。
  // ところが**8f を空のままにする候補も食い違いは同じ 1** なので、合計で数えると
  // 何十手もが同点に並び、決められない。
  //
  // 有無と駒種では信用度がまるで違う。有無は完全に 2 山へ割れるが、駒種は
  // 似た字なら 0.8 相関する。**信用できる方を先に見る。**
  const rank = (a: CandidateScore, b: CandidateScore) =>
    a.occupancyConflicts - b.occupancyConflicts || a.identityConflicts - b.identityConflicts;
  const scored = scoreCandidates(before, read, moves).sort(rank);
  const head = scored[0];
  if (head.conflicts > maxConflicts) return { best: null, failure: 'too-many-conflicts', tied: [] };

  let tied = scored.filter((s) => rank(s, head) === 0);
  if (tied.length > 1 && options.tieBreak) {
    tied = [...tied].sort(options.tieBreak);
    // 決め手が本当に差を付けられたときだけ 1 つに絞る
    if (options.tieBreak(tied[0], tied[1]) < 0) return { best: tied[0], failure: null, tied };
  }
  if (tied.length > 1) return { best: null, failure: 'ambiguous', tied };
  return { best: tied[0], failure: null, tied };
}

export interface PairPickResult {
  /** 見つかった 2 手（指した順） */
  moves: [CandidateMove, CandidateMove] | null;
  /** 2 手目まで指した後の盤面 */
  board: Square[][] | null;
  failure: PickFailure | null;
  /** 同点で並んだ組み合わせの数 */
  tiedCount: number;
  /**
   * 成ったかどうかを決められなかった。
   *
   * ⭐ **成った駒がその場で取られると、成/不成は原理的に区別できない。**
   * 盤も持ち駒も完全に同じになるからで（成駒は取られると生駒として持ち駒に入る）、
   * どれだけ映像を細かく見ても決まらない。**手そのものは正しいので、
   * 曖昧として捨てず、成りが未確定であることを添えて返す。**
   */
  promotionUncertain: boolean;
}

/**
 * 1 手で説明が付かないとき、**2 手の組み合わせ**で説明できるかを探す。
 *
 * 🔴 **映像を細かく探しても届かない場合がある。** 実測（13:06〜14:08）: 香が角を
 * 取り、数秒後に銀が取り返した。0.1 秒刻みで読み直しても、「香が取ったが銀が
 * まだ取り返していない」中間の局面は**どのフレームにも読める形で現れない**——
 * その間ずっと移動先が未確定だったため。
 *
 * ⭐ **中間の絵は要らない。** 差分は「香 7f→7g（角を取る）」→「銀 6h→7g（取り返す）」の
 * 2 手で一意に説明できる。**必要なのは映像の探索ではなく、盤面の論理での分解。**
 *
 * ⚠ 手番は必ず交互になる。同じ側が 2 手続けて指すことはないので、
 * 2 手目は自動的に相手の手になる（`applyMove` が手番を進める）。
 *
 * 計算量は 100 × 100 程度。**1 手で決まらなかったときにだけ呼ぶ**なら十分速い。
 */
export function pickCandidatePair(
  before: BoardState,
  read: VisionSquare[][],
  options: PickOptions = {},
): PairPickResult {
  const maxConflicts = options.maxConflicts ?? 1;
  const firstSides: BoardState[] = options.anySide
    ? [{ ...before, sideToMove: 'sente' }, { ...before, sideToMove: 'gote' }]
    : [before];

  interface Pair { first: CandidateMove; second: CandidateMove; board: Square[][]; occ: number; id: number }
  let best: Pair | null = null;
  let tied: Pair[] = [];
  let any = false;

  for (const start of firstSides) {
    for (const first of generateMoves(start)) {
      const mid: BoardState = {
        board: applyToBoard(start.board, first),
        hand: handAfter(start, first),
        sideToMove: first.side === 'sente' ? 'gote' : 'sente',
      };
      for (const second of generateMoves(mid)) {
        any = true;
        const board = applyToBoard(mid.board, second);
        let occ = 0;
        let id = 0;
        for (let row = 0; row < 9; row++) {
          for (let col = 0; col < 9; col++) {
            const seen = read[row][col];
            if (isUnknown(seen)) continue;
            const expected = board[row][col];
            if (sameSquare(seen, expected)) continue;
            if (!seen !== !expected) occ++;
            else id++;
          }
        }
        const cand: Pair = { first, second, board, occ, id };
        if (!best || occ < best.occ || (occ === best.occ && id < best.id)) {
          best = cand;
          tied = [cand];
        } else if (occ === best.occ && id === best.id) {
          tied.push(cand);
        }
      }
    }
  }

  const none = { moves: null, board: null, tiedCount: 0, promotionUncertain: false } as const;
  if (!any || !best) return { ...none, failure: 'no-candidates' };
  if (best.occ + best.id > maxConflicts) return { ...none, failure: 'too-many-conflicts' };

  if (tied.length > 1) {
    // ⭐ 同点でも、**行き先が全部同じで違いが成/不成だけ**なら手そのものは決まっている。
    // 成った駒がその場で取られると盤も持ち駒も同じになるので、これは原理的に
    // 区別できない。曖昧として捨てるより、成りが未確定であることを添えて返す方がよい。
    const sameRoute = tied.every(
      (p) =>
        p.first.usi.replace(/\+$/, '') === best!.first.usi.replace(/\+$/, '') &&
        p.second.usi.replace(/\+$/, '') === best!.second.usi.replace(/\+$/, ''),
    );
    if (!sameRoute) {
      return { moves: null, board: null, failure: 'ambiguous', tiedCount: tied.length, promotionUncertain: false };
    }
    // 成らずの方を採る。**当てずっぽうで `+` を付けない**（付けた方が当たりやすい
    // 局面は多いが、外したときに棋譜が静かに嘘になる）。
    const plain = tied.find((p) => !p.first.promotes && !p.second.promotes) ?? best;
    return {
      moves: [plain.first, plain.second],
      board: plain.board,
      failure: null,
      tiedCount: tied.length,
      promotionUncertain: true,
    };
  }
  return {
    moves: [best.first, best.second],
    board: best.board,
    failure: null,
    tiedCount: 1,
    promotionUncertain: false,
  };
}

/** 手を指した後の持ち駒。取った駒が増え、打った駒が減る。 */
function handAfter(state: BoardState, move: CandidateMove): BoardState['hand'] {
  const side = move.side;
  const mine = { ...state.hand[side] };
  if (move.from === null) {
    const left = (mine[move.kind] ?? 0) - 1;
    if (left > 0) mine[move.kind] = left;
    else delete mine[move.kind];
  } else if (move.captures) {
    // 成駒を取ったら生駒として持ち駒に入る
    const base = (UNPROMOTE[move.captures] ?? move.captures) as PieceKind;
    mine[base] = (mine[base] ?? 0) + 1;
  }
  return { ...state.hand, [side]: mine };
}

const UNPROMOTE: Partial<Record<PieceKind, PieceKind>> = {
  '+P': 'P', '+L': 'L', '+N': 'N', '+S': 'S', '+B': 'B', '+R': 'R',
};
