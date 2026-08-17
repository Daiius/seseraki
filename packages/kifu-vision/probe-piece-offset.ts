// 駒がマスの中心からどれだけずれて写っているかを測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-piece-offset.ts <動画パス> <秒> [秒...]
//
// ⭐ **狙い**（追記 163）: **スライド途中の駒を、止まっている駒として読んでいる。**
// 3 本目 26:16.5 で、2f から 3g へ滑る飛車が **3f に 1 サンプルだけ現れ**、
// 移動元を 3f と誤読して 1 手ぶんの穴が空いた。
//
// 🔒 **いまの認識は「そのマスに何があるか」しか見ていない。「どこにあるか」を見ていない。**
// 止まっている駒はマスの中心に来るはずで、スライド中は境界をまたぐので中心からずれるはず。
// ここではマスごとに**濃淡の重心**を取り、マス中心からのずれを画素で出す。
//
// ⚠ **これは測るだけの道具。** 割れなければ、この方向は捨てる材料になる。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { cellImage } from './src/template.ts';
import { presence } from './src/occupancy.ts';

const video = process.argv[2];
const times = process.argv.slice(3).map(Number);
if (!video || times.length === 0) {
  console.error('使い方: probe-piece-offset.ts <動画パス> <秒> [秒...]');
  process.exit(1);
}
const geo = SHOGI_WARS_VERTICAL;
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.round((t % 1) * 10)}`;
const name = (row: number, col: number) => `${9 - col}${String.fromCharCode(97 + row)}`;

/**
 * マスの中の「濃淡の重心」が、マスの中心からどれだけずれているか。
 *
 * 中央値からの差の絶対値を重みにする。駒の字・輪郭・影がすべて重みになるので、
 * 駒がマスの中で偏っていれば重心も偏る。
 */
function offset(cell: GrayImage): { dx: number; dy: number; dist: number } {
  const values = [...cell.data].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const w = Math.abs(cell.data[y * cell.width + x] - median);
      sum += w;
      sx += w * x;
      sy += w * y;
    }
  }
  if (sum === 0) return { dx: 0, dy: 0, dist: 0 };
  const dx = sx / sum - (cell.width - 1) / 2;
  const dy = sy / sum - (cell.height - 1) / 2;
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

for (const t of times) {
  const board = crop(grabFrame(video, t, geo.frameW, geo.frameH), boardRect(geo));
  const where = presence(board);
  const rows: string[] = [];
  const all: { where: string; dist: number }[] = [];
  for (let row = 0; row < 9; row++) {
    const cells: string[] = [];
    for (let col = 0; col < 9; col++) {
      const cell = cellImage(board, row, col);
      // 駒があると判定されたマスだけを見る（空マスの重心には意味が無い）
      if (where[row][col] !== 'piece') {
        cells.push('    ・');
        continue;
      }
      const o = offset(cell);
      all.push({ where: name(row, col), dist: o.dist });
      cells.push(o.dist.toFixed(1).padStart(6));
    }
    rows.push(` ${String.fromCharCode(97 + row)} ${cells.join('')}`);
  }
  console.log(`\n# ${fmt(t)} 秒  マス中心からのずれ（画素）`);
  console.log('      9     8     7     6     5     4     3     2     1');
  for (const r of rows) console.log(r);
  const sorted = [...all].sort((a, b) => b.dist - a.dist);
  const mid = [...all].map((a) => a.dist).sort((a, b) => a - b)[Math.floor(all.length / 2)];
  console.log(`  駒のあるマス ${all.length} / 中央値 ${mid?.toFixed(2)}`);
  console.log(`  ずれの大きい順: ${sorted.slice(0, 5).map((s) => `${s.where} ${s.dist.toFixed(1)}`).join(' / ')}`);
}
