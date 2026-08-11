/**
 * 駒テンプレートの生成と照合
 *
 * 対象はアプリの描画なので、同じ駒は毎回ほぼ同じ画素で描かれる。実物の盤を
 * 撮った写真と違って CNN を持ち出すまでもなく、テンプレート照合で足りる。
 *
 * ただし盤の背景（演出）は場面によって変わる。輝度の水準やコントラストが
 * 動いても値が変わらないよう、素の差分ではなく正規化相互相関（NCC）で測る。
 *
 * テンプレートは外から用意しない。平手の初期局面が映るフレームさえ見つかれば、
 * そこに並ぶ 40 枚の正解ラベルは初期配置から自明なので、切り出すだけで
 * 生駒 8 種 × 2 向きが揃う。成駒は初期局面に無いが、追跡の途中で「成った瞬間」に
 * 手の側からラベルが確定するので、そこで足していける。
 */

import type { PieceKind, Side } from 'shared';
import { createInitialState } from 'shared';
import type { GrayImage } from './frame.ts';

export interface Template {
  kind: PieceKind;
  side: Side;
  /** 平均を取った元のマス数。多いほど背景のばらつきが均されている。 */
  samples: number;
  img: GrayImage;
}

/**
 * テンプレートの照合に使う、マス内側の割合。
 *
 * 駒の有無を見るとき（`CELL_INSET`）と同じ値で始めたが、**照合の方は
 * もっと内側に寄せた方がよい場合がある**。直前に指した手のマスには
 * オレンジのハイライトが付き、それは駒の周囲に強く出る。中心の字だけを
 * 見れば、ハイライトが乗った絵からでもテンプレートを起こせる。
 *
 * 実測（ある局面の 39 マス）で決めた。0.18 → 0.24 で**最低の一致度が 0.490 から
 * 0.662 に上がり**（ポインタに覆われたマスが読みやすくなった）、正解数と中央値は
 * 変わらなかった。0.30 まで寄せると 0.640 に下がるので、駒の形の情報が減りすぎる。
 *
 * `KIFU_VISION_MATCH_INSET` で変えられる。
 */
export const MATCH_INSET = Number(process.env.KIFU_VISION_MATCH_INSET ?? 0.24);

/**
 * 盤画像から [row][col] のマスを、テンプレートと同じ切り取り方で取り出す。
 *
 * マスの幅・高さは小数なので、両端を丸めると位置によって 1 画素ぶれる。
 * NCC は同じ寸法どうしでしか測れないため、**寸法は固定して開始位置だけ丸める**。
 * こうすると全マスが必ず同じ大きさで揃う。
 */
export function cellImage(board: GrayImage, row: number, col: number, inset = MATCH_INSET): GrayImage {
  const cw = board.width / 9;
  const ch = board.height / 9;
  const w = Math.floor(cw * (1 - inset * 2));
  const h = Math.floor(ch * (1 - inset * 2));
  const x0 = Math.round(cw * col + cw * inset);
  const y0 = Math.round(ch * row + ch * inset);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * board.width + x0;
    data.set(board.data.subarray(src, src + w), y * w);
  }
  return { width: w, height: h, data };
}

/**
 * 正規化相互相関。-1〜1 を返し、1 に近いほどよく似ている。
 *
 * 平均を引いてから大きさで割るので、明るさのずれ（オフセット）と
 * コントラストの違い（ゲイン）に影響されない。盤の背景演出が変わっても
 * 駒字の濃淡の「形」が同じなら高い値が出る。
 */
export function ncc(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`テンプレートとマスのサイズが違います: ${a.width}x${a.height} と ${b.width}x${b.height}`);
  }
  const n = a.data.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a.data[i];
    sb += b.data[i];
  }
  const ma = sa / n;
  const mb = sb / n;

  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const va = a.data[i] - ma;
    const vb = b.data[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/**
 * 平手の初期局面が映った盤画像から、生駒 8 種 × 2 向きのテンプレートを作る。
 *
 * 同じ種類のマスは平均する。盤の木目は位置ごとに違うので、平均すると
 * 背景だけが均されて駒の形が残る。
 */
export function extractTemplates(initialBoard: GrayImage): Template[] {
  const { board } = createInitialState();
  const buckets = new Map<string, { kind: PieceKind; side: Side; sum: Float64Array; n: number; w: number; h: number }>();

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const cell = cellImage(initialBoard, row, col);
      const key = `${piece.side}:${piece.kind}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          kind: piece.kind,
          side: piece.side,
          sum: new Float64Array(cell.data.length),
          n: 0,
          w: cell.width,
          h: cell.height,
        };
        buckets.set(key, bucket);
      }
      for (let i = 0; i < cell.data.length; i++) bucket.sum[i] += cell.data[i];
      bucket.n++;
    }
  }

  return [...buckets.values()].map((b) => ({
    kind: b.kind,
    side: b.side,
    samples: b.n,
    img: {
      width: b.w,
      height: b.h,
      data: Uint8Array.from(b.sum, (v) => Math.round(v / b.n)),
    },
  }));
}

export interface MatchResult {
  template: Template;
  score: number;
  /** 2 位との差。小さいほど紛らわしく、確信が持てない。 */
  margin: number;
}

/** マス画像に最もよく合うテンプレートを返す */
export function classify(cell: GrayImage, templates: Template[]): MatchResult | null {
  const scored = templates
    .filter((t) => t.img.width === cell.width && t.img.height === cell.height)
    .map((t) => ({ template: t, score: ncc(t.img, cell) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  return {
    template: scored[0].template,
    score: scored[0].score,
    margin: scored.length > 1 ? scored[0].score - scored[1].score : 1,
  };
}
