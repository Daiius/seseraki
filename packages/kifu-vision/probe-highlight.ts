// 直前に指した手のマスに付くオレンジのハイライトを、色から検出できるか調べる。
//
//   pnpm --filter kifu-vision exec tsx probe-highlight.ts <動画パス> <秒> [秒...]
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabColorFrame, cropRgb, type RgbImage } from './src/frame.ts';
import { CELL_INSET } from './src/occupancy.ts';

const video = process.argv[2];
const times = process.argv.slice(3).map(Number);
const geo = SHOGI_WARS_VERTICAL;

/**
 * マスの「赤み」を測る。
 *
 * 盤の木目も暖色なので明るさでは分けられない。ハイライトは赤が突出するので、
 * 赤と緑の差を見る。駒に隠れる部分を避けたいので、マスの縁寄りではなく
 * 全体の平均を取る（駒の上にもハイライトの色は乗る）。
 */
function redness(board: RgbImage, row: number, col: number): number {
  const cw = board.width / 9;
  const ch = board.height / 9;
  const x0 = Math.round(cw * col + cw * CELL_INSET);
  const y0 = Math.round(ch * row + ch * CELL_INSET);
  const x1 = Math.round(cw * (col + 1) - cw * CELL_INSET);
  const y1 = Math.round(ch * (row + 1) - ch * CELL_INSET);

  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * board.width + x) * 3;
      sum += board.data[i] - board.data[i + 1]; // R - G
      n++;
    }
  }
  return sum / n;
}

/** マスの平均 RGB */
function meanRgb(board: RgbImage, row: number, col: number): [number, number, number] {
  const cw = board.width / 9;
  const ch = board.height / 9;
  const x0 = Math.round(cw * col + cw * CELL_INSET);
  const y0 = Math.round(ch * row + ch * CELL_INSET);
  const x1 = Math.round(cw * (col + 1) - cw * CELL_INSET);
  const y1 = Math.round(ch * (row + 1) - ch * CELL_INSET);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * board.width + x) * 3;
      r += board.data[i]; g += board.data[i + 1]; b += board.data[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

const boards = times.map((t) => cropRgb(grabColorFrame(video, t, geo.frameW, geo.frameH), boardRect(geo)));

// 盤の背景は位置ごとに色が違う（上ほど赤い）ので、絶対値では測れない。
// 同じマスを時刻どうしで比べれば、動かない背景は打ち消える。
if (boards.length >= 2) {
  console.log('# 時刻間の色の変化（背景は静的なので消え、ハイライトの移動が残るはず）');
  for (let k = 1; k < boards.length; k++) {
    console.log(`\n## t=${times[k - 1]} → t=${times[k]}  各マスの色差（ユークリッド距離）`);
    const diffs: number[][] = [];
    for (let row = 0; row < 9; row++) {
      diffs.push([]);
      for (let col = 0; col < 9; col++) {
        const a = meanRgb(boards[k - 1], row, col);
        const b = meanRgb(boards[k], row, col);
        diffs[row].push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    console.log('      ' + Array.from({ length: 9 }, (_, c) => String(9 - c).padStart(6)).join(''));
    for (let row = 0; row < 9; row++) {
      console.log(`  ${String.fromCharCode(97 + row)} |` + diffs[row].map((v) => v.toFixed(0).padStart(6)).join(''));
    }
    const flat = diffs.flat().slice().sort((a, b) => b - a);
    console.log(`  大きい順: ${flat.slice(0, 6).map((v) => v.toFixed(0)).join(', ')}`);
  }
}

for (const t of times) {
  const board = cropRgb(grabColorFrame(video, t, geo.frameW, geo.frameH), boardRect(geo));
  const values: number[][] = [];
  for (let row = 0; row < 9; row++) {
    values.push([]);
    for (let col = 0; col < 9; col++) values[row].push(redness(board, row, col));
  }

  const flat = values.flat().slice().sort((a, b) => a - b);
  const median = flat[Math.floor(flat.length / 2)];
  console.log(`\n# t=${t} 秒  赤み(R-G) 最小 ${flat[0].toFixed(1)} / 中央 ${median.toFixed(1)} / 最大 ${flat.at(-1)!.toFixed(1)}`);
  console.log('      ' + Array.from({ length: 9 }, (_, c) => String(9 - c).padStart(6)).join(''));
  for (let row = 0; row < 9; row++) {
    console.log(`  ${String.fromCharCode(97 + row)} |` + values[row].map((v) => v.toFixed(0).padStart(6)).join(''));
  }

  // 中央値から大きく外れたマスを挙げる
  const outliers: { usi: string; v: number }[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (values[row][col] - median > 8) {
        outliers.push({ usi: `${9 - col}${String.fromCharCode(97 + row)}`, v: values[row][col] });
      }
    }
  }
  outliers.sort((a, b) => b.v - a.v);
  console.log(`  中央値より 8 以上赤いマス: ${outliers.map((o) => `${o.usi}(${o.v.toFixed(0)})`).join(', ') || 'なし'}`);
}
