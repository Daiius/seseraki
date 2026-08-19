// マウスポインタを輝度で見分けるための閾値を実測する。
//
// `hasPointer` の既定値（明るさ 235 超が面積の 4% 以上）は当て推量で置いたもので、
// 実測に基づいていない。実際 639 件の駒数超過が残っており、取りこぼしがある。
//
// ここでは全マスについて「明るい画素の割合」を求め、分布を見る。ポインタが乗った
// マスは全体のごく一部のはずなので、分布の裾に固まって現れるなら閾値が引ける。
//
//   pnpm --filter kifu-vision exec tsx probe-pointer.ts <動画パス> [開始秒] [終了秒] [間隔秒]
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { cellImage } from './src/template.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 60);
const toSec = Number(process.argv[4] ?? 660);
const stepSec = Number(process.argv[5] ?? 10);
const geo = SHOGI_WARS_VERTICAL;

const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

/** いくつかの明るさで、そこを超える画素がマスの何割あるかを測る */
const LEVELS = [200, 215, 225, 235, 245];

interface Row {
  at: number;
  usi: string;
  ratios: number[];
  max: number;
}
const rows: Row[] = [];

for (let t = fromSec; t <= toSec; t += stepSec) {
  const board = grabBoard(t);
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const cell = cellImage(board, row, col);
      const counts = new Array(LEVELS.length).fill(0);
      let max = 0;
      for (const v of cell.data) {
        if (v > max) max = v;
        for (const [i, lv] of LEVELS.entries()) if (v > lv) counts[i]++;
      }
      rows.push({
        at: t,
        usi: `${9 - col}${String.fromCharCode(97 + row)}`,
        ratios: counts.map((c) => c / cell.data.length),
        max,
      });
    }
  }
}

console.log(`# ${rows.length} マス（${fromSec}〜${toSec} 秒を ${stepSec} 秒間隔）`);

// 各明るさについて、割合の分布を見る
for (const [i, lv] of LEVELS.entries()) {
  const vals = rows.map((r) => r.ratios[i]).sort((a, b) => b - a);
  const over = (x: number) => vals.filter((v) => v > x).length;
  console.log(
    `\n# ${lv} より明るい画素の割合  最大 ${(vals[0] * 100).toFixed(1)}% / 中央 ${(vals[Math.floor(vals.length / 2)] * 100).toFixed(2)}%`,
  );
  console.log(
    `    1% 超: ${over(0.01)} マス / 2% 超: ${over(0.02)} / 4% 超: ${over(0.04)} / 8% 超: ${over(0.08)} / 15% 超: ${over(0.15)}`,
  );
  // 盤面に映るポインタは常に 1 個なので、1 フレームあたり 1〜2 マスに収まるのが自然
  const frames = Math.floor((toSec - fromSec) / stepSec) + 1;
  console.log(`    （フレーム数 ${frames}。ポインタは常に 1 個なので、この程度が目安）`);
}

// いちばん明るいマスをいくつか挙げる
console.log('\n# 明るい画素の割合が大きいマス（235 基準・上位 15）');
const top = [...rows].sort((a, b) => b.ratios[3] - a.ratios[3]).slice(0, 15);
for (const r of top) {
  console.log(`  ${String(Math.floor(r.at / 60))}:${String(Math.floor(r.at % 60)).padStart(2, '0')} ${r.usi.padStart(3)}  ${(r.ratios[3] * 100).toFixed(1)}%  最大輝度 ${r.max}`);
}

// 駒の白い部分と紛れていないかの目安: 全マスの最大輝度の分布
const maxes = rows.map((r) => r.max).sort((a, b) => a - b);
console.log(`\n# マス内の最大輝度  最小 ${maxes[0]} / 中央 ${maxes[Math.floor(maxes.length / 2)]} / 最大 ${maxes.at(-1)}`);
console.log('  （駒や盤で 235 を超えるなら、明るさだけでは分けられないということ）');
