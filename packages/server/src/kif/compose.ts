/**
 * USI 指し手列から KIF テキストを合成する（prd/10 §4.2）。
 *
 * 動画解析で復元した棋譜には **KIF 原文が存在しない**が、`kifus.kifText` は notNull で、
 * 表示・再変換・エクスポートがこの列を前提にしている。合成して埋めることで既存経路が
 * そのまま動く。
 *
 * ⭐ **合成した KIF は必ず [verifyRoundTrip] に通す。** `parseKif` で読み直して元の USI に
 * 戻ることを確かめれば、**合成の誤りがそのまま棋譜として保存されるのを防げる**。
 * 復元した棋譜の正しさを外から確かめる手段は乏しいので、独立した検算は 1 本でも多い方がよい。
 *
 * ⚠ 合成である以上、この `kifText` は「原文」ではない。`kifus.source = 'video'` で区別できる。
 */
import { buildPositions, usiToJapaneseWithPiece } from 'shared';
import { parseKif } from './parser';

/** 合成 KIF の先頭に置く注記。`parseKif` は行頭が数字+空白でない行を読み飛ばす */
const HEADER_LINES = [
  '# 動画解析で復元した棋譜。KIF 原文は存在せず、USI 指し手列から合成した（prd/10 §4.2）',
  '手合割：平手',
  '手数----指手---------消費時間--',
];

/**
 * USI 指し手列を KIF テキストへ合成する。
 *
 * 対局者名・開始日時は**書かない**。動画解析では読み取れておらず（prd/10 §2.3）、
 * 「不明」などの実在しない値を入れると、それが対局者名として保存されてしまう。
 */
export function composeKif(usiMoves: string[]): string {
  // positions[i] は i 手目を指す**前**の局面（buildPositions は [初期局面, 1手目後, ...] を返す）
  const positions = buildPositions(usiMoves);
  const lines = [...HEADER_LINES];
  for (const [i, usi] of usiMoves.entries()) {
    const moveNumber = String(i + 1).padStart(4, ' ');
    lines.push(`${moveNumber} ${usiToJapaneseWithPiece(positions[i], usi)}`);
  }
  return `${lines.join('\n')}\n`;
}

export type RoundTripResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 合成した KIF を読み直し、元の USI 指し手列に戻ることを確かめる。
 *
 * 🔒 **不一致は取り込みを中止する理由になる。** ここを通らない棋譜は、合成側か解析側の
 * どちらかが壊れている——どちらであっても、そのまま保存してよい状態ではない。
 */
export function verifyRoundTrip(
  usiMoves: string[],
  kifText: string,
): RoundTripResult {
  const parsed = parseKif(kifText);
  if (parsed.errors.length > 0) {
    const [first] = parsed.errors;
    return {
      ok: false,
      reason: `合成 KIF が読み直せない（${parsed.errors.length} 行）: ${first.line} 行目 "${first.text}" — ${first.reason}`,
    };
  }
  const got = parsed.moves.map((m) => m.usi);
  const mismatch = usiMoves.findIndex((usi, i) => got[i] !== usi);
  if (mismatch >= 0) {
    return {
      ok: false,
      reason: `${mismatch + 1} 手目が往復しない: ${usiMoves[mismatch]} → ${got[mismatch] ?? '(欠落)'}`,
    };
  }
  if (got.length !== usiMoves.length) {
    return {
      ok: false,
      reason: `手数が変わった: ${usiMoves.length} → ${got.length}`,
    };
  }
  return { ok: true };
}

/**
 * 合成と検証をまとめて行う。取り込み経路はこれだけを呼ぶ。
 * @throws 往復しなかったとき
 */
export function composeKifVerified(usiMoves: string[]): string {
  const kifText = composeKif(usiMoves);
  const result = verifyRoundTrip(usiMoves, kifText);
  if (!result.ok) throw new Error(result.reason);
  return kifText;
}
