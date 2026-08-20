/**
 * 読み取った配置が将棋の盤面として成立しているか
 *
 * 認識が崩れているかを、手を導く前に判定する道具。次のような場面で効く。
 *
 *   - **感想戦の画面**。盤の位置もマスの大きさも対局中と違うので、固定座標のまま
 *     読むと出鱈目な配置になる。放っておくと「壊れた盤面から手が読めた」ことに
 *     なりかねない
 *   - 演出やマウスポインタで駒の有無を誤ったとき
 *   - 盤面が映っていない場面（対局者紹介など）
 *
 * ここで見るのは駒数・玉・二歩・行き所のない駒だけで、王手放置などは見ない。
 * 「明らかに将棋ではない」を弾くのが目的。
 */

import type { PieceKind, Square } from 'shared';
import { isUnknown, type VisionSquare } from './uncertain.ts';

/** 各駒種の総数（成駒は元の駒に数え戻す） */
const TOTAL_COUNT: Record<string, number> = {
  P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 2,
};

function baseKind(kind: PieceKind): string {
  return kind.startsWith('+') ? kind.slice(1) : kind;
}

export interface SanityResult {
  ok: boolean;
  problems: string[];
}

export function checkBoard(board: Square[][]): SanityResult {
  const problems: string[] = [];

  // 駒種ごとの枚数。盤上だけなので、規定数を超えていたら認識がおかしい。
  const counts = new Map<string, number>();
  const kings = { sente: 0, gote: 0 };
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (!p) continue;
      const base = baseKind(p.kind);
      counts.set(base, (counts.get(base) ?? 0) + 1);
      if (p.kind === 'K') kings[p.side]++;
    }
  }
  for (const [kind, n] of counts) {
    const max = TOTAL_COUNT[kind];
    if (max !== undefined && n > max) problems.push(`${kind} が ${n} 枚（上限 ${max}）`);
  }

  // 玉は各陣営 1 枚。取られることは無いので、盤上に必ずある。
  if (kings.sente !== 1) problems.push(`先手の玉が ${kings.sente} 枚`);
  if (kings.gote !== 1) problems.push(`後手の玉が ${kings.gote} 枚`);

  // 二歩
  for (const side of ['sente', 'gote'] as const) {
    for (let col = 0; col < 9; col++) {
      let n = 0;
      for (let row = 0; row < 9; row++) {
        const p = board[row][col];
        if (p && p.kind === 'P' && p.side === side) n++;
      }
      if (n > 1) problems.push(`${side} の歩が ${9 - col} 筋に ${n} 枚（二歩）`);
    }
  }

  // 行き所のない駒（成っていない歩・香が最奥、桂が奥 2 段）
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (!p) continue;
      const fromEnemyEdge = p.side === 'sente' ? row : 8 - row;
      if ((p.kind === 'P' || p.kind === 'L') && fromEnemyEdge === 0) {
        problems.push(`${9 - col}${String.fromCharCode(97 + row)} に動けない ${p.kind}`);
      }
      if (p.kind === 'N' && fromEnemyEdge <= 1) {
        problems.push(`${9 - col}${String.fromCharCode(97 + row)} に動けない桂`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 規定より多く現れた駒種のうち、一致度の低いマスを「読めなかった」ものとして挙げる。
 *
 * 実測では 5:00〜7:00 の 2 分間、全フレームが「桂が 5 枚（上限 4）」で捨てられ、
 * 1 手も読めなかった。盤上の桂は 4 枚しかないので 5 枚目は誤認識で、
 * **テンプレートの無い成桂（圭）が「桂」と読まれている**とみられる。
 * ポインタのような一時的な揺れと違い、こういう誤認識は**居座り続ける**。
 *
 * 空にしてしまう（`pruneOverflow`）と本物の駒まで消して差分を壊すので、
 * ここでは**位置を挙げるだけ**にする。呼び出し側で `carryUnknowns` に渡せば、
 * 前の配置を引き継いで盤面が成立するようになる。
 *
 * @param scores board と同じ形の NCC。駒が無いマスは NaN。
 */
export function overflowCells(
  board: VisionSquare[][],
  scores: number[][],
): { row: number; col: number }[] {
  const byKind = new Map<string, { row: number; col: number; score: number }[]>();
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      // 未確定のマスはまだ駒種が決まっていないので、枚数には数えない
      if (!p || isUnknown(p)) continue;
      const base = baseKind(p.kind);
      if (!byKind.has(base)) byKind.set(base, []);
      byKind.get(base)!.push({ row, col, score: scores[row][col] });
    }
  }

  const out: { row: number; col: number }[] = [];
  for (const [kind, list] of byKind) {
    const max = TOTAL_COUNT[kind];
    if (max === undefined || list.length <= max) continue;
    // 一致度の低い方から、はみ出した枚数だけ
    const sorted = [...list].sort((a, b) => a.score - b.score);
    for (const c of sorted.slice(0, list.length - max)) out.push({ row: c.row, col: c.col });
  }
  return out;
}

/**
 * 規定より多く現れた駒種について、いちばん一致度の低いマスを空にする。
 *
 * マウスポインタが空マスに重なると輝度の散らばりが増えて「駒あり」と判定され、
 * テンプレート照合が適当な駒を当ててしまう。実測では「桂が 5 枚」「角が 3 枚」の
 * ような盤面が全体の 4 割に出た。
 *
 * 偽物はどのテンプレートにも似ていないので一致度が低い。**枚数が overflow している
 * 駒種に限って**、その駒種と判定されたマスのうち一致度が最低のものから外す。
 * 駒種を限るのは、テンプレートがまだ無い成駒（一致度は低いが本物）を
 * 巻き添えにしないため。
 *
 * @param scores board と同じ形の NCC。駒が無いマスは NaN。
 */
export function pruneOverflow(
  board: Square[][],
  scores: number[][],
): { board: Square[][]; removed: { row: number; col: number; kind: PieceKind }[] } {
  const out = board.map((r) => r.slice());
  const removed: { row: number; col: number; kind: PieceKind }[] = [];

  for (let guard = 0; guard < 8; guard++) {
    const cells = new Map<string, { row: number; col: number; score: number }[]>();
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const p = out[row][col];
        if (!p) continue;
        const base = baseKind(p.kind);
        if (!cells.has(base)) cells.set(base, []);
        cells.get(base)!.push({ row, col, score: scores[row][col] });
      }
    }

    let worst: { row: number; col: number; score: number } | null = null;
    for (const [kind, list] of cells) {
      const max = TOTAL_COUNT[kind];
      if (max === undefined || list.length <= max) continue;
      for (const c of list) {
        if (!worst || c.score < worst.score) worst = c;
      }
    }
    if (!worst) break;

    const piece = out[worst.row][worst.col]!;
    removed.push({ row: worst.row, col: worst.col, kind: piece.kind });
    out[worst.row][worst.col] = null;
  }

  return { board: out, removed };
}

/** 盤上の駒数。持ち駒と合わせて 40 になるはず。 */
export function pieceCount(board: Square[][]): number {
  let n = 0;
  for (const row of board) for (const sq of row) if (sq) n++;
  return n;
}

/**
 * 追跡中の盤面と読みが「同じ側の別の駒」で食い違っているマスを挙げる。
 *
 * 🔒 **これは必ず読み違いである。** そのマスの中身を変えるには、誰かがそこへ
 * 動く必要がある。だが自分の駒は取れないので、**同じ側の別の駒に変わることは
 * 起こりえない**（相手が取れば側が変わるので、この形にはならない）。
 *
 * 🔴 実測（1 局目 16:33〜17:00）: 8f の `▽金` を毎フレーム `▽全`（成銀）と読み、
 * 差分が「1 マスだけ駒種が違う」になって `ambiguous` が出続けた。8 回で
 * 仕切り直しになり、**27 秒ぶんが丸ごと落ちていた**。金と成銀は実測 0.69 相関する。
 *
 * ⚠ `overflowCells` と同じく**位置を挙げるだけ**にする。呼び出し側で
 * `carryUnknowns` に渡せば前の配置を引き継げる。空にすると差分が壊れる。
 *
 * ⚠ 追跡中の盤面が間違っていれば誤りを固定してしまうが、それは引き継ぎ全般の
 * 性質で、ここだけの弱点ではない（`resolveWith` の説明を見ること）。
 */
export function sameSideKindCells(tracked: Square[][], read: VisionSquare[][]): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const a = tracked[row][col];
      const b = read[row][col];
      if (!a || !b || isUnknown(b)) continue;
      if (a.side === b.side && a.kind !== b.kind) out.push({ row, col });
    }
  }
  return out;
}

/**
 * **読みそのもの**（未確定を含む）が将棋の盤面として成立しうるか。
 *
 * ⭐ `checkBoard` との違いは 1 点だけ——**未確定のマスを「何でもありうる」として
 * 扱う**こと。見えている駒だけで矛盾していないかを見る。
 *
 * 🔴 **なぜ要るのか**（3 本目 2 局目 1708〜1777 の自己ロック・`HANDOFF-clock.md`
 * の「構造的観察」）: 王手の応酬で 1 手見逃すと追跡盤面 `current` が古くなる。
 * すると `carryUnknowns` が**古い駒**で未確定のマスを埋め、合成した盤が
 * 「K が 3 枚」「先手の玉が 0 枚」のような成立しない形になる。絵ごと捨てられるので
 * `current` は更新されず、次の絵でも同じことが起きる——**156 サンプル（78 秒）
 * 連続で 1 手も読めなかった。**
 *
 * ⭐ **絵の責任か、引き継ぎの責任かは、ここで割れる。** 合成盤が成立せず、
 * それでも**素の読みは自己矛盾していない**なら、壊したのは引き継いだ `current` の
 * 方である（＝古い）。**絵は捨てるべきでない。**
 *
 * ⚠ **これは「成立する」という保証ではない。** 未確定のマスに何が入るかは
 * 分からないので「見えている範囲では矛盾が無い」しか言えない。だからこの盤面を
 * そのまま追跡に据えてはいけない。使えるのは**判断の材料**としてだけである
 * （呼び出し側は、通ったときに規則の側から手を当てにいく）。
 */
export function checkRead(board: VisionSquare[][]): SanityResult {
  const problems: string[] = [];
  let unknowns = 0;

  const counts = new Map<string, number>();
  const kings = { sente: 0, gote: 0 };
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (!p) continue;
      if (isUnknown(p)) {
        unknowns++;
        continue;
      }
      const base = baseKind(p.kind);
      counts.set(base, (counts.get(base) ?? 0) + 1);
      if (p.kind === 'K') kings[p.side]++;
    }
  }
  // 見えているぶんだけで上限を超えたら、未確定に何が入っても救われない。
  for (const [kind, n] of counts) {
    const max = TOTAL_COUNT[kind];
    if (max !== undefined && n > max) problems.push(`${kind} が ${n} 枚（上限 ${max}）`);
  }

  // 玉は各陣営 1 枚。2 枚見えていれば読み違いだが、**0 枚は未確定のマスに
  // 隠れているだけ**でありうる（王手の演出はまさに玉の周りに出る）。
  for (const side of ['sente', 'gote'] as const) {
    if (kings[side] > 1) problems.push(`${side} の玉が ${kings[side]} 枚`);
    else if (kings[side] === 0 && unknowns === 0) problems.push(`${side} の玉が 0 枚`);
  }

  // 二歩・行き所のない駒は、見えている駒だけで判定する（未確定は数えない）。
  for (const side of ['sente', 'gote'] as const) {
    for (let col = 0; col < 9; col++) {
      let n = 0;
      for (let row = 0; row < 9; row++) {
        const p = board[row][col];
        if (p && !isUnknown(p) && p.kind === 'P' && p.side === side) n++;
      }
      if (n > 1) problems.push(`${side} の歩が ${9 - col} 筋に ${n} 枚（二歩）`);
    }
  }
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board[row][col];
      if (!p || isUnknown(p)) continue;
      const fromEnemyEdge = p.side === 'sente' ? row : 8 - row;
      if ((p.kind === 'P' || p.kind === 'L') && fromEnemyEdge === 0) {
        problems.push(`${9 - col}${String.fromCharCode(97 + row)} に動けない ${p.kind}`);
      }
      if (p.kind === 'N' && fromEnemyEdge <= 1) {
        problems.push(`${9 - col}${String.fromCharCode(97 + row)} に動けない桂`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
