// 動画全体を粗くスキャンし、(1) 初期局面が映る時刻 (2) 盤面が動いた時刻 を洗い出す。
//
// 盤面に crop して縮小したものを 1 パスのシーケンシャルデコードで流すので、
// 時刻ごとにシークするより桁違いに安い。駒の種類はここでは見ない。
//
//   pnpm --filter kifu-vision exec tsx scan-video.ts <動画パス> [fps] [縮小率]
import { SHOGI_WARS_VERTICAL } from './src/geometry.ts';
import { streamBoardFrames } from './src/frame.ts';
import {
  occupancy,
  occupancyDistance,
  formatOccupancy,
  INITIAL_OCCUPANCY,
} from './src/occupancy.ts';

const video = process.argv[2];
const fps = Number(process.argv[3] ?? 1);
const divisor = Number(process.argv[4] ?? 4);
const geo = SHOGI_WARS_VERTICAL;

const timeOf = (index: number) => {
  const t = index / fps;
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(fps >= 2 ? 1 : 0).padStart(fps >= 2 ? 4 : 2, '0');
  return `${m}:${s}`;
};

let prev: boolean[][] | null = null;
let frames = 0;
const changes: { index: number; distance: number }[] = [];
const initials: number[] = [];
let firstOcc: { index: number; occ: boolean[][] } | null = null;

const started = Date.now();
await streamBoardFrames(video, geo, fps, divisor, (img, index) => {
  frames++;
  const occ = occupancy(img);
  if (!firstOcc) firstOcc = { index, occ };

  if (occupancyDistance(occ, INITIAL_OCCUPANCY) === 0) initials.push(index);

  if (prev) {
    const d = occupancyDistance(occ, prev);
    if (d > 0) changes.push({ index, distance: d });
  }
  prev = occ;
});

const elapsed = (Date.now() - started) / 1000;
console.log(`# ${frames} フレーム（${fps}fps / 1/${divisor} 縮小）を ${elapsed.toFixed(1)} 秒でスキャン`);

console.log(`\n# 初期局面と一致したフレーム: ${initials.length} 個`);
if (initials.length > 0) {
  // 連続する区間にまとめる（同じ局面が何秒も映るため）
  const runs: { from: number; to: number }[] = [];
  for (const i of initials) {
    const last = runs.at(-1);
    if (last && i === last.to + 1) last.to = i;
    else runs.push({ from: i, to: i });
  }
  for (const r of runs) {
    console.log(`  ${timeOf(r.from)} 〜 ${timeOf(r.to)}（${r.to - r.from + 1} フレーム）`);
  }
} else {
  console.log('  なし。最初のフレームの盤面は次の通り:');
  console.log(formatOccupancy(firstOcc!.occ).split('\n').map((l) => '    ' + l).join('\n'));
  console.log('  初期配置:');
  console.log(formatOccupancy(INITIAL_OCCUPANCY).split('\n').map((l) => '    ' + l).join('\n'));
}

console.log(`\n# 盤面が動いた回数: ${changes.length}`);
const byDistance = new Map<number, number>();
for (const c of changes) byDistance.set(c.distance, (byDistance.get(c.distance) ?? 0) + 1);
console.log('  変化したマス数の内訳（1〜2 なら 1 手、多いと複数手ぶんが合成されている）:');
for (const [d, n] of [...byDistance].sort((a, b) => a[0] - b[0])) {
  console.log(`    ${String(d).padStart(2)} マス: ${n} 回`);
}

const suspicious = changes.filter((c) => c.distance > 2);
console.log(`\n# 1 手で説明できない変化: ${suspicious.length} 回（この区間だけ細かく探索すればよい）`);
for (const c of suspicious.slice(0, 20)) {
  console.log(`  ${timeOf(c.index)}  ${c.distance} マス`);
}
if (suspicious.length > 20) console.log(`  ... 他 ${suspicious.length - 20} 回`);
