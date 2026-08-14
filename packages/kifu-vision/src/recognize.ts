/**
 * 盤面画像 → 駒の配置
 *
 * マスごとに「駒があるか」を輝度の散らばりで判定し、あるものだけ
 * テンプレート照合にかける。持ち駒はここでは読まない（画面の持ち駒欄は
 * 対局者情報やボタンに隠れることがあるうえ、初期局面から手を追っていけば
 * 持ち駒は自然に確定するため）。
 */

import type { Square } from 'shared';
import type { GrayImage, YuvImage } from './frame.ts';
import { cropYuv } from './frame.ts';
import { presence, OCCUPANCY_THRESHOLD, EMPTY_MAX_SD, hasPointer } from './occupancy.ts';
import { cellImage, classify, MATCH_INSET, type MatchResult, type Template } from './template.ts';
import { inkRedness, isPromotedKind } from './ink.ts';
import { UNKNOWN, isUnknown, markUnknown, resolveWith, type VisionSquare } from './uncertain.ts';

/**
 * 成駒と認めるのに要る「字の赤さ」（`ink.ts` の比）。
 *
 * ⭐ **成駒は朱、生駒は黒で書かれている。** 照合はグレースケールなので、
 * `金` と `全` のように字が似ている組は形では割り切れない（0.70〜0.81 相関）。
 * 色は**照合とは独立した証拠**になる。
 *
 * 閾値は測って決めた（`probe-ink-color.ts`・1 局目 10:00〜19:00 を 4 秒刻み・4130 マス）。
 * **効くのは「成駒と読めた 136 マス」の中の分かれ方**で、そこが 2 つに割れる:
 *
 * | 赤み | 成駒と読めたマス | 中身 |
 * |---|---|---|
 * | 0.41〜0.50 | 11 | **誤読**（生駒を成駒と読んだ） |
 * | 0.50〜1.03 | **0** | ← 谷 |
 * | 1.03〜1.33 | 125 | 本物の成駒 |
 *
 * 谷の真ん中を取って 0.76。**間が 2 倍以上空いているので、少々ずれても動かない。**
 * 参考: 生駒と読めたマスは中央 0.467・最大 0.816 で、こちらとも重ならない。
 */
export const PROMOTED_MIN_REDNESS = Number(process.env.KIFU_VISION_PROMOTED_REDNESS ?? 0.76);

/**
 * これを下回る NCC は「テンプレートに無い駒」を疑う。
 *
 * 実測では正しく読めたマスが 0.49〜0.999（中央値 0.986）で、0.49 は
 * マウスポインタに覆われたマスだった。テンプレートが存在しない駒
 * （成駒など）は 0.1〜0.4 に落ちるので、その間に線を引く。
 */
export const UNKNOWN_NCC_THRESHOLD = 0.45;

/**
 * 覆われて「駒があるか」が決まらなかったマスでも、**照合がここまで決定的なら**
 * 駒として認める。
 *
 * 🔴 実測（20:57 の 3e・打たれた歩が白く光っている）: `sd=18.8` で門に落ちるのに、
 * 照合は ▽歩 0.829 に対して 2 位 0.330。**駒種は決まっているのに、その手前で
 * 捨てていた。** 打った駒がその場で取られる形では、これが唯一の痕跡になる
 * （盤の差分には何も残らない）。
 *
 * ⚠ **`sd` の閾値は動かさない。** 「代用は代用でしかない。代用が外れたら閾値を
 * 動かさない」に反する。**別の証拠（照合の 1 位と 2 位の差）で門を通す。**
 *
 * 閾値は測って決めた（`probe-unclear.ts`・全編 3549 枚・覆われたマス 3288 個）:
 *
 * | 照合 1 位の NCC | 個数 |
 * |---|---|
 * | 0.40〜0.50 | **2622**（決まっていない山） |
 * | 0.50〜0.70 | 19（**谷**） |
 * | 0.70〜1.00 | **99**（決まっている山） |
 *
 * 両方を満たすのは 3288 個中 89 個（2.7%）で、中身は戦法エフェクトに覆われた
 * 本物の駒ばかりだった。**谷に線を引いている。**
 */
export const COVERED_NCC_THRESHOLD = 0.7;
export const COVERED_MARGIN_THRESHOLD = 0.25;

export interface RecognizedCell {
  piece: Square;
  /** 駒があると判定されたマスのみ。空マスは NaN */
  score: number;
  margin: number;
}

export interface LowConfidenceCell {
  row: number;
  col: number;
  score: number;
  margin: number;
  /** 一応の第一候補（未知の駒なら当てにならない） */
  guess: Square;
  /** マウスポインタが乗っていたか。乗っていれば読めなくて当然。 */
  pointer?: boolean;
  /** 駒があるかどうかすら決まらなかったか（演出に覆われて平らになった等） */
  covered?: boolean;
}

export interface RecognizedBoard {
  /**
   * 読めた駒 / 空 / 未確定 の 3 値。
   *
   * ⚠ **確信が持てないマスに当てずっぽうの駒を置かない。** 置くと盤上の枚数制限を
   * 壊し、`checkBoard` が 81 マスぶんの情報をまとめて捨てる。判断は
   * `resolveWith`（引き継ぐ）か `solveUnknowns`（手から逆算）へ先送りする。
   */
  board: VisionSquare[][];
  cells: RecognizedCell[][];
  /** NCC が低く、テンプレートに無い駒の可能性があるマス */
  lowConfidence: LowConfidenceCell[];
  /** 未確定のマスに入れた第一候補。成りの検出など、当てずっぽうでも要るとき用。 */
  guesses: Square[][];
}

export interface RecognizeOptions {
  occupancyThreshold?: number;
  unknownThreshold?: number;
  /** これ以下の sd なら「空」と断定する。間の帯は未確定になる。 */
  emptyMaxSd?: number;
  /**
   * 盤に切り出した**色付き**の絵。渡すと、成駒と読めたマスの字が朱かを確かめ、
   * 朱でなければ生駒に限って読み直す。渡さなければ今までどおり形だけで読む。
   */
  colorBoard?: YuvImage;
}

/**
 * 成駒と読めたマスを、**字の色**で検算する。
 *
 * 朱で書かれていなければ成駒ではないので、**生駒に限って読み直す**。
 * 🔒 これは「規則があり得ないと言う答えを取り除いてから読む」（`droppable.ts`）と
 * 同じ形。今回あり得ないと言っているのは規則ではなく**色という別の証拠**。
 */
function classifyWithInk(
  cut: GrayImage,
  templates: Template[],
  colorBoard: YuvImage | undefined,
  row: number,
  col: number,
): MatchResult | null {
  const match = classify(cut, templates);
  if (!match || !colorBoard || !isPromotedKind(match.template.kind)) return match;

  const cw = colorBoard.width / 9;
  const ch = colorBoard.height / 9;
  const w = Math.floor(cw * (1 - MATCH_INSET * 2));
  const h = Math.floor(ch * (1 - MATCH_INSET * 2));
  const x = Math.round(cw * col + cw * MATCH_INSET);
  const y = Math.round(ch * row + ch * MATCH_INSET);
  const { ratio } = inkRedness(cropYuv(colorBoard, { x, y, w, h }));

  // 測れなかったときは口を出さない（木地が写っていない絵など）。
  if (!Number.isFinite(ratio) || ratio >= PROMOTED_MIN_REDNESS) return match;

  const plainOnly = templates.filter((t) => !isPromotedKind(t.kind));
  return classify(cut, plainOnly) ?? match;
}

export function recognizeBoard(
  board: GrayImage,
  templates: Template[],
  options: RecognizeOptions = {},
): RecognizedBoard {
  const occThreshold = options.occupancyThreshold ?? OCCUPANCY_THRESHOLD;
  const unknownThreshold = options.unknownThreshold ?? UNKNOWN_NCC_THRESHOLD;
  const emptyMaxSd = options.emptyMaxSd ?? EMPTY_MAX_SD;

  const pres = presence(board, emptyMaxSd, occThreshold);
  const squares: VisionSquare[][] = [];
  const guesses: Square[][] = [];
  const cells: RecognizedCell[][] = [];
  const lowConfidence: LowConfidenceCell[] = [];

  for (let row = 0; row < 9; row++) {
    squares.push([]);
    guesses.push([]);
    cells.push([]);
    for (let col = 0; col < 9; col++) {
      const cut = cellImage(board, row, col);

      // マウスポインタが乗っているマスは、そこに何があっても正しく読めない。
      // 空マスなら「駒あり」と誤判定され、駒があれば別の駒に化ける。
      // 読めなかったものとして扱い、判断を後の場面へ先送りする。
      const pointer = hasPointer(cut);
      const p = pres[row][col];

      if (p === 'empty' && !pointer) {
        squares[row].push(null);
        guesses[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      // 「空と断定できない」形が 2 つある。ポインタが乗っている（その下に駒が
      // 隠れているかもしれない）と、覆われて平らになった（演出の下に駒があるかも
      // しれない）。どちらも未確定にするが、**その前に照合を見る。**
      //
      // ⭐⭐ 以前は「覆われた絵から起こした第一候補は当てにならない」として
      // 照合を一切かけなかった。測ったら**2.7% は決まっていた**
      // （`COVERED_NCC_THRESHOLD` の表）。決まっている分まで捨てると、
      // **打った駒がその場で取られる形が丸ごと消える**（盤の差分には残らないので、
      // ここが唯一の痕跡になる）。決定的でなければ今までどおり未確定。
      //
      // 🔴 **ポインタの判定も外せない。** `hasPointer` は白い画素で判定するが、
      // **打ちの演出も白い**ので、打たれた駒はポインタと見分けが付かない
      // （実測 20:57 の 3e: `pointer=true` なのに ▽歩 0.829・差 0.499）。
      // ポインタは「読めなくて当然」という**推定**にすぎない。
      // **決定的な証拠が出たら推定の方を譲る。**
      if (p === 'unclear' || (p === 'empty' && pointer)) {
        const match = classifyWithInk(cut, templates, options.colorBoard, row, col);
        const decisive =
          match !== null &&
          match.score >= COVERED_NCC_THRESHOLD &&
          match.margin >= COVERED_MARGIN_THRESHOLD;
        const coveredPiece: Square = decisive
          ? { kind: match!.template.kind, side: match!.template.side }
          : null;
        squares[row].push(decisive ? coveredPiece : UNKNOWN);
        guesses[row].push(coveredPiece);
        cells[row].push({
          piece: coveredPiece,
          score: match?.score ?? NaN,
          margin: match?.margin ?? NaN,
        });
        if (!decisive) {
          lowConfidence.push({
            row, col,
            score: match?.score ?? NaN,
            margin: match?.margin ?? NaN,
            guess: coveredPiece,
            pointer: pointer || undefined,
            covered: p === 'unclear' || undefined,
          });
        }
        continue;
      }
      const match = classifyWithInk(cut, templates, options.colorBoard, row, col);
      if (!match) {
        squares[row].push(null);
        guesses[row].push(null);
        cells[row].push({ piece: null, score: NaN, margin: NaN });
        continue;
      }
      const piece: Square = { kind: match.template.kind, side: match.template.side };
      guesses[row].push(piece);
      cells[row].push({ piece, score: match.score, margin: match.margin });

      // ⚠ 一致度が閾値を下回るなら、**第一候補であっても盤に置かない**。
      // 実測では 0.208 の当てずっぽうが 1 位を取ることがあり、それを置くと
      // 駒数が上限を超えて盤面ごと捨てられる。
      const confident = match.score >= unknownThreshold && !pointer;
      squares[row].push(confident ? piece : UNKNOWN);
      if (!confident) {
        lowConfidence.push({ row, col, score: match.score, margin: match.margin, guess: piece, pointer });
      }
    }
  }

  return { board: squares, cells, lowConfidence, guesses };
}

/**
 * 未確定のマスを、直前の配置で埋める。
 *
 * `extra` には、照合の外から疑わしいと分かったマスを渡す（駒数が規定を
 * 超えている、など）。渡したマスも未確定として扱われる。
 *
 * 中身は `markUnknown` + `resolveWith`。判断の先送りと解決を 1 か所にまとめた
 * 呼び名として残してある。
 */
export function carryUnknowns(
  board: VisionSquare[][],
  extra: { row: number; col: number }[],
  previous: Square[][],
): Square[][] {
  return resolveWith(markUnknown(board, extra), previous);
}

function same(a: VisionSquare, b: VisionSquare): boolean {
  if (isUnknown(a) || isUnknown(b)) return isUnknown(a) && isUnknown(b);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.side === b.side;
}

/** 2 つの配置が同じか。未確定どうしは同じ、未確定と駒は違うものとして扱う。 */
export function boardsEqual(a: VisionSquare[][], b: VisionSquare[][]): boolean {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (!same(a[row][col], b[row][col])) return false;
    }
  }
  return true;
}

/** 食い違うマスを列挙する（デバッグ用） */
export function boardDiff(
  a: VisionSquare[][],
  b: VisionSquare[][],
): { row: number; col: number; before: VisionSquare; after: VisionSquare }[] {
  const out: { row: number; col: number; before: VisionSquare; after: VisionSquare }[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (!same(a[row][col], b[row][col])) {
        out.push({ row, col, before: a[row][col], after: b[row][col] });
      }
    }
  }
  return out;
}
