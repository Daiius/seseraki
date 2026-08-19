// 持ち駒の帯のどこに駒が並ぶかを測る（検証用）。
// 駒は木目で明るく、帯の背景は暗い演出なので、列ごとの平均輝度で境界が出るはず。
//
//   pnpm --filter kifu-vision exec tsx probe-hands.ts <動画パス> <秒>
import { SHOGI_WARS_VERTICAL, SHOGI_WARS_VERTICAL_HANDS } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';

const video = process.argv[2];
const seconds = Number(process.argv[3] ?? 1710);
const geo = SHOGI_WARS_VERTICAL;

const frame = grabFrame(video, seconds, geo.frameW, geo.frameH);

for (const [name, rect] of Object.entries(SHOGI_WARS_VERTICAL_HANDS)) {
  const band = crop(frame, rect);
  const colMean = new Float64Array(band.width);
  for (let x = 0; x < band.width; x++) {
    let s = 0;
    for (let y = 0; y < band.height; y++) s += band.data[y * band.width + x];
    colMean[x] = s / band.height;
  }

  const lo = Math.min(...colMean);
  const hi = Math.max(...colMean);
  const thr = lo + (hi - lo) * 0.55;

  console.log(`\n# ${name}（y=${rect.y}..${rect.y + rect.h}）輝度 ${lo.toFixed(0)}..${hi.toFixed(0)} 閾値 ${thr.toFixed(0)}`);

  const chars = ' .:-=+*#%@';
  let line = '';
  for (let x = 0; x < band.width; x += 12) {
    const t = Math.max(0, Math.min(1, (colMean[x] - lo) / (hi - lo)));
    line += chars[Math.round(t * (chars.length - 1))];
  }
  console.log(`  ${line}`);
  console.log(`  ${'0'.padEnd(15)}${'180'.padEnd(15)}${'360'.padEnd(15)}${'540'.padEnd(15)}${'720'.padEnd(15)}${'900'}`);

  // 明るい塊を駒の候補として拾う
  const runs: { from: number; to: number }[] = [];
  let start = -1;
  for (let x = 0; x <= band.width; x++) {
    const bright = x < band.width && colMean[x] > thr;
    if (bright && start < 0) start = x;
    if (!bright && start >= 0) {
      if (x - start >= 40) runs.push({ from: start, to: x - 1 });
      start = -1;
    }
  }
  console.log(`  幅 40 以上の明るい塊: ${runs.length} 個`);
  for (const r of runs) {
    console.log(`    x=${r.from}..${r.to}（幅 ${r.to - r.from + 1}）`);
  }
}
