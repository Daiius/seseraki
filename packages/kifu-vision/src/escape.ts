/**
 * 盤面が成立しない絵からの脱出——**絵を採らず、規則の側にだけ聞く**
 *
 * 🔴 **直している自己ロック**（3 本目 2 局目 1708〜1777・`HANDOFF-clock.md`「構造的観察」）:
 *
 *   1. 王手の演出（白閃光・赤「王手」）でマスが読めない
 *   2. 読めないマスを `carryUnknowns` が **古い `current`** で埋める
 *   3. 合成した盤が `checkBoard` に落ちる（実測「K が 3 枚」＝移動元に古い駒が残り、
 *      移動先にも本物が写って玉が 2 重になった形）
 *   4. **絵ごと捨てられ `current` が更新されない** → 1 に戻る（実測 156 サンプル連続）
 *
 * ⭐ **壊れているのは「捨て続けても脱出経路が無い」ことだけ。** 演出の絵を捨てる
 * 動作そのものは正しい。要るのは、捨てる前に**もう一度だけ別の問いを立てる**ことである。
 *
 * ⭐ **別の問い**: 合成盤は「81 マスの中身は何か」を絵に尋ねていて、引き継ぎが
 * 混ざると壊れる。だが `pickCandidate` / `pickCandidatePair` は逆向きで、
 * **追跡している局面から起こりうる手を並べ、読めたマスとだけ突き合わせる**。
 * 未確定のマスは「情報が無い」として飛ばすので、**合成盤を一切必要としない**。
 * つまり `checkBoard` に落ちた絵でも、この問いなら答えられることがある。
 *
 * 🔒 **仕切り直し（`RESET_AFTER`）で脱出してはいけない。** 「sanity 捨ても
 * `consecutiveFailures` に数える」案を採らなかったのはこれが理由——仕切り直しは
 * `steps = []` で**断片を切る**。書き出しは局ごとに「いちばん早く始まった断片」を
 * 初期局面から再生する形なので、乱戦の途中で切ると**その後の数十手が棋譜から落ちる**。
 * 持ち駒の信用も失う。ここでの脱出は `current` を 1〜2 手進めるだけで、
 * **断片は切れない**。
 *
 * 🔒 **発明しないための門を 3 つ持たせてある**（呼び出し側の時計拘束と合わせて 4 つ）。
 * ⚠ **時計は「手が指された」の肯定にだけ使う。** 反転の数は手数の下限でしかないので、
 * 「時計が k 手と言うから k 手までしか説明しない」という頭打ちには使えない
 * （`clockFlips` の説明・review bot OCL-69066369）:
 *
 *   - 手は `generateMoves` の産物なので、**規則上あり得ない手は原理的に出ない**
 *   - 食い違いの上限（既定 1）を超えたら選ばない・同点で並んだら選ばない
 *   - **行き先が絵に写っていること**を求める（`requireVisibleDestination`）。
 *     霧の中で「読めないマスへ動いた」と言い出すのは、証拠の不在を証拠として
 *     使うことに他ならない。⚠ これを外すと、未確定のマスを行き先にする候補が
 *     いくつも 0 食い違いで並びうる（同点なら退けられるが、たまたま 1 つに
 *     決まったときに嘘を通す）
 */

import type { BoardState, Square } from 'shared';
import { pickCandidate, pickCandidatePair } from './candidate.ts';
import type { CandidateMove } from './movegen.ts';
import { isUnknown, type VisionSquare } from './uncertain.ts';

export interface RuleOnlyPick {
  /** 見つかった手（1 手か 2 手・指した順） */
  moves: CandidateMove[];
  /** 最後の手まで指した後の盤面 */
  board: Square[][];
  /** 成/不成を決められなかった（2 手のときだけ起こりうる） */
  promotionUncertain: boolean;
  via: 'single' | 'pair';
}

export interface RuleOnlyOptions {
  /**
   * 時計が**この窓で見た反転の数**。
   *
   * 🔒 **これは手数の下限であって、上限ではない。** 1 秒未満の速い手は
   * `CLOCK_MIN_RUN` に満たない連続にしかならず反転として数えられないので、
   * 実際の手数は必ずこれ以上になる（review bot OCL-69066369 と同じ前提）。
   * ⚠ だから「時計が 1 手と言うから 2 手の説明はしない」とは**書けない**。
   * 打った駒がその場で取られる形はまさに 2 手で 1 反転にしかならず、それを
   * 退けると本物の応酬が落ちる。
   *
   * ⭐ ここで使うのは**手が指されたという肯定の証拠**としてだけ。0 なら何も
   * 選ばない（盤と独立な裏付けが 1 つも無いところで規則だけを走らせない）。
   * 発明を防ぐのは食い違いの上限・同点の退け・行き先が絵に写っていること
   * （下の 3 つの門）であって、手数の頭打ちではない。
   */
  clockFlips: number;
  maxConflicts?: number;
  anySide?: boolean;
  /** 行き先が絵に写っていることを求めるか（既定 true）。 */
  requireVisibleDestination?: boolean;
}

/** その手の行き先が、読めた絵の中に**その駒として**写っているか。 */
export function destinationVisible(read: VisionSquare[][], move: CandidateMove): boolean {
  const seen = read[move.to.row][move.to.col];
  if (!seen || isUnknown(seen)) return false;
  return seen.kind === move.becomes && seen.side === move.side;
}

/**
 * 合成盤を作らず、追跡中の局面と読めたマスだけから手を当てにいく。
 *
 * @param before 追跡している局面（盤・持ち駒・手番）
 * @param read   読み（未確定を含む）。引き継ぎで埋めた盤ではなく**素の読み**を渡すこと
 * @returns 決まらなければ null（**決めないことを選べるのが眼目**）
 */
export function pickByRuleOnly(
  before: BoardState,
  read: VisionSquare[][],
  options: RuleOnlyOptions,
): RuleOnlyPick | null {
  const maxConflicts = options.maxConflicts ?? 1;
  const anySide = options.anySide ?? false;
  const requireVisible = options.requireVisibleDestination ?? true;
  if (options.clockFlips < 1) return null;

  const single = pickCandidate(before, read, { maxConflicts, anySide });
  if (single.best && (!requireVisible || destinationVisible(read, single.best.move))) {
    return { moves: [single.best.move], board: single.best.board, promotionUncertain: false, via: 'single' };
  }

  // 1 手で説明が付かないなら 2 手で試す。
  // ⚠ かつては「時計が 2 回以上反転したときだけ」に絞っていた。**それは誤り**——
  // 反転の数は下限でしかなく、打った駒がその場で取られる形は 2 手で 1 反転
  // （あるいは 0 反転）にしかならない。乱戦でいちばん起きる形を退けていた。
  const pair = pickCandidatePair(before, read, { maxConflicts, anySide });
  if (!pair.moves || !pair.board) return null;
  // ⚠ 見るのは**2 手目の行き先**。1 手目の行き先は 2 手目に上書きされることがあり
  // （取り返し）、絵に残っていなくても不思議ではない。
  if (requireVisible && !destinationVisible(read, pair.moves[1])) return null;
  return {
    moves: [pair.moves[0], pair.moves[1]],
    board: pair.board,
    promotionUncertain: pair.promotionUncertain,
    via: 'pair',
  };
}
