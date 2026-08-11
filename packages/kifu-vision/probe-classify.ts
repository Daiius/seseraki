// 初期局面のフレームからテンプレートを作り、別の時刻の局面を読ませてみる（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-classify.ts <動画パス> <初期局面の秒> <読ませたい秒>
import type { PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { occupancy } from './src/occupancy.ts';
import { extractTemplates, cellImage, classify } from './src/template.ts';

const video = process.argv[2];
const initialAt = Number(process.argv[3] ?? 2.5);
const targetAt = Number(process.argv[4] ?? 180);
const geo = SHOGI_WARS_VERTICAL;

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const grabBoard = (seconds: number) =>
  crop(grabFrame(video, seconds, geo.frameW, geo.frameH), boardRect(geo));

const templates = extractTemplates(grabBoard(initialAt));
console.log(`# ${initialAt} 秒の初期局面から ${templates.length} 種のテンプレートを抽出`);
for (const t of templates) {
  console.log(`  ${t.side === 'sente' ? '▲' : '▽'}${NAMES[t.kind]}  ${t.samples} マスを平均  ${t.img.width}x${t.img.height}`);
}

const board = grabBoard(targetAt);
const occ = occupancy(board);

const cells: string[][] = [];
const scores: number[][] = [];
const margins: number[][] = [];
let matched = 0;
let weakest = { score: 1, margin: 1, at: '' };

for (let row = 0; row < 9; row++) {
  cells.push([]);
  scores.push([]);
  margins.push([]);
  for (let col = 0; col < 9; col++) {
    if (!occ[row][col]) {
      cells[row].push(' ・ ');
      scores[row].push(NaN);
      margins[row].push(NaN);
      continue;
    }
    const m = classify(cellImage(board, row, col), templates);
    if (!m) {
      cells[row].push(' ?? ');
      scores[row].push(NaN);
      margins[row].push(NaN);
      continue;
    }
    matched++;
    cells[row].push(`${m.template.side === 'sente' ? '▲' : '▽'}${NAMES[m.template.kind]}`);
    scores[row].push(m.score);
    margins[row].push(m.margin);
    if (m.score < weakest.score) {
      weakest = { score: m.score, margin: m.margin, at: `${9 - col}${String.fromCharCode(97 + row)}` };
    }
  }
}

console.log(`\n# ${targetAt} 秒の局面（駒があると判定されたマス: ${matched}）`);
console.log('      ' + Array.from({ length: 9 }, (_, c) => String(9 - c).padStart(4)).join(''));
for (let row = 0; row < 9; row++) {
  console.log(`  ${String.fromCharCode(97 + row)} |` + cells[row].map((s) => s.padStart(4)).join(''));
}

const flat = scores.flat().filter((v) => !Number.isNaN(v));
const flatM = margins.flat().filter((v) => !Number.isNaN(v));
console.log(`\n# 一致度 NCC: 最低 ${Math.min(...flat).toFixed(3)} / 中央 ${flat.sort((a, b) => a - b)[Math.floor(flat.length / 2)].toFixed(3)} / 最高 ${Math.max(...flat).toFixed(3)}`);
console.log(`# 2 位との差: 最低 ${Math.min(...flatM).toFixed(3)} / 中央 ${flatM.sort((a, b) => a - b)[Math.floor(flatM.length / 2)].toFixed(3)}`);
console.log(`# 一番自信のないマス: ${weakest.at}  NCC=${weakest.score.toFixed(3)}  2位との差=${weakest.margin.toFixed(3)}`);
console.log('\n# 参考: 1 位のスコアが低い、または 2 位との差が小さいマスは成駒の可能性がある');
console.log('#（成駒は初期局面に無いのでテンプレートがまだ存在しない）');
for (let row = 0; row < 9; row++) {
  for (let col = 0; col < 9; col++) {
    const s = scores[row][col];
    const m = margins[row][col];
    if (Number.isNaN(s)) continue;
    if (s < 0.7 || m < 0.08) {
      console.log(`  ${9 - col}${String.fromCharCode(97 + row)}: ${cells[row][col].trim()}  NCC=${s.toFixed(3)}  差=${m.toFixed(3)}`);
    }
  }
}
