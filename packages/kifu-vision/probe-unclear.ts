// 「駒があるか決まらなかった（unclear）」マスが、照合ではどう出るかを測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-unclear.ts <動画パス> [開始秒] [終了秒] [間隔秒]
//
// 🔴 見たいのは「未確定のまま捨てているマスの中に、**照合では決まっているもの**が
// どれだけ混ざっているか」。実測（20:57 の 3e・打たれた歩が白く光っている）では
// `sd=18.8` で門に落ちる一方、照合は ▽歩 0.829 に対して 2 位 0.330 だった。
// **駒種は決まっているのに、その手前で捨てている。**
//
// 閾値を決めるために、山が 2 つに分かれるかを見る。分かれないなら、
// この道は使えない（当てずっぽうを盤に乗せることになる）。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { recognizeBoard } from './src/recognize.ts';
import { cellImage, classify, extractTemplates } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames, calibrateGeometry, isCalibrationTrustworthy } from './src/calibrate.ts';
import { occupancyDistance, INITIAL_OCCUPANCY } from './src/occupancy.ts';
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

// --- テンプレート ---
const coarse = await findSegments(video, geo, 1, 4);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
if (initials.length === 0) { console.error('初期局面が見つからない'); process.exit(1); }
const seg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const fromInitial = extractTemplates(grabBoard(seg.representativeTime));
const stored = loadTemplates(TEMPLATE_STORE, { width: fromInitial[0].img.width, height: fromInitial[0].img.height });
const templates = stored ? mergeTemplates(fromInitial, stored) : fromInitial;
console.log(`# テンプレート ${templates.length} 種`);

interface Hit { time: number; square: string; score: number; margin: number; label: string }
const hits: Hit[] = [];
let frames = 0;
let offBoard = 0;

for (let t = fromSec; t <= toSec; t += stepSec) {
  const frame = grabFrame(video, t, geo.frameW, geo.frameH);
  if (!isCalibrationTrustworthy(calibrateGeometry(frame, geo))) { offBoard++; continue; }
  frames++;
  const board = crop(frame, boardRect(geo));
  const rec = recognizeBoard(board, templates);
  for (const c of rec.lowConfidence) {
    if (!c.covered) continue; // ポインタは別の話。ここでは「覆われた」だけを見る
    const match = classify(cellImage(board, c.row, c.col), templates);
    if (!match) continue;
    hits.push({
      time: t,
      square: `${9 - c.col}${String.fromCharCode(97 + c.row)}`,
      score: match.score,
      margin: match.margin,
      label: `${match.template.side === 'sente' ? '▲' : '▽'}${match.template.kind}`,
    });
  }
}

console.log(`\n# ${frames} 枚を読んだ（盤が写っていないので飛ばした: ${offBoard}）`);
console.log(`# 未確定（覆われた）マス: ${hits.length}`);

const histogram = (label: string, values: number[], step: number) => {
  console.log(`\n## ${label}`);
  const buckets = new Map<number, number>();
  for (const v of values) {
    const b = Math.floor(v / step) * step;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  for (const b of [...buckets.keys()].sort((a, b) => a - b)) {
    const n = buckets.get(b)!;
    console.log(`  ${b.toFixed(2)}〜${(b + step).toFixed(2)}  ${String(n).padStart(5)}  ${'#'.repeat(Math.min(60, Math.ceil(n / Math.max(1, hits.length / 300))))}`);
  }
};

histogram('照合 1 位の NCC', hits.map((h) => h.score), 0.1);
histogram('1 位と 2 位の差', hits.map((h) => h.margin), 0.1);

const decisive = hits.filter((h) => h.score >= 0.7 && h.margin >= 0.25);
console.log(`\n# 決まっているように見えるマス（NCC>=0.70 かつ 差>=0.25）: ${decisive.length}`);
for (const h of decisive.sort((a, b) => b.score - a.score).slice(0, 40)) {
  console.log(`  ${fmt(h.time)} ${h.square} ${h.label}  NCC ${h.score.toFixed(3)}  差 ${h.margin.toFixed(3)}`);
}
