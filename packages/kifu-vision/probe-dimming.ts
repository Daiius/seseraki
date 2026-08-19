// 盤が暗くなっている区間を、時刻方向に探す（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-dimming.ts <動画パス> [開始秒] [終了秒]
//
// ⭐ **狙い**（2026-08-18 ユーザ指摘・追記 158）:
// このアプリは**自分の駒を掴むと背景が暗くなり、移動可能なマスがハイライトされる**。
// 通常は一瞬だが、**指し手に迷うと長く出たまま**になる。
//
// 🔴 空きマスにハイライトが乗れば「駒がある」と読める（追記 149「空マスが駒ありに
// 見える経路」と同じ的）。**いままで一度も考慮していない失敗源。**
//
// ⭐ **1 マスごとの推測より扱いやすい。盤全体が暗くなるので大域的に測れる。**
// ここでは盤の平均輝度を 1 秒ごとに取り、中央値からの落ち込みを区間として出す。
//
// 🔒 **これは「暗い区間があるか」を見るだけの道具。** 何もしないことも答えのうち
// （谷が無ければ、この動画にその表示は写っていない）。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { openFrameStream, probeFrameRate, yuvGray, cropYuv } from './src/frame.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? Number.POSITIVE_INFINITY);
if (!video) {
  console.error('使い方: probe-dimming.ts <動画パス> [開始秒] [終了秒]');
  process.exit(1);
}

const geo = SHOGI_WARS_VERTICAL;
const rect = boardRect(geo);
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const rate = probeFrameRate(video);
const fps = rate.num / rate.den;
const stride = Math.max(1, Math.round(fps)); // 1 秒に 1 枚

const stream = openFrameStream(video, geo.frameW, geo.frameH, stride, {
  startSec: fromSec,
  durationSec: Number.isFinite(toSec) ? toSec - fromSec : undefined,
});

interface Sample {
  t: number;
  mean: number;
}
const samples: Sample[] = [];

for (let i = 0; ; i++) {
  const frame = await stream.next();
  if (!frame) break;
  const gray = yuvGray(cropYuv(frame, rect));
  let sum = 0;
  for (const v of gray.data) sum += v;
  samples.push({ t: fromSec + (i * stride) / fps, mean: sum / gray.data.length });
}
stream.close();

if (samples.length === 0) {
  console.log('フレームを読めませんでした');
  process.exit(0);
}

const sorted = [...samples].map((s) => s.mean).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const p05 = sorted[Math.floor(sorted.length * 0.05)];
const p95 = sorted[Math.floor(sorted.length * 0.95)];

console.log(`# ${samples.length} 秒ぶんを読んだ（盤 ${rect.w}x${rect.h}）`);
console.log(`  平均輝度: 中央値 ${median.toFixed(1)} / 下位 5% ${p05.toFixed(1)} / 上位 5% ${p95.toFixed(1)}`);

// 中央値から目に見えて落ちている点を「暗い」とみなす。
// ⚠ しきい値は当て推量。**まず分布を見て、谷があるかどうかを判断するための道具**。
const THRESHOLD = Number(process.env.KIFU_VISION_DIM_DROP ?? 12);
const dark = samples.filter((s) => median - s.mean >= THRESHOLD);
console.log(`  中央値より ${THRESHOLD} 以上暗い秒: ${dark.length} / ${samples.length}`);

// 連続する秒をまとめて区間にする
const runs: { from: number; to: number; min: number }[] = [];
for (const s of dark) {
  const last = runs[runs.length - 1];
  if (last && s.t - last.to <= stride / fps + 0.001) {
    last.to = s.t;
    last.min = Math.min(last.min, s.mean);
  } else {
    runs.push({ from: s.t, to: s.t, min: s.mean });
  }
}
if (runs.length > 0) {
  console.log(`\n  暗い区間（${runs.length} 本）:`);
  for (const r of runs) {
    const secs = Math.round(r.to - r.from) + 1;
    console.log(
      `    ${fmt(r.from)}〜${fmt(r.to)}  ${String(secs).padStart(3)} 秒  最も暗いとき ${r.min.toFixed(1)}` +
        `（中央値 -${(median - r.min).toFixed(1)}）`,
    );
  }
}

// 分布そのものも出す。谷が 2 つに割れているなら、しきい値は谷底から決められる。
console.log('\n  平均輝度の分布:');
const lo = Math.floor(sorted[0]);
const hi = Math.ceil(sorted[sorted.length - 1]);
const bins = 20;
const width = (hi - lo) / bins || 1;
for (let b = 0; b < bins; b++) {
  const from = lo + b * width;
  const n = samples.filter((s) => s.mean >= from && s.mean < from + width).length;
  if (n === 0) continue;
  console.log(`    ${from.toFixed(0).padStart(4)}〜${(from + width).toFixed(0).padEnd(4)} ${'#'.repeat(Math.min(60, n))} ${n}`);
}
