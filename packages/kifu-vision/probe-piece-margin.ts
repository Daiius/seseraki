// 「駒あり」と判定して**盤に置いた**マスが、照合でどれだけ決まっているかを測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-piece-margin.ts <動画パス> [開始秒] [終了秒] [間隔秒]
//
// 🔴 見たいのは「sd の門を通って盤に置かれたマスの中に、**駒種が決まっていないもの**が
// どれだけ混ざっているか」。実測（2 本目 16:37 の 4e）では、マウスポインタが角に
// 掛かっただけのマスが sd=32.6 で門を通り、▽角 0.467 対 ▽銀 0.454 で**盤に置かれた**。
// 差は 0.013——決まっていない。そこから偽の `B*4e` が生まれ、以降が総崩れになった。
//
// ⚠ 通常経路（`p === 'piece'`）は **NCC の 1 位しか見ていない**（`UNKNOWN_NCC_THRESHOLD`）。
// 覆われた経路には既に「2 位との差」を見る門（`COVERED_MARGIN_THRESHOLD`）があるのに、
// いちばん普通の経路にだけ無い。**山が 2 つに割れるなら、そこに線を引ける。**
import { writeFileSync } from 'node:fs';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, grabFrameYuv, yuvGray, cropYuv, crop } from './src/frame.ts';
import { recognizeBoard } from './src/recognize.ts';
import { cellImage, extractTemplates } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames, calibrateGeometry, isCalibrationTrustworthy } from './src/calibrate.ts';
import { occupancyDistance, INITIAL_OCCUPANCY, presence, hasPointer } from './src/occupancy.ts';
import { isUnknown } from './src/uncertain.ts';
import { findSegments } from './src/segments.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 300);
const stepSec = Number(process.argv[5] ?? 0.5);
const TEMPLATE_STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// --- 較正（extract-simple と同じ撒き方にする。範囲を変えると結果が変わるため） ---
const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calSeconds = Array.from(
  { length: CAL_POINTS },
  (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1),
).filter((s) => s > 0).map((s) => Math.round(s));
const calibration = calibrateFromFrames(
  calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
console.log(`# 較正: ${calibration ? `ずれ (${calibration.shift.x.toFixed(2)}, ${calibration.shift.y.toFixed(2)})` : 'できず'}`);

const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const coarse = await findSegments(video, geo, 1, 4);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
if (initials.length === 0) { console.error('初期局面が見つからない'); process.exit(1); }
const seg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const fromInitial = extractTemplates(grabBoard(seg.representativeTime));
const stored = loadTemplates(TEMPLATE_STORE, { width: fromInitial[0].img.width, height: fromInitial[0].img.height });
const templates = stored ? mergeTemplates(fromInitial, stored) : fromInitial;
console.log(`# テンプレート ${templates.length} 種`);

interface Hit { time: number; square: string; sd: number; score: number; margin: number; label: string }
const hits: Hit[] = [];
let frames = 0;
let offBoard = 0;

for (let t = fromSec; t <= toSec; t += stepSec) {
  const colorFrame = grabFrameYuv(video, t, geo.frameW, geo.frameH);
  const frame = yuvGray(colorFrame);
  if (!isCalibrationTrustworthy(calibrateGeometry(frame, geo))) { offBoard++; continue; }
  frames++;
  const board = crop(frame, boardRect(geo));
  // 🔒 **本線とまったく同じ読み方で測る。** 自分で `classify` を呼び直すと、
  // 成駒の色検算（`classifyWithInk`）を通らないぶん紛れが水増しされる
  // （最初はそれをやって、金⇔全が差 0.000 で 2612 件出た）。
  const rec = recognizeBoard(board, templates, { colorBoard: cropYuv(colorFrame, boardRect(geo)) });
  const pres = presence(board);
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      // 見たいのは「sd の門を通って**盤に置かれた**マス」だけ。
      // 覆われた経路（`unclear` / ポインタ）は既に別の門を持っている。
      if (pres[row][col] !== 'piece') continue;
      if (hasPointer(cellImage(board, row, col))) continue;
      const piece = rec.board[row][col];
      if (isUnknown(piece) || !piece) continue;
      const cell = rec.cells[row][col];
      hits.push({
        time: t,
        square: `${9 - col}${String.fromCharCode(97 + row)}`,
        sd: 0,
        score: cell.score,
        margin: cell.margin,
        label: `${piece.side === 'sente' ? '▲' : '▽'}${piece.kind}`,
      });
    }
  }
}

console.log(`\n# ${frames} 枚を読んだ（盤が写っていないので飛ばした: ${offBoard}）`);
console.log(`# 盤に置かれたマス: ${hits.length}`);

const histogram = (label: string, values: number[], step: number) => {
  console.log(`\n## ${label}`);
  const buckets = new Map<number, number>();
  for (const v of values) {
    const b = Math.floor(v / step) * step;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const max = Math.max(...buckets.values());
  for (const b of [...buckets.keys()].sort((a, b) => a - b)) {
    const n = buckets.get(b)!;
    console.log(`  ${b.toFixed(2)}〜${(b + step).toFixed(2)}  ${String(n).padStart(6)}  ${'#'.repeat(Math.max(1, Math.round((n / max) * 60)))}`);
  }
};

histogram('照合 1 位の NCC', hits.map((h) => h.score), 0.05);
histogram('1 位と 2 位の差', hits.map((h) => h.margin), 0.05);

// ⭐ **1 次元では割れない。** 実測（追記 132）: 偽の駒（ポインタ）は NCC 0.467・
// 差 0.013、本物の金（全と紛れる）は NCC 0.815・差 0.028。**差では並ぶが NCC は開く。**
// どちらか一方の閾値では、片方を落とすともう片方も落ちる。**両方を一度に見る。**
console.log('\n## NCC × 差（行=NCC・列=差）');
const scoreBands = [0.45, 0.55, 0.6, 0.7, 0.8, 0.9, 1.01];
const marginBands = [0, 0.02, 0.05, 0.1, 0.15, 0.25, 1.01];
const band = (v: number, bands: number[]) => {
  for (let i = 0; i < bands.length - 1; i++) if (v < bands[i + 1]) return i;
  return bands.length - 2;
};
const grid = scoreBands.slice(0, -1).map(() => marginBands.slice(0, -1).map(() => 0));
for (const h of hits) grid[band(h.score, scoreBands)][band(h.margin, marginBands)]++;
console.log(`  ${'NCC \\ 差'.padEnd(12)}${marginBands.slice(0, -1).map((m, i) => `<${marginBands[i + 1]}`.padStart(9)).join('')}`);
for (let i = 0; i < grid.length; i++) {
  console.log(
    `  ${`${scoreBands[i]}〜${scoreBands[i + 1]}`.padEnd(12)}` +
      grid[i].map((n) => String(n).padStart(9)).join(''),
  );
}

// 生の値を残す。**同じ 8 分の走査を、閾値を変えるたびに繰り返さないため。**
if (process.env.KIFU_VISION_DUMP) {
  writeFileSync(process.env.KIFU_VISION_DUMP, JSON.stringify(hits));
  console.log(`\n# 生の値を書き出した: ${process.env.KIFU_VISION_DUMP}（${hits.length} 件）`);
}

const thin = hits.filter((h) => h.margin < 0.15).sort((a, b) => a.margin - b.margin);
console.log(`\n# 差が 0.15 未満のマス: ${thin.length}（先頭 40 件）`);
for (const h of thin.slice(0, 40)) {
  console.log(`  ${fmt(h.time)} ${h.square} ${h.label}  NCC ${h.score.toFixed(3)}  差 ${h.margin.toFixed(3)}`);
}
