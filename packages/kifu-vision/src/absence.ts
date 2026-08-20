/**
 * 「駒があるとは一度も言われていない」という消極的証拠を数える
 *
 * `ReadingHistory` は「同じ読みが続いたこと」（積極的証拠）で確定を出すが、
 * **読み自体が来ないマス**には永遠に飢える。実際に踏んだ（3 本目 31:32 の幻の
 * `B*2d`）: 行き先のマスは盤背景の雲模様で輝度 sd が 12.4 と、空判定のしきい値
 * `EMPTY_MAX_SD = 12` を **0.4 だけ**超え続け、19 秒・約 38 サンプルの間ほぼ
 * ずっと `unknown` のままだった。「空と 3 回連続」は一度も成立せず、幻の駒は
 * `carryUnknowns` に引き継がれて自己保存した。
 *
 * ⭐ そこで読み（20 種のどれか）ではなく **presence（駒の有無の 3 値）**を数える。
 * 空マスが雲模様で `unclear` に居座っても、**`piece` とは言われない**。
 * 本物の駒は sd 51〜71 で `piece` と言われ続ける。つまり
 * 「`piece` と言われないサンプルが長く続く」ことは、駒が無いことの証拠になる。
 *
 * ⚠ 覆い（マウスポインタ・着手演出の閃光）も一時的に `piece` を消すが、
 * ポインタは 1〜2 サンプルで退き（`confirm.ts` の実測）、閃光も 1〜2 秒
 * （0.5 秒刻みで 2〜4 サンプル）で消える。`ABSENT_AFTER = 8`（4 秒）は
 * 観測された最長の覆いの 2 倍で、幻の実測（35 サンプル連続 non-piece）とは
 * 大差がある。
 */

import type { Presence } from './occupancy.ts';

/**
 * 「駒」と一度も言われないサンプルがこれだけ続いたら、駒は無いとみなす。
 *
 * 0.5 秒刻みで 4 秒。ポインタの覆い（1〜2 サンプル）・演出の閃光
 * （2〜4 サンプル）より十分長く、幻の実測（35 サンプル）より十分短い。
 */
export const ABSENT_AFTER = 8;

/**
 * 「駒が本当に居た」と裏が取れたとみなす連続 `piece` サンプル数。
 *
 * `CONFIRM_AFTER`（3 回）と同じ思想。⚠ 1〜2 サンプルの `piece` は
 * スライド中の駒や演出が横切っただけでも出る（幻 `B*2d` の行き先でも
 * 挿し込み直後に 2 サンプルだけ sd 49〜52 の絵が来ていた）ので、
 * 2 では足りない。
 */
export const CORROBORATE_AFTER = 3;

/**
 * 見張り 1 つぶんの消極的証拠。
 *
 * 見張りの登録時に作り、毎サンプル `observe` に見張り先マスの presence を
 * 入れる。判定は 2 つ:
 *
 * - `starved()`: `piece` と言われないまま `ABSENT_AFTER` 連続した
 *   ＝そこに駒は無い（見張りの解決に限り「空と確定」と同じ扱いにしてよい）
 * - `corroborated()`: `piece` が `CORROBORATE_AFTER` 連続したことが一度でもある
 *   ＝駒は本当に居た（挿し込みなら本物だった）
 */
export class AbsenceEvidence {
  private nonPieceStreak = 0;
  private pieceStreak = 0;
  private everCorroborated = false;

  observe(p: Presence): void {
    if (p === 'piece') {
      this.pieceStreak++;
      this.nonPieceStreak = 0;
      if (this.pieceStreak >= CORROBORATE_AFTER) this.everCorroborated = true;
    } else {
      this.nonPieceStreak++;
      this.pieceStreak = 0;
    }
  }

  /** `piece` と言われないまま `after` サンプル連続したか */
  starved(after = ABSENT_AFTER): boolean {
    return this.nonPieceStreak >= after;
  }

  /** 駒が居ることの裏が一度でも取れたか */
  corroborated(): boolean {
    return this.everCorroborated;
  }

  /** いまの non-piece 連続数（ログ用） */
  get streak(): number {
    return this.nonPieceStreak;
  }
}

/**
 * 検疫の門: 挿し込んだ打ちの駒を「動かす」と読めた手を、打ちに読み替えてよいか。
 *
 * 🔴 実測（3 本目 31:32〜31:51・幻の `B*2d`）: 挿し込んだ角の行き先は雲模様で
 * `unknown` に居座り、19 秒後に来た本物の角打ちが「幻の角の移動」として説明されて
 * しまった。移動が受理されると見張りは「別の手が触った」で解除され、以後どの
 * 検算も沈黙する——幻が本物の手にロンダリングされる。
 *
 * ⭐ 挿し込みは推測なので、**駒が本当に居た裏が取れていないうちは、その駒を
 * 動かす解釈を信用しない**。読み替えの結果の盤は移動と同じ（行き先に同じ駒）
 * なので、読み替えで壊れるものは無い。
 *
 * ⚠ 門は狭く保つ:
 * - 裏が取れた挿し込み（`corroborated`）は本物なので触らない
 * - 成る手は読み替えられない（打ちでは成れない）
 * - 取る手は読み替えられない（打ちは空マスにしか打てない）
 * - 動かす側と挿し込んだ側が違うなら、そもそも同じ駒の話ではない
 */
export function shouldQuarantine(
  evidence: AbsenceEvidence,
  move: { side: string; promoted: boolean; captured?: unknown },
  inserted: { side: string },
): boolean {
  if (evidence.corroborated()) return false;
  if (move.side !== inserted.side) return false;
  if (move.promoted) return false;
  if (move.captured) return false;
  return true;
}
