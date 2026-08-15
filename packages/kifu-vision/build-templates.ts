// 目で選んだ駒の絵から、照合に使うテンプレート一式を作る。
//
//   pnpm --filter kifu-vision exec tsx build-templates.ts <選択リスト> [出力先]
//
// 選択リストは 1 行 1 枚で、`probe-template-sources.ts` /
// `probe-promoted-sources.ts` が付けた名前をそのまま書く:
//
//   v1:25-sente-P                  生駒（v1 の 2.5 秒・先手向き・歩）
//   v1:g2-12765-sente-pP-3c        成駒（v1 の 2 局目・1276.5 秒・先手向きのと金・3c）
//
// 既定は確認だけで保存しない。保存するには KIFU_VISION_SAVE=1 を付ける。
//
// ⭐ **なぜ人が選ぶのか。** 良し悪しの大半は数値で出るが、出ないものが残る。
// マウスポインタが駒の隅に半分だけ掛かった絵は、相関も分離も並の値を出す
// （実測でそれが 13 手を総崩れにした）。**選別は 1 度きりで、結果は資産になる**
// ので、そこだけ人の目を通す方が安い。
//
// 🔒 **同じ駒種が両向きそろっている場合は、片方を回してもう片方と突き合わせる。**
// 回転で作った絵を使う前に、回転そのものが成り立つことを毎回測り直す。
import { readFileSync } from 'node:fs';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import {
  cellImage, extractTemplates, ncc, resample, rotate180, shiftImage,
  bestSubpixelShiftNcc, type Template,
} from './src/template.ts';
import { loadTemplates, saveTemplates } from './src/template-store.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { createInitialState, type PieceKind, type Side } from 'shared';

const listPath = process.argv[2];
const STORE_IN = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
const STORE_OUT = process.argv[3] ?? STORE_IN;
const SAVE = process.env.KIFU_VISION_SAVE === '1';

/** 名前の頭に付く動画の別名と、その走査範囲（較正を本線と揃えるために要る）。 */
const VIDEOS: Record<string, { path: string; from: number; to: number }> = {
  v1: { path: 'data/videos/fQR9Fx7DOvk.mp4', from: 0, to: 1833 },
  v2: { path: 'data/videos/WuXYIqUGOiE.mp4', from: 0, to: 2120 },
};

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const ALL: PieceKind[] = Object.keys(NAMES) as PieceKind[];
const label = (kind: PieceKind, side: Side) => `${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}`;
const med = (vs: number[]) => [...vs].sort((a, b) => a - b)[vs.length >> 1];

// --- 動画ごとに、本線と同じ較正で盤を切り出せるようにする ---
const boards = new Map<string, (sec: number) => GrayImage>();
for (const [tag, v] of Object.entries(VIDEOS)) {
  const points = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
  const cal = calibrateFromFrames(
    Array.from({ length: points }, (_, i) => v.from + 1 + ((v.to - v.from - 2) * i) / (points - 1))
      .filter((s) => s > 0)
      .map((s) => grabFrame(v.path, Math.round(s), SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
    SHOGI_WARS_VERTICAL,
  );
  const geo = cal?.geo ?? SHOGI_WARS_VERTICAL;
  boards.set(tag, (sec) => crop(grabFrame(v.path, sec, geo.frameW, geo.frameH), boardRect(geo)));
}

// --- 選択リストを絵に直す ---
const PLAIN_RE = /^(\w+):(\d+)-(sente|gote)-([A-Z])$/;
const PROM_RE = /^(\w+):g\d+-(\d+)-(sente|gote)-p([A-Z])-\d[a-i]$/;
const collected = new Map<string, GrayImage[]>();
const lines = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
console.log(`# 選択 ${lines.length} 枚`);
for (const line of lines) {
  const plain = line.match(PLAIN_RE);
  const prom = line.match(PROM_RE);
  const m = plain ?? prom;
  if (!m) throw new Error(`読めない行: ${line}`);
  const [, tag, tenths, side, letter] = m;
  const grab = boards.get(tag);
  if (!grab) throw new Error(`知らない動画: ${tag}`);
  const board = grab(Number(tenths) / 10);
  const kind = (plain ? letter : `+${letter}`) as PieceKind;
  let img: GrayImage;
  if (plain) {
    // 🔒 生駒は初期局面から起こす（ラベルが並びから決まる経路をそのまま使う）
    const t = extractTemplates(board).find((x) => x.kind === kind && x.side === side);
    if (!t) throw new Error(`${line}: 起こせなかった`);
    img = t.img;
  } else {
    const square = line.slice(-2);
    const col = 9 - Number(square[0]);
    const row = square.charCodeAt(1) - 97;
    img = cellImage(board, row, col);
  }
  const key = `${side}-${kind}`;
  collected.set(key, [...(collected.get(key) ?? []), img]);
}

function average(images: GrayImage[]): GrayImage {
  if (images.length === 1) return images[0];
  const { width, height } = images[0];
  const sum = new Float64Array(width * height);
  for (const im of images) {
    const a = resample(im, width, height);
    for (let i = 0; i < sum.length; i++) sum[i] += a.data[i];
  }
  return { width, height, data: Uint8Array.from(sum, (v) => Math.round(v / images.length)) };
}

const made: Template[] = [];
for (const [key, imgs] of collected) {
  const [side, kind] = [key.slice(0, key.indexOf('-')) as Side, key.slice(key.indexOf('-') + 1) as PieceKind];
  made.push({ kind, side, samples: imgs.length, img: average(imgs) });
}
console.log(`  → ${made.length} 種（${made.map((t) => `${label(t.kind, t.side)}${t.samples > 1 ? `×${t.samples}` : ''}`).join(' ')}）`);

// --- 🔒 回転が成り立つかを、両向きそろっている駒で測る ---
console.log('\n# 🔒 回転のずれを測る（両向きそろっている駒だけで）');
const shifts: { dx: number; dy: number; score: number }[] = [];
for (const s of made.filter((t) => t.side === 'sente')) {
  const g = made.find((t) => t.kind === s.kind && t.side === 'gote');
  if (!g || g.img.width !== s.img.width || g.img.height !== s.img.height) continue;
  const best = bestSubpixelShiftNcc(g.img, rotate180(s.img), 8);
  shifts.push(best);
  console.log(`  ${NAMES[s.kind]}: ずれ (${best.dx.toFixed(2)}, ${best.dy.toFixed(2)})  NCC ${best.score.toFixed(3)}`);
}
const rotDx = med(shifts.map((s) => s.dx));
const rotDy = med(shifts.map((s) => s.dy));
const rotScore = med(shifts.map((s) => s.score));
console.log(`  → 中央値 (${rotDx.toFixed(2)}, ${rotDy.toFixed(2)})  一致度 ${rotScore.toFixed(3)}`);

// 🔒 成駒でも成り立つか。生駒 8 種は字が単純なので、成駒で確かめないと足りない。
const promPairs = made.filter((t) => t.side === 'sente' && t.kind.startsWith('+'))
  .map((s) => ({ s, g: made.find((t) => t.kind === s.kind && t.side === 'gote') }))
  .filter((p): p is { s: Template; g: Template } => !!p.g);
//
// ⚠ **中央値を当てて確かめること。** その駒専用の最良ずれで測ると、当然よく合う。
// だが片向きしか無い駒には専用のずれが測れない（測れないから回すのである）。
// **実際に使うのは中央値**なので、中央値で成り立つかを見なければ意味がない。
console.log('\n# 🔒 裏取り: 成駒でも「中央値のずれで回せば一致する」か');
let rotOk = promPairs.length > 0;
for (const { s, g } of promPairs) {
  const derived = shiftImage(rotate180(s.img), rotDx, rotDy);
  const score = ncc(resample(derived, g.img.width, g.img.height), g.img);
  const own = bestSubpixelShiftNcc(resample(g.img, s.img.width, s.img.height), rotate180(s.img), 8);
  const ok = score >= 0.9;
  if (!ok) rotOk = false;
  console.log(
    `  ${label(s.kind, 'sente')} を回して ${label(s.kind, 'gote')} に: 中央値で ${score.toFixed(3)}` +
      `（この駒専用のずれ (${own.dx.toFixed(1)}, ${own.dy.toFixed(1)}) なら ${own.score.toFixed(3)}）  ${ok ? '✅' : '🔴'}`,
  );
}
if (promPairs.length === 0) console.log('  両向きそろった成駒が無いので測れない');

// --- 片向きしか無い成駒を、回して補う ---
if (rotOk) {
  for (const t of [...made]) {
    if (!t.kind.startsWith('+')) continue;
    const other: Side = t.side === 'sente' ? 'gote' : 'sente';
    if (made.some((x) => x.kind === t.kind && x.side === other)) continue;
    // 逆向きも同じずれ量でよいことは上で測った関係から従う（回転は対合）。
    made.push({ kind: t.kind, side: other, samples: t.samples, img: shiftImage(rotate180(t.img), rotDx, rotDy) });
    console.log(`  ${label(t.kind, other)} を ${label(t.kind, t.side)} から回して作った`);
  }
} else {
  console.log('\n⚠ 回転の裏取りに失敗したので、回して補うのはやめる');
}

// --- 足りない駒種は、いまの保存済みから引き継ぐ ---
const before = loadTemplates(STORE_IN) ?? [];
const kept: Template[] = [];
for (const t of before) {
  if (made.some((x) => x.kind === t.kind && x.side === t.side)) continue;
  kept.push(t);
}
console.log(`\n# 引き継ぎ: ${kept.length} 種（${kept.map((t) => `${label(t.kind, t.side)} ${t.img.width}x${t.img.height}`).join(' / ') || 'なし'}）`);

const final = [...made, ...kept];
const missing = ALL.flatMap((k) => (['sente', 'gote'] as Side[]).map((s) => ({ k, s })))
  .filter(({ k, s }) => !final.some((t) => t.kind === k && t.side === s));
if (missing.length > 0) {
  console.error(`\n🔴 揃っていない: ${missing.map(({ k, s }) => label(k, s)).join(' ')}`);
  process.exit(1);
}

// --- 🔒 検証: 生駒自身のマスを横取りしないか ---
//
// ラベルが誤っている（＝実は別の駒の写しである）なら、その駒の本物のマスに対して
// 本物より高い点を出すはず。材料は初期局面に全部ある。相関の絶対値ではなく
// 「横取り」を見る方が直接的で、似た字（金と全）を誤って弾かずに済む。
console.log('\n# 🔒 検証: 生駒自身のマスを横取りしないか');
const refBoard = boards.get('v1')!(2.5);
const { board: initial } = createInitialState();
const cells: { row: number; col: number; kind: PieceKind; side: Side }[] = [];
for (let r = 0; r < 9; r++) {
  for (let c = 0; c < 9; c++) {
    const p = initial[r][c];
    if (p) cells.push({ row: r, col: c, kind: p.kind, side: p.side });
  }
}
let ng = 0;
for (const t of final.filter((x) => x.kind.startsWith('+'))) {
  let worst = { margin: Infinity, at: '', real: 0, mine: 0 };
  for (const c of cells) {
    const real = cellImage(refBoard, c.row, c.col);
    const own = final.find((x) => x.kind === c.kind && x.side === c.side)!;
    const realScore = ncc(resample(own.img, real.width, real.height), real);
    const mineScore = ncc(resample(t.img, real.width, real.height), real);
    if (realScore - mineScore < worst.margin) {
      worst = { margin: realScore - mineScore, at: `${label(c.kind, c.side)} ${9 - c.col}${String.fromCharCode(97 + c.row)}`, real: realScore, mine: mineScore };
    }
  }
  const stolen = worst.margin <= 0;
  if (stolen) ng++;
  console.log(
    `  ${label(t.kind, t.side)}: いちばん際どいのは ${worst.at}` +
      `（本物 ${worst.real.toFixed(3)} vs これ ${worst.mine.toFixed(3)}・差 ${worst.margin.toFixed(3)}）${stolen ? '  🔴 横取り' : ''}`,
  );
}
if (ng > 0) {
  console.error(`\n🔴 横取りするテンプレートが ${ng} 種ある。保存しない。`);
  process.exit(1);
}

const sizes = new Map<string, number>();
for (const t of final) {
  const k = `${t.img.width}x${t.img.height}`;
  sizes.set(k, (sizes.get(k) ?? 0) + 1);
}
console.log(`\n# ${final.length} 種  寸法: ${[...sizes].map(([k, n]) => `${k} × ${n}`).join(' / ')}`);
if (!SAVE) {
  console.log('# 確認のみ（保存するには KIFU_VISION_SAVE=1）');
} else {
  saveTemplates(final, STORE_OUT);
  console.log(`# 保存した → ${STORE_OUT}`);
}
