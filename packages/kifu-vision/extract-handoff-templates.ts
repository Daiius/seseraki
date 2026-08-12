// 外から受け取った盤面の絵から、成駒テンプレート 12 種を起こして保存する。
//
// 動画からは成駒を採りにくい。初期局面に無いので「成った瞬間」を捉えるしかなく、
// そこは**駒を動かした直後でマウスポインタが乗っている**うえ、直前に指した手の
// マスにはハイライトが付く。実際、自動学習で貯まったのは 12 種のうち 4 種だけで、
// しかもそのうち 1 種はラベルを間違えていた（誤ったテンプレートは全体を止める）。
//
// 並べて見せてもらった絵から採れば、この問題が丸ごと消える。
//
// ⭐ **回転で半分にできる。** 後手の駒は先手の駒を 180 度回して数画素ずらしたもので、
// ずれ量は生駒 8 種（両向き揃っている）から測り直せる。先手 6 種で 12 種そろう。
//
//   pnpm --filter kifu-vision exec tsx extract-handoff-templates.ts [画像] [動画] [初期局面の秒]
//
// 既定は確認だけで保存しない。保存するには KIFU_VISION_SAVE=1 を付ける。
import { createInitialState, type PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect, type BoardGeometry } from './src/geometry.ts';
import { grabFrame, loadImage, crop, type GrayImage } from './src/frame.ts';
import {
  extractTemplates, cellImage, ncc, resample, rotate180, shiftImage,
  bestShiftNcc, bestSubpixelShiftNcc,
  type Template,
} from './src/template.ts';
import { calibrateGeometry, refineByTemplates, type KnownCell } from './src/calibrate.ts';
import { loadTemplates, saveTemplates } from './src/template-store.ts';
import { montage, magnify, writePgm, toPng, type MontageCell } from './src/montage.ts';

const imagePath = process.argv[2] ?? 'data/handoff/promoted.png';
const video = process.argv[3] ?? 'data/videos/fQR9Fx7DOvk.mp4';
const initialAt = Number(process.argv[4] ?? 2.5);
const STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
const DUMP_DIR = process.env.KIFU_VISION_DUMP_DIR ?? 'data/handoff-templates';
const SAVE = process.env.KIFU_VISION_SAVE === '1';

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const label = (kind: PieceKind, side: string) => `${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}`;

/**
 * 受け取った絵のどこに何が並んでいるか（`[row][col]`・row 0 が上端）。
 *
 * 人が目で読んで確かめた表。**同じ駒種が複数あるものは平均できる**ので、
 * 背景の木目を均せる（動画からだと成駒は原理的に 1 枚しか採れない）。
 */
const PROMOTED: { kind: PieceKind; cells: [number, number][] }[] = [
  { kind: '+P', cells: [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [6, 6], [6, 7], [6, 8]] },
  { kind: '+B', cells: [[7, 1]] },
  { kind: '+R', cells: [[7, 7]] },
  { kind: '+L', cells: [[8, 0], [8, 8]] },
  { kind: '+N', cells: [[8, 1], [8, 7]] },
  { kind: '+S', cells: [[8, 2], [8, 6]] },
];

// --- 1. 受け取った絵の格子を測る ---
const img = loadImage(imagePath);
const seed: BoardGeometry = {
  originX: 148, originY: 202, cellW: 93.27, cellH: 101.92,
  frameW: img.width, frameH: img.height,
};
const byLines = calibrateGeometry(img, seed, {
  originRange: 12, pitchRange: 0.06, originStep: 0.05, pitchStep: 0.01,
});
console.log(`# ${imagePath}  ${img.width}x${img.height}`);
console.log(`  格子線から: 原点 (${byLines.geo.originX.toFixed(2)}, ${byLines.geo.originY.toFixed(2)})  マス ${byLines.geo.cellW.toFixed(3)} x ${byLines.geo.cellH.toFixed(3)}  くっきりさ (${byLines.contrast.x.toFixed(1)}, ${byLines.contrast.y.toFixed(1)})`);

// --- 2. 動画から生駒テンプレートを作る ---
const vgeo = SHOGI_WARS_VERTICAL;
const videoBoard = crop(grabFrame(video, initialAt, vgeo.frameW, vgeo.frameH), boardRect(vgeo));
const raw = extractTemplates(videoBoard);
const tw = raw[0].img.width;
const th = raw[0].img.height;
console.log(`  動画 ${initialAt} 秒から生駒 ${raw.length} 種（マス ${tw}x${th}）`);

// --- 3. 格子を「駒の絵が実際に描かれている位置」で詰め直す ---
const { board: initial } = createInitialState();
const known: KnownCell[] = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const t = raw.find((x) => x.kind === piece.kind && x.side === piece.side);
    if (t) known.push({ row, col, template: t.img });
  }
}
const refined = refineByTemplates(img, byLines.geo, known);
console.log(`  詰め直し後: 原点 (${refined.geo.originX.toFixed(2)}, ${refined.geo.originY.toFixed(2)})  マス ${refined.geo.cellW.toFixed(3)} x ${refined.geo.cellH.toFixed(3)}`);
console.log(`  手掛かり ${known.length} マスの一致度（中央値）: ${refined.before.toFixed(3)} → ${refined.after.toFixed(3)}`);

// 🔒 受け入れテストを通らないなら採取しない。格子が合っていない絵から起こした
// テンプレートは、ラベルが正しくても中身がずれている。
if (refined.after < 0.7) {
  console.error(`\n🔴 一致度が低すぎる（${refined.after.toFixed(3)}）。格子が合っていないので採取しない。`);
  process.exit(1);
}

const board = crop(img, boardRect(refined.geo));
const cw = cellImage(board, 0, 0).width;
const chh = cellImage(board, 0, 0).height;
console.log(`  切り出すマス: ${cw}x${chh}`);

const med = (vs: number[]) => [...vs].sort((a, b) => a - b)[vs.length >> 1];

// --- 4a. 受け取った絵と動画の間に残った位置ずれを測る ---
// 格子は詰め直したが、切り出しの丸めのぶん 1 画素弱の残差が出る。
// **同じ向きの生駒どうし**（受け取った絵の後手 3 段と、動画の後手テンプレート）で
// 測れるので、成駒にもその分を先に効かせておく。
console.log('\n# 受け取った絵と動画の残差（同じ向きの生駒で実測）');
const resid: { dx: number; dy: number; score: number }[] = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const t = raw.find((x) => x.kind === piece.kind && x.side === piece.side);
    if (!t) continue;
    const cell = resample(cellImage(board, row, col), tw, th);
    resid.push(bestSubpixelShiftNcc(cell, t.img, 3));
  }
}
const residDx = med(resid.map((s) => s.dx));
const residDy = med(resid.map((s) => s.dy));
console.log(`  中央値 (${residDx.toFixed(2)}, ${residDy.toFixed(2)}) 画素（動画のマス基準）  一致度 ${med(resid.map((s) => s.score)).toFixed(3)}`);
// 受け取った絵の寸法に直す。**この分だけ絵を戻せば動画の切り出しと揃う。**
const fixDx = (-residDx * cw) / tw;
const fixDy = (-residDy * chh) / th;
console.log(`  → 採取した絵を (${fixDx.toFixed(2)}, ${fixDy.toFixed(2)}) 戻して揃える`);

// --- 4b. 後手＝先手を 180 度回したときのずれを、生駒 8 種から測る ---
// 両向き揃っているのは生駒だけなので、ここでしか測れない。
console.log('\n# 後手＝先手を 180 度回したときのずれ（生駒 8 種で実測）');
const rotShifts: { kind: PieceKind; dx: number; dy: number; score: number }[] = [];
for (const s of raw.filter((t) => t.side === 'sente')) {
  const g = raw.find((t) => t.kind === s.kind && t.side === 'gote');
  if (!g) continue;
  const best = bestSubpixelShiftNcc(g.img, rotate180(s.img), 8);
  rotShifts.push({ kind: s.kind, dx: best.dx, dy: best.dy, score: best.score });
  console.log(`  ${NAMES[s.kind]}: ずれ (${best.dx.toFixed(2)}, ${best.dy.toFixed(2)})  NCC ${best.score.toFixed(3)}`);
}
const rotDx = med(rotShifts.map((s) => s.dx));
const rotDy = med(rotShifts.map((s) => s.dy));
const rotScore = med(rotShifts.map((s) => s.score));
console.log(`  → 中央値 (${rotDx.toFixed(2)}, ${rotDy.toFixed(2)})  一致度 ${rotScore.toFixed(3)}`);
if (rotScore < 0.9) {
  console.error(`\n🔴 回転の一致度が低い（${rotScore.toFixed(3)}）。「後手は先手を回したもの」が成り立っていない。`);
  process.exit(1);
}
// 動画のマスで測ったずれを、受け取った絵のマスの大きさに直す。
// ⚠ **丸めない。** 比率を掛けるので必ず小数になり、丸めると 0.5 画素の誤差が乗る。
const hDx = (rotDx * cw) / tw;
const hDy = (rotDy * chh) / th;
console.log(`  受け取った絵の寸法に直すと (${hDx.toFixed(2)}, ${hDy.toFixed(2)})`);

// --- 5. 成駒を切り出して平均する ---
function average(images: GrayImage[]): GrayImage {
  const { width, height } = images[0];
  const sum = new Float64Array(width * height);
  for (const im of images) for (let i = 0; i < sum.length; i++) sum[i] += im.data[i];
  return { width, height, data: Uint8Array.from(sum, (v) => Math.round(v / images.length)) };
}

console.log('\n# 成駒を切り出す');
const made: Template[] = [];
for (const { kind, cells } of PROMOTED) {
  const images = cells.map(([row, col]) => cellImage(board, row, col));
  // 動画の切り出しと揃うよう、残差のぶんだけ戻してから平均する。
  const aligned = average(images);
  const sente: Template = {
    kind, side: 'sente', samples: cells.length,
    img: shiftImage(aligned, fixDx, fixDy),
  };
  // 後手は回してずらす。ずれ量は生駒から測ったもの。
  const gote: Template = {
    kind, side: 'gote', samples: cells.length,
    img: shiftImage(rotate180(sente.img), hDx, hDy),
  };
  made.push(sente, gote);

  // 同じ駒種どうしがどれだけ揃っているか（複数マスある場合）。
  // ばらつきが大きければ、並びの読み取りが違うか演出が乗っている。
  const spread = images.length > 1
    ? `  マスどうしの一致度 最低 ${Math.min(...images.map((im) => ncc(im, sente.img))).toFixed(3)}`
    : '';
  console.log(`  ${label(kind, 'sente')}  ${cells.length} マスを平均${spread}`);
}

// --- 6a. 対照: 受け取った絵から採ると、そもそもどれくらい他人に似るか ---
// ⚠ **これを測らずに閾値を当てはめてはいけない。** 受け取った絵のマス（48x53）は
// 動画のマス（61x66）へ引き伸ばして照合するので、補間のぶんだけ絵がぼける。
// **ぼけた絵は何にでも似る**ので、相関の下駄が全体に乗る。
// 正解が分かっている生駒（受け取った絵の後手 3 段）で、**誤った相手との相関**が
// どこまで出るかを測れば、その下駄の高さが分かる。
console.log('\n# 対照: 受け取った絵から採った生駒が、誤った相手とどれだけ相関するか');
const crossTalk: number[] = [];
let ctWorst = { s: -2, what: '' };
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const cell = shiftImage(resample(cellImage(board, row, col), tw, th), -residDx, -residDy);
    for (const r of raw) {
      if (r.kind === piece.kind && r.side === piece.side) continue;
      const s = ncc(r.img, cell);
      crossTalk.push(s);
      if (s > ctWorst.s) ctWorst = { s, what: `${label(piece.kind, piece.side)} が ${label(r.kind, r.side)} に` };
    }
  }
}
const ctSorted = [...crossTalk].sort((a, b) => a - b);
console.log(`  誤った相手との相関: 中央 ${ctSorted[ctSorted.length >> 1].toFixed(3)} / 上位 5% ${ctSorted[Math.floor(ctSorted.length * 0.95)].toFixed(3)} / 最大 ${ctWorst.s.toFixed(3)}（${ctWorst.what}）`);

// --- 6b. 🔒 検証: 生駒と紛れていないか ---
// 本物の成駒は生駒と 0.31 前後しか相関しない。**読み違えて覚えた絵は 0.84 だった**
// （演出で白っぽくなった普通の銀を「成銀」と逆算していた）。
//
// ⚠ **相関の高さは「別の駒の写し」の代用でしかなく、代用として不正確だった。**
// `▲全`（成銀）は `▲金` と 0.70〜0.81 相関する。位置合わせを良くするほど上がる。
// 一方、動画から採った生駒どうしの最大相関は 0.415（桂⇔銀）しかないので、
// 閾値をどこに引いても `全` だけが弾かれる。
//
// ⭐ 目で見れば話は簡単だった。**`金` は点が二つ付き、`全` は付かない。**
// 字は違う。似ているのは字画の重心がほぼ同じだからで、NCC はそこをよく拾う。
//
// つまり測るべきは相関そのものではない。**「その生駒自身のマスを横取りするか」**
// を見ればよい（検証 4）。ここは紛らわしさの記録に留める。
const WARN = 0.6;
console.log('\n# 検証 1: 生駒との相関（記録用。高くても直ちに誤りではない）');
for (const t of made) {
  const cell = resample(t.img, tw, th);
  const scored = raw.map((r) => ({ r, s: ncc(r.img, cell) })).sort((a, b) => b.s - a.s);
  const worst = scored[0];
  const mark = worst.s >= WARN ? '  ⚠ 紛らわしい（読みだけでは決められない。合法手で絞ること）' : '';
  console.log(`  ${label(t.kind, t.side)}: 最大 ${worst.s.toFixed(3)}（${label(worst.r.kind, worst.r.side)}）  2位との差 ${(worst.s - scored[1].s).toFixed(3)}${mark}`);
}

// --- 7. 🔒 検証: 成駒どうしが紛れていないか ---
// 全と金、圭と桂のように似た字がある。互いの相関が高いと、どちらに読むかが
// 運任せになる。
console.log('\n# 🔒 検証 2: 成駒どうしの相関（紛らわしさ）');
for (const t of made.filter((x) => x.side === 'sente')) {
  const others = made.filter((x) => x.side === 'sente' && x !== t);
  const worst = others.map((o) => ({ o, s: ncc(o.img, t.img) })).sort((a, b) => b.s - a.s)[0];
  console.log(`  ${label(t.kind, t.side)}: 最大 ${worst.s.toFixed(3)}（${label(worst.o.kind, worst.o.side)}）${worst.s >= 0.6 ? '  ⚠ 紛らわしい' : ''}`);
}

// --- 8. 🔒 検証: 既に保存してあるテンプレートと突き合わせる ---
// 自動学習で貯まった 4 種のうち、`▲杏` はラベルの誤りが疑われていた
// （本物の `▽杏` を回した相手として 0.171 しか出なかった）。ここで白黒を付ける。
console.log('\n# 🔒 検証 3: 保存済みテンプレートとの突き合わせ');
const storedRaw = loadTemplates(STORE);
if (!storedRaw) {
  console.log('  保存済みのテンプレートは無し');
} else {
  for (const s of storedRaw) {
    const mine = made.find((m) => m.kind === s.kind && m.side === s.side);
    if (!mine) {
      console.log(`  ${label(s.kind, s.side)}: 今回作っていない`);
      continue;
    }
    // 寸法を合わせて、位置ずれも許して比べる（別々に切り出したものなので）
    const a = resample(s.img, tw, th);
    const b = resample(mine.img, tw, th);
    const best = bestShiftNcc(a, b, 5);
    const verdict = best.score >= 0.6 ? '✅ 同じ駒' : '🔴 別物（保存済みのラベルが誤り）';
    console.log(`  ${label(s.kind, s.side)}: ${best.score.toFixed(3)}（ずれ ${best.dx},${best.dy}）  ${verdict}`);
  }
}

// --- 8b. 🔒 検証 4: 生駒自身のマスを横取りしないか【これが本当の判定】 ---
//
// テンプレートのラベルが誤っている（＝実は別の駒の写しである）なら、
// **その駒の本物のマスに対して、本物のテンプレートより高い点を出すはず**。
// 相関の絶対値ではなく、この「横取り」を見る方が直接的で、
// 似た字（金と全）を誤って弾かずに済む。
//
// 材料は動画の初期局面にある。生駒 8 種 × 2 向きの正解マスが全部揃っている。
console.log('\n# 🔒 検証 4: 生駒自身のマスを横取りしないか（これが本当の判定）');
const initialCells: { row: number; col: number; kind: PieceKind; side: string }[] = [];
for (let row = 0; row < 9; row++) {
  for (let col = 0; col < 9; col++) {
    const p = initial[row][col];
    if (p) initialCells.push({ row, col, kind: p.kind, side: p.side });
  }
}
let ng = 0;
for (const t of made) {
  const cell = resample(t.img, tw, th);
  let worst = { margin: Infinity, at: '', rawScore: 0, mineScore: 0 };
  for (const c of initialCells) {
    const real = cellImage(videoBoard, c.row, c.col);
    const rawT = raw.find((r) => r.kind === c.kind && r.side === c.side)!;
    const rawScore = ncc(rawT.img, real);
    const mineScore = ncc(cell, real);
    if (rawScore - mineScore < worst.margin) {
      worst = { margin: rawScore - mineScore, at: `${label(c.kind, c.side)} ${9 - c.col}${String.fromCharCode(97 + c.row)}`, rawScore, mineScore };
    }
  }
  const stolen = worst.margin <= 0;
  if (stolen) ng++;
  console.log(
    `  ${label(t.kind, t.side)}: いちばん際どいのは ${worst.at}` +
      `（本物 ${worst.rawScore.toFixed(3)} vs これ ${worst.mineScore.toFixed(3)}・差 ${worst.margin.toFixed(3)}）` +
      `${stolen ? '  🔴 横取りしている＝ラベルが誤り' : ''}`,
  );
}

// --- 9. 目視用に並べて書き出す ---
// 🔒 **後手の駒は必ず 180 度回して読む。** `と`→`ス` に見えるので、
// 回さずに眺めると平気で誤ラベルを通してしまう（実際 2 回やった）。
const senteMade = made.filter((t) => t.side === 'sente');
const goteMade = made.filter((t) => t.side === 'gote');
const cells: MontageCell[] = [
  // 1 段目: 起こした成駒（先手）
  ...senteMade.map((t) => ({ img: magnify(resample(t.img, tw, th), 2), caption: label(t.kind, 'sente') })),
  // 2 段目: 起こした成駒（後手）を回して見せる。人が読めるのはこの向き。
  ...goteMade.map((t) => ({ img: magnify(rotate180(resample(t.img, tw, th)), 2), caption: `${label(t.kind, 'gote')}（回した）` })),
  // 3 段目: 紛らわしい相手を隣に置く。全と金、圭と桂を並べて見比べるため。
  ...(['G', 'S', 'N', 'L', 'B', 'R'] as PieceKind[]).map((k) => ({
    img: magnify(raw.find((t) => t.kind === k && t.side === 'sente')!.img, 2),
    caption: `${label(k, 'sente')}（生駒・動画から）`,
  })),
];
const sheet = montage(cells, { columns: 6, gap: 8 });
writePgm(sheet.img, `${DUMP_DIR}/sheet.pgm`);
toPng(`${DUMP_DIR}/sheet.pgm`, `${DUMP_DIR}/sheet.png`);
for (const t of made) {
  const name = `${t.side}-${t.kind.replace('+', 'p')}`;
  writePgm(t.img, `${DUMP_DIR}/${name}.pgm`);
  if (t.side === 'gote') writePgm(rotate180(t.img), `${DUMP_DIR}/${name}-rotated.pgm`);
}
console.log(`\n# 目視用に書き出した: ${DUMP_DIR}/sheet.png`);
console.log(sheet.captions.map((c) => `    ${c}`).join('\n'));

// --- 10. 保存 ---
if (ng > 0) {
  console.error(`\n🔴 生駒のマスを横取りするテンプレートが ${ng} 種ある。ラベルが誤っているので保存しない。`);
  process.exit(1);
}
if (!SAVE) {
  console.log('\n# 確認のみ（保存するには KIFU_VISION_SAVE=1）');
} else {
  // 12 種そろうので、自動学習で貯めた成駒は**まるごと置き換える**。
  // 疑わしいものを個別に外すより、出所のはっきりした一式に入れ替える方が確実。
  saveTemplates(made, STORE);
  console.log(`\n# 保存した: ${made.length} 種 → ${STORE}（自動学習ぶんは置き換え）`);
}
