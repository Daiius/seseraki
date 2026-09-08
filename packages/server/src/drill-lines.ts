/**
 * 詰みの指し継ぎで「いまの正解手順」を覚えておく置き場（prd/13 §5.2）。
 *
 * 🔴 **別解に入ったら、エンジンが返した pv を以降の正解手順として引き継ぐ。** 引き継がないと
 * **1 手ごとにエンジンへ聞くことになり**、本番では 1 手あたり十数秒待たされる
 * （`ENGINE_MOVETIME` 1 秒 + worker のポーリング 10 秒間隔。prd/13 §5.1）。
 *
 * 🔒 **手順をクライアントへ渡して持たせない。** 渡した時点で以降の答えが見えているのと同じで、
 * 出題の意味が消える（prd/13 §7）。**server 側に置く。**
 *
 * 🔒 **メモリだけ**（`position-eval.ts` のキャッシュと同じ立場）。再起動で消えるが、
 * そのときは**もう一度エンジンに聞き直すだけ**で、答えが変わるわけではない。
 */

/** 覚えておく問題数の上限。超えたら**古い順に捨てる**（Map は挿入順を保つ） */
const LIMIT = 50;
/** 覚えておく時間。1 問を解いている間だけ持てばよい */
const TTL_MS = 30 * 60 * 1000;

interface Remembered {
  /** 出題局面からの全手順（受方の応手を含む）。`answerPv` と同じ形 */
  line: string[];
  expiresAt: number;
}

const lines = new Map<number, Remembered>();

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of lines) {
    if (entry.expiresAt <= now) lines.delete(id);
  }
  while (lines.size > LIMIT) {
    const oldest = lines.keys().next();
    if (oldest.done) break;
    lines.delete(oldest.value);
  }
}

/** 別解の手順を覚える（同じ問題の古い手順は上書きする） */
export function rememberLine(drillId: number, line: string[]): void {
  lines.delete(drillId);
  lines.set(drillId, { line, expiresAt: Date.now() + TTL_MS });
  sweep();
}

/** 覚えている手順を返す。**無ければ null**（呼び出し側は `answerPv` に戻る） */
export function recallLine(drillId: number): string[] | null {
  const entry = lines.get(drillId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    lines.delete(drillId);
    return null;
  }
  return entry.line;
}

/** 問題を解き終えた / 別の問題へ移ったら忘れる */
export function forgetLine(drillId: number): void {
  lines.delete(drillId);
}

/** テスト用。プロセス状態をリセットする */
export function resetLines(): void {
  lines.clear();
}
