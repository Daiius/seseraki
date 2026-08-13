// 「空」と判定されたマスの sd（明るさのばらつき）の分布を測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-empty-sd.ts <動画パス> <開始秒> <終了秒> [間隔秒]
//
// 🔴 動機: 駒の有無は `sd > 30` の 2 値で決めていて、**「覆われていて分からない」が
// 書けない**。戦法エフェクトに覆われたマスは平らになって sd が下がり、駒があるのに
// 「空」と読まれる（0:20.4 で 6 マス）。`uncertain.ts` が駒種に対してやったことを、
// 駒の有無に対してもやる必要がある。
//
// そのためには「本当に空のマスの sd はどこまでか」を知らないといけない。
// 帯が分かれているなら、間を未確定にできる。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { cellStats, OCCUPANCY_THRESHOLD } from './src/occupancy.ts';
import { calibrateFromFrames } from './src/calibrate.ts';

const video = process.argv[2];
const from = Number(process.argv[3] ?? 0);
const to = Number(process.argv[4] ?? 600);
const step = Number(process.argv[5] ?? 5);

const calibration = calibrateFromFrames(
  [2, 60, 600].map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;

const buckets = new Map<number, number>();
const highest: { t: number; cell: string; sd: number }[] = [];
let frames = 0;
let empties = 0;

for (let t = from; t <= to; t += step) {
  const img = crop(grabFrame(video, t, geo.frameW, geo.frameH), boardRect(geo));
  const stats = cellStats(img);
  frames++;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const sd = stats[row][col].sd;
      if (sd > OCCUPANCY_THRESHOLD) continue; // 駒ありと判定されたマスは対象外
      empties++;
      const b = Math.floor(sd / 2) * 2;
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
      if (sd >= 12) {
        highest.push({ t, cell: `${9 - col}${String.fromCharCode(97 + row)}`, sd });
      }
    }
  }
}

console.log(`# ${frames} 枚・空と判定された ${empties} マスの sd 分布（幅 2）`);
for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
  const n = buckets.get(b)!;
  const pct = (n / empties) * 100;
  console.log(`  ${String(b).padStart(2)}〜${b + 2}: ${String(n).padStart(5)}  ${pct.toFixed(2).padStart(5)}%  ${'#'.repeat(Math.ceil(pct / 2))}`);
}
console.log(`\n# sd >= 12 だったもの（${highest.length} 件・上位 30）`);
for (const h of highest.sort((a, z) => z.sd - a.sd).slice(0, 30)) {
  console.log(`  ${Math.floor(h.t / 60)}:${String(Math.floor(h.t % 60)).padStart(2, '0')} ${h.cell} sd=${h.sd.toFixed(1)}`);
}
