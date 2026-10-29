/**
 * 対局の結果コード（swars 互換。`SENTE_WIN_CHECKMATE` / `GOTE_WIN_RESIGN` / `DRAW_REPETITION` など。prd/01 §3）の解釈。
 *
 * 一覧の勝敗バッジと LLM 解説用テキスト（`kifu-export`）が同じ解釈を使う。
 * ⚠ server の絞り込み（`kifu-list-query.ts`）と分析の集計は `%SENTE_WIN%` の部分一致で見ている。
 * 結果コードは必ず `SENTE_WIN_` / `GOTE_WIN_` / `DRAW_` で始まるので、前方一致と食い違わない。
 */

export type Winner = 'sente' | 'gote' | 'draw';

/** 勝った側（引き分けは `draw`）。結果が無い・読めないなら null */
export function winnerOf(code: string | null | undefined): Winner | null {
  if (!code) return null;
  if (code.includes('DRAW')) return 'draw';
  if (code.startsWith('SENTE_WIN_')) return 'sente';
  if (code.startsWith('GOTE_WIN_')) return 'gote';
  return null;
}

/**
 * 主体側（自分）から見た勝敗（一覧のバッジ）。
 * - 主体側が決まっていなければ null（バッジを出さない）
 * - 引き分け・結果不明は `none`（`−` のバッジ）
 */
export function subjectOutcomeOf(
  code: string | null | undefined,
  subjectSide: 'sente' | 'gote' | null,
): 'win' | 'loss' | 'none' | null {
  if (subjectSide === null) return null;
  const winner = winnerOf(code);
  if (winner === 'sente' || winner === 'gote') return winner === subjectSide ? 'win' : 'loss';
  return 'none';
}
