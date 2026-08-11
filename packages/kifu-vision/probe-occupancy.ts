// 各マスの輝度統計を出して「駒の有無」を分離できる指標を探す（検証用）。
// 空マスは木目のグラデーションだけなのでのっぺりし、駒があるマスは
// 黒い駒字と明るい駒面が同居するので散らばるはず。
//
//   pnpm --filter kifu-vision exec tsx probe-occupancy.ts <動画パス> [秒]
import { SHOGI_WARS_VERTICAL, cellRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';

const video = process.argv[2];
const seconds = Number(process.argv[3] ?? 180);
const geo = SHOGI_WARS_VERTICAL;

const img = grabFrame(video, seconds, geo.frameW, geo.frameH);

interface CellStat {
  mean: number;
  sd: number;
  dark: number;
}

const stats: CellStat[][] = [];
for (let row = 0; row < 9; row++) {
  stats.push([]);
  for (let col = 0; col < 9; col++) {
    // 格子線と隣のマスのはみ出しを避けて内側を見る
    const cell = crop(img, cellRect(geo, row, col, 0.18));
    let sum = 0;
    for (const v of cell.data) sum += v;
    const mean = sum / cell.data.length;
    let varSum = 0;
    let dark = 0;
    for (const v of cell.data) {
      varSum += (v - mean) ** 2;
      if (v < mean * 0.55) dark++;
    }
    stats[row].push({
      mean,
      sd: Math.sqrt(varSum / cell.data.length),
      dark: dark / cell.data.length,
    });
  }
}

const grid = (label: string, pick: (s: CellStat) => number, digits = 0) => {
  console.log(`\n# ${label}`);
  console.log('     ' + Array.from({ length: 9 }, (_, c) => String(9 - c).padStart(6)).join(''));
  for (let row = 0; row < 9; row++) {
    const cells = stats[row].map((s) => pick(s).toFixed(digits).padStart(6)).join('');
    console.log(`${String.fromCharCode(97 + row)} |${cells}`);
  }
};

grid('平均輝度', (s) => s.mean);
grid('標準偏差（駒ありなら大きいはず）', (s) => s.sd);
grid('暗画素の割合 %（駒字）', (s) => s.dark * 100);

// 標準偏差の分布を見て、2 山に分かれるかを確認する
const sds = stats.flat().map((s) => s.sd).sort((a, b) => a - b);
console.log('\n# 標準偏差を小さい順に並べたもの（2 山に割れていれば閾値が引ける）');
console.log(sds.map((v) => v.toFixed(0)).join(' '));
let maxGap = 0;
let gapAt = 0;
for (let i = 1; i < sds.length; i++) {
  if (sds[i] - sds[i - 1] > maxGap) {
    maxGap = sds[i] - sds[i - 1];
    gapAt = i;
  }
}
console.log(`最大の隙間: ${sds[gapAt - 1].toFixed(1)} と ${sds[gapAt].toFixed(1)} の間（幅 ${maxGap.toFixed(1)}）`);
console.log(`→ 空マス ${gapAt} 個 / 駒あり ${81 - gapAt} 個 と読める`);
