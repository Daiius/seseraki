// いま持っているテンプレートを全部 PGM に書き出して、目で見て確かめる。
//
// 生駒 8 種 × 2 向きは平手初期局面から毎回作り直しているので、ファイルには
// 残っていない。**「保存されている絵の一覧」を見ても全体は分からない**ので、
// ここでは初期局面から作る分も含めて、実際に照合に使われる一式を出す。
//
//   pnpm --filter kifu-vision exec tsx dump-templates.ts <動画パス> [出力先ディレクトリ]
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { cellImage, extractTemplates, ncc, type Template } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { occupancy, occupancyDistance, INITIAL_OCCUPANCY, hasPointer } from './src/occupancy.ts';

const video = process.argv[2];
const outDir = process.argv[3] ?? 'data/templates-dump';
const store = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
const geo = SHOGI_WARS_VERTICAL;

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

function dumpPgm(img: GrayImage, path: string) {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

mkdirSync(outDir, { recursive: true });

// --- 初期局面を探す（extract-simple と同じ判定） ---
// 全編走査は重いので、冒頭だけを 1 秒刻みで見る。
let initialSec = -1;
for (let s = 1; s <= 40; s++) {
  const board = grabBoard(s);
  if (occupancyDistance(occupancy(board), INITIAL_OCCUPANCY) === 0) {
    initialSec = s;
    break;
  }
}
if (initialSec < 0) {
  console.error('初期局面が見つかりません');
  process.exit(1);
}
console.log(`# 初期局面: ${initialSec} 秒`);

const fromInitial = extractTemplates(grabBoard(initialSec));
const cellSize = { width: fromInitial[0].img.width, height: fromInitial[0].img.height };
const stored = loadTemplates(store, cellSize) ?? [];
const all: Template[] = mergeTemplates(fromInitial, stored);

console.log(`  生駒 ${fromInitial.length} 種 + 保存済み ${all.length - fromInitial.length} 種 = ${all.length} 種`);
console.log(`  1 枚の寸法: ${cellSize.width}x${cellSize.height}（MATCH_INSET で切り出した内側）`);

const meta: unknown[] = [];
for (const t of all) {
  const origin = fromInitial.includes(t) ? 'initial' : 'stored';
  const name = `${t.side}-${t.kind.replace('+', 'p')}`;
  dumpPgm(t.img, `${outDir}/${name}.pgm`);
  meta.push({ file: `${name}.pgm`, kind: t.kind, side: t.side, name: NAMES[t.kind], samples: t.samples, origin });
}

// --- 保存されていないが起こせる候補（成駒）も一緒に出す ---
// 「入れると悪化した」龍を含む。絵として何が起きているのかを見るため。
const CANDIDATES: { seconds: number; square: string; kind: PieceKind; side: 'sente' | 'gote'; note: string }[] = [
  { seconds: 272, square: '8g', kind: '+R', side: 'gote', note: '4:32 8g・入れると悪化した龍' },
  { seconds: 300, square: '8g', kind: '+R', side: 'gote', note: '5:00 8g・同じ龍の別時刻' },
  { seconds: 400, square: '8g', kind: '+R', side: 'gote', note: '6:40 8g・同じ龍の別時刻' },
  { seconds: 336, square: '2b', kind: '+P', side: 'sente', note: '5:36 2b・採用済みの と金 の元' },
];
const at = (usi: string) => ({ row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) });
for (const c of CANDIDATES) {
  const { row, col } = at(c.square);
  const board = grabBoard(c.seconds);
  const img = cellImage(board, row, col);
  const name = `cand-${c.seconds}-${c.square}-${c.side}-${c.kind.replace('+', 'p')}`;
  dumpPgm(img, `${outDir}/${name}.pgm`);
  meta.push({
    file: `${name}.pgm`, kind: c.kind, side: c.side, name: NAMES[c.kind],
    samples: 1, origin: 'candidate', note: c.note,
    pointer: hasPointer(cellImage(board, row, col, 0.18)),
  });
}

// --- テンプレートどうしの紛らわしさ ---
const rows: string[] = [];
for (let i = 0; i < all.length; i++) {
  let worst = { sim: -2, other: '' };
  for (let j = 0; j < all.length; j++) {
    if (i === j) continue;
    const sim = ncc(all[i].img, all[j].img);
    if (sim > worst.sim) worst = { sim, other: `${all[j].side === 'sente' ? '▲' : '▽'}${NAMES[all[j].kind]}` };
  }
  rows.push(`  ${all[i].side === 'sente' ? '▲' : '▽'}${NAMES[all[i].kind]}  最大相関 ${worst.sim.toFixed(3)}  相手 ${worst.other}`);
}
console.log('\n# テンプレートどうしの最大相関');
console.log(rows.join('\n'));

writeFileSync(`${outDir}/index.json`, JSON.stringify(meta, null, 2));
console.log(`\n# ${meta.length} 枚を ${outDir} に書き出した`);
