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
import { cellImage, classify, classifyAt, MATCH_DY, MATCH_INSET, type MatchResult, type Template } from './template.ts';
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

/**
 * 「駒あり」の門を通ったマスを盤に置いてよいのは、
 * **「よく似ている」か「他と紛れていない」かのどちらかを満たすとき。**
 *
 * 🔴 実測（2 本目 16:37 の 4e・追記 130）: マウスポインタが**マスの隅に半分だけ**
 * 掛かった空マスが `sd=32.6` で「駒あり」の門を通り、**▽角 0.467 対 ▽銀 0.454**
 * ——差 0.013 で盤に置かれた。差分は「空 → 駒」なのでちょうど打ちの形になり、
 * 後手は本当に角を持っていたので `canPlay` も通り、偽の `B*4e` が棋譜に入った。
 * そこから 13 手が総崩れになり、断片が切れた。
 *
 * ⚠ `hasPointer` は「マスの 4% 超が輝度 235 超」で見るので、**隅に掛かった
 * ポインタは通り抜ける**。🔒 だが**割合も `sd` の閾値も動かさない**——
 * 代用が外れたら閾値ではなく「本当は何を判定したいのか」に戻る（README §）。
 * 判定したいのは「駒があるか」ではなく **「どの駒か決まっているか」**。
 *
 * ##### 🔴 差だけを見る門は、本物の駒も一緒に落とした（追記 132）
 *
 * | | 2 本目 16:37 の 4e（偽） | 1 本目 16:32 の 8f（本物の金） |
 * |---|---|---|
 * | 中身 | ポインタが掛かった**空マス** | **本物の金**（全と 0.70〜0.81 相関） |
 * | 照合 1 位の NCC | **0.467** | **0.815** |
 * | 1 位と 2 位の差 | 0.013 | 0.028 |
 *
 * **差では並ぶ。NCC では倍近く開く。** 差だけで切ったら 1 本目が 92 → 75 手に
 * 退行した（落ちたのは Phase B が拾えるようにした `G*8f` そのもの）。
 * 🔒 **分布が 2 山に割れることは、割れ目が「正しい / 間違い」の境目である
 * ことを意味しない。何が入っているかを見る。**
 *
 * ##### だから 2 つを一緒に見る（`probe-piece-margin.ts` の 2 次元の表）
 *
 * 2 本とも全編 2 秒刻み・盤に置かれたマス 29350 / 34944。**NCC < 0.6 の隅**:
 *
 * | 1 位と 2 位の差 | 1 本目 | 2 本目 | 2 本目の中身 |
 * |---|---|---|---|
 * | < 0.05 | **0** | 11 | 単発の読み（4c 香 / 4d 桂 / 6e 玉 …）。**問題の 4e もここ** |
 * | 0.05〜0.10 | **0** | 430 | **7g に居座る本物の ▲角**（NCC 0.505 で読み続ける） |
 * | 0.10〜0.15 | 3 | 5 | |
 *
 * ⭐ **谷がはっきり分かれている。** 下は「1 枚だけ現れて消える読み」＝演出や
 * ポインタの指紋、上は「何分も同じマスに出続ける読み」＝本物の駒。
 * ⭐⭐ **1 本目はこの隅が空なので、この門では 1 本目の結果が 1 ビットも変わらない。**
 *
 * ⚠ **NCC が低いこと自体は「駒でない」を意味しない**（7g の角がまさにそれ）。
 * だから NCC 単独の門にはせず、**両方を満たさないときだけ**未確定にする。
 */
export const PIECE_MARGIN_THRESHOLD = Number(process.env.KIFU_VISION_PIECE_MARGIN ?? 0.05);

/**
 * これ以上よく似ていれば、2 位と並んでいても盤に置く。
 *
 * 金⇔全のように**字が似ている組は原理的に差が付かない**（0.70〜0.81 相関）。
 * そこで差を求めると本物の駒が落ちる。**似ている相手がいるだけで、
 * 「そこに駒がある」ことは疑っていない。**
 */
export const PIECE_STRONG_NCC = Number(process.env.KIFU_VISION_PIECE_STRONG_NCC ?? 0.6);

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
  /** 盤に置くのに要る照合 1 位と 2 位の差。下回れば「駒はあるが何か分からない」。 */
  pieceMargin?: number;
  /** これ以上よく似ていれば、2 位と並んでいても盤に置く。 */
  pieceStrongNcc?: number;
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
  board: GrayImage,
  templates: Template[],
  colorBoard: YuvImage | undefined,
  row: number,
  col: number,
): MatchResult | null {
  const match = classifyAt(board, row, col, templates);
  if (!match || !colorBoard || !isPromotedKind(match.template.kind)) return match;

  const cw = colorBoard.width / 9;
  const ch = colorBoard.height / 9;
  const w = Math.floor(cw * (1 - MATCH_INSET * 2));
  const h = Math.floor(ch * (1 - MATCH_INSET * 2));
  const x = Math.round(cw * col + cw * MATCH_INSET);
  // ⚠ 色を見る窓も、字と同じだけずらす（字の赤さを測るのだから字の上に置く）。
  const dy = match.template.side === 'sente' ? MATCH_DY : -MATCH_DY;
  const y = Math.min(
    colorBoard.height - h,
    Math.max(0, Math.round(ch * row + ch * MATCH_INSET + ch * dy)),
  );
  const { ratio } = inkRedness(cropYuv(colorBoard, { x, y, w, h }));

  // 測れなかったときは口を出さない（木地が写っていない絵など）。
  if (!Number.isFinite(ratio) || ratio >= PROMOTED_MIN_REDNESS) return match;

  const plainOnly = templates.filter((t) => !isPromotedKind(t.kind));
  return classifyAt(board, row, col, plainOnly) ?? match;
}

export function recognizeBoard(
  board: GrayImage,
  templates: Template[],
  options: RecognizeOptions = {},
): RecognizedBoard {
  const occThreshold = options.occupancyThreshold ?? OCCUPANCY_THRESHOLD;
  const unknownThreshold = options.unknownThreshold ?? UNKNOWN_NCC_THRESHOLD;
  const emptyMaxSd = options.emptyMaxSd ?? EMPTY_MAX_SD;
  const pieceMargin = options.pieceMargin ?? PIECE_MARGIN_THRESHOLD;
  const strongNcc = options.pieceStrongNcc ?? PIECE_STRONG_NCC;

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
        const match = classifyWithInk(board, templates, options.colorBoard, row, col);
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
      const match = classifyWithInk(board, templates, options.colorBoard, row, col);
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
      //
      // 🔴 **1 位の高さだけでは足りない。** 弱く似ていて、しかも 2 位と並んで
      // いるなら、それは「そこに何かがある」以上のことを何も言っていない。
      // ポインタが隅に掛かった空マスがここをすり抜けて偽の打ちになっていた。
      // ⚠ **どちらか一方で足りる。** よく似ていれば紛れていてもよい（金⇔全）し、
      // 紛れていなければ弱くてもよい（テンプレートの甘い角）。
      const decided = match.score >= strongNcc || match.margin >= pieceMargin;
      const confident = match.score >= unknownThreshold && decided && !pointer;
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
