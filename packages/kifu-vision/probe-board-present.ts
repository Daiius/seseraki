// その時刻に「対局中の盤」が写っているかを、格子のくっきりさで測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-board-present.ts <動画パス> <秒> [秒...]
//
// 🔴 見たいのは「終局演出・感想戦・ダイアログの絵を、盤ありの絵と分けられるか」。
// `isCalibrationTrustworthy` は**探索が必ず答えを返す**ことを踏まえて線のはっきりさで
// 足切りする仕組みなので、そのまま場面の切り分けにも使えるはず——を確かめる。
import { SHOGI_WARS_VERTICAL } from './src/geometry.ts';
import { grabFrame } from './src/frame.ts';
import { calibrateGeometry, isCalibrationTrustworthy } from './src/calibrate.ts';

const video = process.argv[2];
const times = process.argv.slice(3).map(Number);
const geo = SHOGI_WARS_VERTICAL;

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.round((t % 1) * 10)}`;

console.log('     時刻     縦     横   盤あり');
for (const t of times) {
  const frame = grabFrame(video, t, geo.frameW, geo.frameH);
  const cal = calibrateGeometry(frame, geo);
  const ok = isCalibrationTrustworthy(cal);
  console.log(
    `  ${fmt(t).padStart(8)}  ${cal.contrast.x.toFixed(1).padStart(5)}  ${cal.contrast.y.toFixed(1).padStart(5)}   ${ok ? '○' : '×'}`,
  );
}
