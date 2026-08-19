// 外から受け取った盤面の絵（解析画面のスクショ）が、テンプレートの採取源として
// 使えるかを確かめる（検証用）。
//
// この絵は**先手側に成駒 6 種すべてが並べてある**。動画からは「成った瞬間」を
// 捉えるしかなく、そこがいちばん読みにくいので、並べて見せてもらった絵から
// 採る方がずっと安い。ただし**同じ駒デザイン・同じ描画エンジン**でなければ、
// 字形が似ていても輪郭やアンチエイリアスが違って照合が通らない。
//
// 受け入れテストの立て方: この絵の**後手側 3 段は生駒の初期配置**なので、
// 動画から作った生駒テンプレートで読めるかを試せる。読めるなら成駒も使える。
//
//   pnpm --filter kifu-vision exec tsx probe-handoff.ts [画像パス] [動画パス] [初期局面の秒]
import { createInitialState, type PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect, type BoardGeometry } from './src/geometry.ts';
import { grabFrame, loadImage, crop } from './src/frame.ts';
import { extractTemplates, cellImage, ncc, resample, bestShiftNcc, type Template } from './src/template.ts';
import { calibrateGeometry, refineByTemplates, type KnownCell } from './src/calibrate.ts';

const imagePath = process.argv[2] ?? 'data/handoff/promoted.png';
const video = process.argv[3] ?? 'data/videos/v1.mp4';
const initialAt = Number(process.argv[4] ?? 2.5);

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const label = (t: { kind: PieceKind; side: string }) => `${t.side === 'sente' ? '▲' : '▽'}${NAMES[t.kind]}`;

// --- 受け取った絵の格子を測る ---
const img = loadImage(imagePath);
console.log(`# ${imagePath}  ${img.width}x${img.height}`);

// 目視で読み取った当たり（粗い刻みで測ったもの）を出発点にして、細かく測り直す。
const seed: BoardGeometry = {
  originX: 148, originY: 202, cellW: 93.27, cellH: 101.92,
  frameW: img.width, frameH: img.height,
};
const cal = calibrateGeometry(img, seed, {
  originRange: 12, pitchRange: 0.06, originStep: 0.05, pitchStep: 0.01,
});
const geo = cal.geo;
console.log(
  `  格子: 原点 (${geo.originX.toFixed(2)}, ${geo.originY.toFixed(2)})  ` +
    `マス ${geo.cellW.toFixed(3)} x ${geo.cellH.toFixed(3)}  ` +
    `（当たりから ${cal.shift.x.toFixed(2)}, ${cal.shift.y.toFixed(2)} ずれ）`,
);
console.log(`  格子線のくっきりさ: (${cal.contrast.x.toFixed(1)}, ${cal.contrast.y.toFixed(1)})  ※18 未満なら盤が無い疑い`);

// --- 動画から生駒テンプレートを作る ---
const vgeo = SHOGI_WARS_VERTICAL;
const videoBoard = crop(grabFrame(video, initialAt, vgeo.frameW, vgeo.frameH), boardRect(vgeo));
const templates = extractTemplates(videoBoard);
const tw = templates[0].img.width;
const th = templates[0].img.height;
console.log(`\n# 動画 ${initialAt} 秒から生駒 ${templates.length} 種（マス ${tw}x${th}）`);

// --- 格子を「駒の絵が実際に描かれている位置」で詰め直す ---
// 格子線は合っているのに照合が通らないことがある。外から受け取った絵では
// 駒がマスの中のどこに描かれるかが動画と微妙に違うため。
const { board: initial } = createInitialState();
const known: KnownCell[] = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const t = templates.find((x) => x.kind === piece.kind && x.side === piece.side);
    if (t) known.push({ row, col, template: t.img });
  }
}
const refined = refineByTemplates(img, geo, known);
console.log(`\n# 格子をテンプレートとの一致で詰め直す（手掛かり ${known.length} マス）`);
console.log(
  `  原点 (${refined.geo.originX.toFixed(2)}, ${refined.geo.originY.toFixed(2)})  ` +
    `マス ${refined.geo.cellW.toFixed(3)} x ${refined.geo.cellH.toFixed(3)}`,
);
console.log(`  一致度（中央値）: ${refined.before.toFixed(3)} → ${refined.after.toFixed(3)}`);
console.log(
  `  残ったずれ: |dx| 最大 ${Math.max(...refined.shifts.map((s) => Math.abs(s.dx))).toFixed(2)}  ` +
    `|dy| 最大 ${Math.max(...refined.shifts.map((s) => Math.abs(s.dy))).toFixed(2)} 画素`,
);

const useGeo = refined.after > refined.before ? refined.geo : geo;
const board = crop(img, boardRect(useGeo));
const sample = cellImage(board, 0, 0);
console.log(`  切り出したマス: ${sample.width}x${sample.height}`);

/** 受け取った絵のマスを、テンプレートと同じ寸法へ引き伸ばして取る */
const handoffCell = (row: number, col: number) => resample(cellImage(board, row, col), tw, th);

// --- 受け入れテスト: 後手側 3 段（生駒の初期配置）を読ませる ---
interface Trial { row: number; col: number; expect: Template['kind']; side: string; direct: number; shifted: number; dx: number; dy: number; got: string; gotShift: string }
const trials: Trial[] = [];

for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const cell = handoffCell(row, col);
    const scored = templates
      .map((t) => ({ t, direct: ncc(t.img, cell), best: bestShiftNcc(cell, t.img, 5) }))
      .sort((a, b) => b.direct - a.direct);
    const byShift = [...scored].sort((a, b) => b.best.score - a.best.score);
    const top = scored[0];
    const topShift = byShift[0];
    trials.push({
      row, col, expect: piece.kind, side: piece.side,
      direct: top.direct, shifted: topShift.best.score,
      dx: topShift.best.dx, dy: topShift.best.dy,
      got: label(top.t), gotShift: label(topShift.t),
    });
  }
}

const stats = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return `最低 ${s[0].toFixed(3)} / 中央 ${s[s.length >> 1].toFixed(3)} / 最高 ${s.at(-1)!.toFixed(3)}`;
};
const okDirect = trials.filter((t) => t.got === label({ kind: t.expect, side: t.side }));
const okShift = trials.filter((t) => t.gotShift === label({ kind: t.expect, side: t.side }));

console.log(`\n# 受け入れテスト（後手側の生駒 ${trials.length} マス）`);
console.log(`  そのまま照合        : ${okDirect.length}/${trials.length} 正解  NCC ${stats(trials.map((t) => t.direct))}`);
console.log(`  ±5 画素ずらして最良 : ${okShift.length}/${trials.length} 正解  NCC ${stats(trials.map((t) => t.shifted))}`);

const shiftsX = trials.map((t) => t.dx);
const shiftsY = trials.map((t) => t.dy);
const mode = (vs: number[]) => {
  const c = new Map<number, number>();
  for (const v of vs) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0];
};
console.log(`  最良のずれ: x ${mode(shiftsX)[0]}（${mode(shiftsX)[1]}/${trials.length} マス）  y ${mode(shiftsY)[0]}（${mode(shiftsY)[1]}/${trials.length} マス）`);
console.log('  ※ ずれが 0 に寄っていれば格子は合っている。偏っていれば原点をその分ずらすべき');

const wrong = trials.filter((t) => t.got !== label({ kind: t.expect, side: t.side }));
if (wrong.length > 0) {
  console.log('\n  読み違えたマス（そのまま照合）:');
  for (const t of wrong) {
    console.log(
      `    ${9 - t.col}${String.fromCharCode(97 + t.row)}: 正解 ${label({ kind: t.expect, side: t.side })} → ${t.got}` +
        `（NCC ${t.direct.toFixed(3)}）  ずらせば ${t.gotShift}（${t.shifted.toFixed(3)}・${t.dx},${t.dy}）`,
    );
  }
}

// --- 成駒がどこにあるか、絵が本当に「生駒に似ていない」かを見る ---
// 本物の成駒は生駒と 0.31 前後しか相関しない。0.6 を超えるなら、それは
// 成駒ではなく生駒を読み違えている（＝並びの読み取りが違う）。
const PROMOTED: { kind: PieceKind; cells: [number, number][] }[] = [
  { kind: '+P', cells: [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [6, 6], [6, 7], [6, 8]] },
  { kind: '+B', cells: [[7, 1]] },
  { kind: '+R', cells: [[7, 7]] },
  { kind: '+L', cells: [[8, 0], [8, 8]] },
  { kind: '+N', cells: [[8, 1], [8, 7]] },
  { kind: '+S', cells: [[8, 2], [8, 6]] },
];

console.log('\n# 成駒が並んでいるはずのマス（先手側）');
console.log('  ※ 生駒との相関が 0.6 未満であることが「本当に成駒である」ことの裏付け');
for (const { kind, cells } of PROMOTED) {
  const per = cells.map(([row, col]) => {
    const cell = handoffCell(row, col);
    const best = templates.map((t) => ({ t, s: ncc(t.img, cell) })).sort((a, b) => b.s - a.s)[0];
    return { row, col, best };
  });
  const worst = per.reduce((a, b) => (b.best.s > a.best.s ? b : a));
  console.log(
    `  ${NAMES[kind]}（${cells.length} マス）: 生駒との相関は最大 ${worst.best.s.toFixed(3)}` +
      `（${9 - worst.col}${String.fromCharCode(97 + worst.row)} が ${label(worst.best.t)} に似ている）` +
      `${worst.best.s >= 0.6 ? '  ⚠ 高すぎる' : ''}`,
  );
}
