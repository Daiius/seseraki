// 駒字の**赤さ**が成駒と生駒でどれだけ分かれるかを、動画全体で測る。
//
//   pnpm --filter kifu-vision exec tsx probe-ink-color.ts <動画パス> <開始秒> <終了秒> [刻み秒]
//
// ⭐ 照合はグレースケールなので、`金` と `全` のように**字が似ている組**は
// 形では割り切れない（実測 0.70〜0.81 相関・追記 62）。**成駒は朱・生駒は黒**なので、
// 色は完全に独立した証拠になる。
//
// 🔒 **閾値はここで測ってから決める。** 山が 2 つに割れて谷ができるなら線を引ける。
// 割れないなら、この手は使えないということ。**「それらしい」で通さない。**
//
// ⚠ ラベルは照合の 1 位なので**誤読も混ざる**。見たいのは 2 つの集団が割れるかで、
// 誤読はむしろ谷や逆側に落ちる（金を全と読んだマスは赤くない）。それが分かるように、
// 成駒と読めたマスは時刻とマスを控えて目視できるようにしてある。

import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, grabFrameYuv, yuvGray, cropYuv, crop } from './src/frame.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { cellImage, classify, extractTemplates, MATCH_INSET, type Template } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { occupancy } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { occupancyDistance, INITIAL_OCCUPANCY } from './src/occupancy.ts';
import { inkRedness, isPromotedKind } from './src/ink.ts';
import type { YuvImage } from './src/frame.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 60);
const stepSec = Number(process.argv[5] ?? 2);
const TEMPLATE_STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
if (!video) {
  console.error('使い方: probe-ink-color.ts <動画パス> <開始秒> <終了秒> [刻み秒]');
  process.exit(1);
}

const NAMES: Record<string, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

// --- 較正とテンプレート（本線と同じ手順で揃える） ---
const CAL_POINTS = 9;
const calSeconds = Array.from(
  { length: CAL_POINTS },
  (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1),
).filter((s) => s > 0).map((s) => Math.round(s));
const calibration = calibrateFromFrames(
  calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
const rect = boardRect(geo);
console.log(`# ${fromSec}〜${toSec} 秒を ${stepSec} 秒刻み（較正 ${calibration ? `${calibration.used}/${calibration.tried} 枚` : 'なし'}）`);

const coarse = await findSegments(video, geo, 1, 4);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
if (initials.length === 0) {
  console.error('初期局面が見つからないためテンプレートを作れません');
  process.exit(1);
}
const seg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const fromInitial = extractTemplates(crop(grabFrame(video, seg.representativeTime, geo.frameW, geo.frameH), rect));
const cellSize = { width: fromInitial[0].img.width, height: fromInitial[0].img.height };
const stored = loadTemplates(TEMPLATE_STORE, cellSize);
const templates: Template[] = stored ? mergeTemplates(fromInitial, stored) : fromInitial;
console.log(`  テンプレート ${templates.length} 種（成駒 ${templates.filter((t) => isPromotedKind(t.kind)).length} 種）`);

/** 色のマスを、`cellImage` とまったく同じ切り取り方で取る。 */
function colorCell(board: YuvImage, row: number, col: number): YuvImage {
  const cw = board.width / 9;
  const ch = board.height / 9;
  const w = Math.floor(cw * (1 - MATCH_INSET * 2));
  const h = Math.floor(ch * (1 - MATCH_INSET * 2));
  const x = Math.round(cw * col + cw * MATCH_INSET);
  const y = Math.round(ch * row + ch * MATCH_INSET);
  return cropYuv(board, { x, y, w, h });
}

const promoted: number[] = [];
const plain: number[] = [];
const promotedSamples: string[] = [];

for (let t = fromSec; t <= toSec; t += stepSec) {
  let color: YuvImage;
  try {
    color = grabFrameYuv(video, t, geo.frameW, geo.frameH);
  } catch {
    continue;
  }
  const boardColor = cropYuv(color, rect);
  const board = yuvGray(boardColor);
  const occ = occupancy(board);

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (!occ[row][col]) continue; // 駒が無いマスでは測れない（ink.ts の注意）
      const match = classify(cellImage(board, row, col), templates);
      if (!match || match.score < 0.6) continue;
      const { ratio } = inkRedness(colorCell(boardColor, row, col));
      if (!Number.isFinite(ratio)) continue;
      if (isPromotedKind(match.template.kind)) {
        promoted.push(ratio);
        if (promotedSamples.length < 40) {
          promotedSamples.push(
            `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} ` +
              `${9 - col}${String.fromCharCode(97 + row)} ` +
              `${match.template.side === 'sente' ? '▲' : '▽'}${NAMES[match.template.kind]} ` +
              `NCC ${match.score.toFixed(3)} 赤み ${ratio.toFixed(3)}`,
          );
        }
      } else {
        plain.push(ratio);
      }
    }
  }
}

function histogram(xs: number[], label: string) {
  console.log(`\n## ${label}（${xs.length} マス）`);
  if (xs.length === 0) return;
  const bins = new Map<number, number>();
  for (const x of xs) {
    const b = Math.round(Math.floor(x * 10)) / 10;
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const scale = Math.max(1, xs.length / 300);
  for (const b of [...bins.keys()].sort((a, c) => a - c)) {
    const n = bins.get(b)!;
    console.log(`  ${b.toFixed(1)}〜${(b + 0.1).toFixed(1)} ${String(n).padStart(6)}  ${'#'.repeat(Math.min(60, Math.ceil(n / scale)))}`);
  }
  const sorted = [...xs].sort((a, c) => a - c);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log(`  最小 ${sorted[0].toFixed(3)} / 5% ${q(0.05).toFixed(3)} / 中央 ${q(0.5).toFixed(3)} / 95% ${q(0.95).toFixed(3)} / 最大 ${sorted[sorted.length - 1].toFixed(3)}`);
}

histogram(plain, '生駒と読めたマスの赤み');
histogram(promoted, '成駒と読めたマスの赤み');

if (promotedSamples.length) {
  console.log('\n## 成駒と読めたマスの例（目視で確かめる用）');
  for (const s of promotedSamples) console.log(`  ${s}`);
}

if (promoted.length && plain.length) {
  const all = [...plain, ...promoted].sort((a, b) => a - b);
  let best = { at: NaN, count: Infinity };
  for (let x = 0.4; x <= 1.4; x += 0.02) {
    const n = all.filter((v) => v >= x - 0.05 && v < x + 0.05).length;
    if (n < best.count) best = { at: x, count: n };
  }
  console.log(`\n谷は ${best.at.toFixed(2)} 付近（±0.05 に ${best.count} マス / 全 ${all.length}）`);
}
