// パス1（streamBoardFrames の fps フィルタ）とパス2（grabFrame の -ss シーク）が
// 同じ時刻で同じフレームを指しているかを確かめる（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-sync.ts <動画パス>
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, streamBoardFrames } from './src/frame.ts';
import { occupancy, occupancyDistance, formatOccupancy } from './src/occupancy.ts';

const video = process.argv[2];
const geo = SHOGI_WARS_VERTICAL;
const CHECK = [125, 126, 127, 180, 181, 300, 301];

// パス1: ストリームから該当 index の occupancy を拾う（縮小なしで比較する）
const fromStream = new Map<number, boolean[][]>();
await streamBoardFrames(video, geo, 1, 1, (img, index) => {
  if (CHECK.includes(index)) fromStream.set(index, occupancy(img));
});

console.log('# ストリーム（fps フィルタ）と単発シーク（-ss）の食い違い');
console.log('# 0 なら同じフレームを見ている');
for (const t of CHECK) {
  const a = fromStream.get(t);
  if (!a) {
    console.log(`  t=${t}: ストリーム側に無い`);
    continue;
  }
  const b = occupancy(crop(grabFrame(video, t, geo.frameW, geo.frameH), boardRect(geo)));
  const d = occupancyDistance(a, b);
  console.log(`  t=${t}: 食い違い ${d} マス`);
  if (d > 0) {
    console.log('    ストリーム:            単発シーク:');
    const la = formatOccupancy(a).split('\n');
    const lb = formatOccupancy(b).split('\n');
    for (let i = 0; i < 9; i++) console.log(`      ${la[i]}        ${lb[i]}`);
  }
}

// 縮小が occupancy に影響するかも見る
console.log('\n# 縮小の影響（同じストリームを 1/1 と 1/4 で流して比べる）');
const small = new Map<number, boolean[][]>();
await streamBoardFrames(video, geo, 1, 4, (img, index) => {
  if (CHECK.includes(index)) small.set(index, occupancy(img));
});
for (const t of CHECK) {
  const a = fromStream.get(t);
  const b = small.get(t);
  if (!a || !b) continue;
  console.log(`  t=${t}: 等倍と 1/4 の食い違い ${occupancyDistance(a, b)} マス`);
}
