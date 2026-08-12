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

/**
 * 画像を別の寸法へ引き伸ばす（双一次補間）。
 *
 * NCC は**同じ寸法どうしでしか測れない**ので、切り出した寸法が違うテンプレートは
 * そのままでは使えない。これまでは寸法が合わなければ丸ごと捨てていたが、
 * それでは
 *
 *   - 外から受け取った盤面の絵（解析画面のスクショなど）からテンプレートを起こす
 *   - 解像度の違う動画に、一度作ったテンプレートを使い回す
 *
 * のどちらもできない。**駒の絵は拡大縮小しても字の形は保たれる**ので、
 * 補間して寸法を合わせれば照合できる。
 *
 * ⚠ 情報が増えるわけではない。小さい絵を引き伸ばすとぼやけるぶん、
 * 同寸法どうしの照合より値は下がりうる。**下がっても正解が 1 位なら足りる。**
 *
 * 画素の中心どうしを対応させる（`+0.5` のずらし）。端を端に合わせると
 * 半画素ずれて、小さい絵ほど効いてくる。
 */
export function resample(img: GrayImage, width: number, height: number): GrayImage {
  if (img.width === width && img.height === height) return img;
  const data = new Uint8Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = img.data[y0 * img.width + x0];
      const b = img.data[y0 * img.width + x1];
      const c = img.data[y1 * img.width + x0];
      const d = img.data[y1 * img.width + x1];
      const top = a + (b - a) * wx;
      const bottom = c + (d - c) * wx;
      data[y * width + x] = Math.round(top + (bottom - top) * wy);
    }
  }
  return { width, height, data };
}

/**
 * 180 度回す。
 *
 * ⭐ **後手の駒は先手の駒を 180 度回したもの**（実測: 生駒 8 種で NCC 0.97〜0.99）。
 * ただし**数画素ずれる**（動画では中央値 (6, -4)）。駒の絵が正方形でないうえ、
 * アプリが駒を描く位置がマスの中心とは限らないため。
 *
 * これで**片側 6 種を集めれば 12 種そろう**。採取の費用が半分になるだけでなく、
 * **ラベルの裏取りにも使える**——`▲X` を回して `▽X` と 0.9 以上出なければ、
 * どちらかのラベルが違う。実際に `▲杏` の誤りはこれで見つかった。
 */
export function rotate180(img: GrayImage): GrayImage {
  const n = img.data.length;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = img.data[n - 1 - i];
  return { width: img.width, height: img.height, data };
}

/**
 * 平行移動する。はみ出した所は端の画素で埋める。
 *
 * 回転した相手と重ねるときの**ずれの補正**に使う。ずれたまま NCC を測ると
 * 本物どうしでも値が落ちるので、ラベルの裏取りに使えなくなる。
 *
 * ⭐ **小数のずれを受け付ける**（線形補間）。整数に丸めてはいけない場面がある:
 * 動画のマス（61x66）で測ったずれを、別の寸法の絵（48x53）へ持ち込むときは
 * 比率を掛けるので必ず小数になる。丸めると最大 0.5 画素の誤差が乗り、
 * それだけで似た字どうし（金と全）の判別が怪しくなる。
 */
export function shiftImage(img: GrayImage, dx: number, dy: number): GrayImage {
  if (Number.isInteger(dx) && Number.isInteger(dy)) {
    const data = new Uint8Array(img.data.length);
    for (let y = 0; y < img.height; y++) {
      const sy = Math.min(img.height - 1, Math.max(0, y - dy));
      for (let x = 0; x < img.width; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, x - dx));
        data[y * img.width + x] = img.data[sy * img.width + sx];
      }
    }
    return { width: img.width, height: img.height, data };
  }

  const data = new Uint8Array(img.data.length);
  const clampX = (v: number) => Math.min(img.width - 1, Math.max(0, v));
  const clampY = (v: number) => Math.min(img.height - 1, Math.max(0, v));
  for (let y = 0; y < img.height; y++) {
    const fy = y - dy;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    for (let x = 0; x < img.width; x++) {
      const fx = x - dx;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const a = img.data[clampY(y0) * img.width + clampX(x0)];
      const b = img.data[clampY(y0) * img.width + clampX(x0 + 1)];
      const c = img.data[clampY(y0 + 1) * img.width + clampX(x0)];
      const d = img.data[clampY(y0 + 1) * img.width + clampX(x0 + 1)];
      const top = a + (b - a) * wx;
      const bottom = c + (d - c) * wx;
      data[y * img.width + x] = Math.round(top + (bottom - top) * wy);
    }
  }
  return { width: img.width, height: img.height, data };
}

/**
 * ±`range` 画素ずらして、いちばん合う位置での NCC を返す。
 *
 * 位置ずれは**いちばん読みにくい絵ほど強く効く**。実測では切り出しを ±3 画素
 * 探し直すだけで、下位 5% の一致度が 0.679 → 0.972 まで上がった。
 * 照合のたびに使うには高く付く（±3 で 49 倍）ので、**格子の測り直しや
 * ラベルの裏取りなど、1 度きりの場面で使う**。
 */
export function bestShiftNcc(
  a: GrayImage,
  b: GrayImage,
  range = 5,
): { score: number; dx: number; dy: number } {
  let best = { score: -Infinity, dx: 0, dy: 0 };
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const score = ncc(a, shiftImage(b, dx, dy));
      if (score > best.score) best = { score, dx, dy };
    }
  }
  return best;
}

/**
 * `bestShiftNcc` を整数で当ててから、その周りを小数で詰める。
 *
 * ずれは本来 1 画素より細かい。**整数のままだと、寸法の違う絵どうしを
 * 突き合わせるときに比率の掛け算で誤差が積もる**。1 度きりの採取や
 * 裏取りでしか使わないので、多少高く付いても細かく測る方がよい。
 */
export function bestSubpixelShiftNcc(
  a: GrayImage,
  b: GrayImage,
  range = 5,
  step = 0.1,
): { score: number; dx: number; dy: number } {
  const coarse = bestShiftNcc(a, b, range);
  let best = coarse;
  for (let dy = coarse.dy - 1; dy <= coarse.dy + 1 + 1e-9; dy += step) {
    for (let dx = coarse.dx - 1; dx <= coarse.dx + 1 + 1e-9; dx += step) {
      const score = ncc(a, shiftImage(b, dx, dy));
      if (score > best.score) best = { score, dx, dy };
    }
  }
  return best;
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
