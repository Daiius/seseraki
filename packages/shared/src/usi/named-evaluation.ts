/**
 * 出題の採点の名指し評価（prd/13 §5.3・prd/14 §5.10）を、ブラウザのエンジンで読むための純関数。
 *
 * server が「この局面のこの手を名指しで読んでほしい」（局面の SFEN・手・設定）を返したら、ブラウザは
 * `position sfen …` → `go movetime <ms> searchmoves <手>` を読み、その結果をここで報告の形にして解答に付けて送り直す。
 * 🔒 **判定はしない**（server の仕事）。ここは USI の出力から「その手の評価」を取り出すだけ。
 */
import { BROWSER_ANALYSIS_LIMITS } from '../analysis-limits';
import { toBrowserReportCandidate, type BrowserAnalysisSettings } from './browser-analysis';
import { extractMultiPvResults } from './kifu-analysis';
import type { UsiInfo, UsiSearchResult } from './types';

/**
 * 名指し評価の設定（server の `evaluate` の応答の `settings`）。全局面解析の設定に、詰将棋の判定（prd/13 §5.5）の
 * 2 つを足したもの。🔒 **どちらも server が決める**（ブラウザは決めない）
 */
export interface NamedEvalSettings extends BrowserAnalysisSettings {
  /**
   * 固定のスレッド数（詰将棋の判定は 2）。無ければ全局面解析と同じ負荷の設定で決まる（次の一手の採点）。
   * 🔒 負荷の設定（「全力」「控えめ」）によらない——1 手の判定に端末を使い切らない
   */
  threads?: number;
  /** 最初に正の `mate`（bound の付かない `info`）が出たら `stop` を送って打ち切る（{@link isConclusiveMate}） */
  stopOnMate?: boolean;
}

/**
 * 打ち切ってよい `info` か（詰将棋の判定。prd/13 §5.5）: **手番側の正の `mate` で、bound が付かない**（確定した値）。
 * `lowerbound` / `upperbound` の付いた行は途中の値なので打ち切らない。読み筋が詰みの手数より短い行も打ち切らない（判定と別解の手順に使えない）。
 * ⚠ やねうら王は MultiPV 1 でも 9 手以上の詰みは見つけても上限まで止まらない（実測）——だから打ち切りが要る
 */
export function isConclusiveMate(info: UsiInfo): boolean {
  return (
    info.score?.type === 'mate' &&
    Number.isFinite(info.score.value) &&
    info.score.value > 0 &&
    info.bound === undefined &&
    (info.multipv ?? 1) === 1 &&
    // 🔴 **読み筋が詰みの手数まで揃っていること**（レビュー `OCL-D09F6297`）。server は読み筋を別解の正解手順として覚え、
    // その末尾を詰み上がりと読む（prd/13 §5.2）。短い読み筋で打ち切ると、詰む前に正解を記録する・未完の手順を使い切る。
    // 揃っていなければ打ち切らず、後の行（読み筋が補われた行）か上限を待つ
    (info.pv?.length ?? 0) >= info.score.value
  );
}

/**
 * 局面（SFEN）を USI の `position` にする。手数の無い 3 フィールドなら 1 を補う
 * （手元 worker の名指し評価と同じ。探索は手数に依存しない）
 */
export function sfenPositionCommand(sfen: string): string {
  const trimmed = sfen.trim();
  const withPly = trimmed.split(/\s+/).length >= 4 ? trimmed : `${trimmed} 1`;
  return `position sfen ${withPly}`;
}

/**
 * 名指し評価の `go`。⚠ **`searchmoves` は最後に置く**——やねうら王は `searchmoves` の後の語を
 * すべて指し手として読む（`go searchmoves 7g7f movetime 600` だと `movetime` と `600` まで手として読まれる）
 */
export function namedGoCommand(movetimeMs: number, move: string): string {
  return `go movetime ${movetimeMs} searchmoves ${move}`;
}

/** 名指しの読みの間だけ有効にするエンジンのオプション（{@link withAllLegalMoves}） */
export const GENERATE_ALL_LEGAL_MOVES = 'GenerateAllLegalMoves';

/**
 * 名指しの読み（`searchmoves`）の間だけ `GenerateAllLegalMoves` を true にして `run` を実行し、終わったら false に戻す。
 *
 * 🔴 **やねうら王は既定（false）で歩・角・飛の不成などを合法手に含めない。** そのまま `searchmoves` に渡すと
 * root の候補から外れ、名指ししていない通常の探索に落ちる（実際に踏んだ: 9三歩不成 `9d9c` を名指しして `8i8c+` が返った）。
 * 不成の手は悪手であることが多く、採点（不正解・咎め筋）が返ることに意味がある。
 *
 * - 全局面解析の探索には効かせない（読みの後に必ず戻す。投げても戻す）
 * - `isready` は要らない（やねうら王はオプションの変更をその場でフラグに写し、探索の開始時に読む）
 */
export async function withAllLegalMoves<T>(
  engine: { setOption(name: string, value: string): void },
  run: () => Promise<T>,
): Promise<T> {
  engine.setOption(GENERATE_ALL_LEGAL_MOVES, 'true');
  try {
    return await run();
  } finally {
    try {
      engine.setOption(GENERATE_ALL_LEGAL_MOVES, 'false');
    } catch {
      // エンジンが死んでいる（送信が投げる）。読みの失敗のほうを伝える——死んだエンジンは呼び出し側が作り直す
    }
  }
}

/** 名指し評価の結果のうち、解答に付ける評価（`drillNamedEvaluationSchema` の `candidate`） */
export interface NamedCandidate {
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  depth: number;
  pv: string[];
}

export type NamedEvaluationResult =
  /** その手の評価。`candidate` が null なら「候補なし」（エンジンが評価を出さなかった） */
  | { kind: 'ok'; candidate: NamedCandidate | null }
  /**
   * エンジンが名指しした手と違う手を返した（`searchmoves` が効かなかった。その局面で指せない手など）。
   * 🔒 **数字を作らない**——この結果では採点を頼まない（呼び出し側は「採点できない」と出す）
   */
  | { kind: 'mismatch'; returned: string };

/**
 * 探索の結果から、名指しした手の評価を取り出す。server の検証（`drillNamedEvaluationSchema`）を通る形に
 * 切りそろえる（読み筋の長さ・評価値と深さの範囲。全局面解析の報告と同じ `toBrowserReportCandidate`）。
 */
export function namedEvaluationOf(
  result: UsiSearchResult,
  move: string,
  pvMaxPlies: number = BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
): NamedEvaluationResult {
  // 🔴 **打ち切ったなら、打ち切った行の評価値と読み筋を使う**（prd/13 §5.5）。`stop` の後にエンジンが出す行は
  // 打ち切りの理由（確定した詰み）ではないので、判定にも別解の手順にも使わない
  const candidates = extractMultiPvResults(result.stoppedBy ? [result.stoppedBy] : result.infoLines);
  const named = candidates.find((c) => c.move === move);
  if (!named) {
    // 評価を 1 本も出さずに名指しした手を指した ＝ 候補なし。ほかの手の評価が出た・ほかの手を指したなら名指しが効いていない
    if (candidates.length === 0 && result.bestmove.move === move) {
      return { kind: 'ok', candidate: null };
    }
    return { kind: 'mismatch', returned: candidates[0]?.move || result.bestmove.move };
  }
  const report = toBrowserReportCandidate(named, pvMaxPlies);
  if (!report || report.pv === undefined || report.pv[0] !== move) {
    return { kind: 'mismatch', returned: named.move };
  }
  return {
    kind: 'ok',
    candidate: {
      scoreType: report.scoreType,
      scoreValue: report.scoreValue,
      depth: report.depth,
      pv: report.pv,
    },
  };
}
