// マスの平均色の変化から「手が指された瞬間」を拾えるか調べる。
//
// 駒の有無（輝度の散らばり）で切ると、マウスポインタが空マスに重なるたびに
// 偽の変化が立ってしまう。マスの平均色ならポインタの面積が小さく効かないうえ、
// 指した手のマスにはオレンジのハイライトが付くので、むしろ信号が強い。
//
//   pnpm --filter kifu-vision exec tsx probe-color-events.ts <動画パス> [開始秒] [長さ秒] [fps]
import { SHOGI_WARS_VERTICAL } from './src/geometry.ts';
import { streamBoardCellColors } from './src/frame.ts';

const video = process.argv[2];
const startSec = Number(process.argv[3] ?? 100);
const durationSec = Number(process.argv[4] ?? 200);
const fps = Number(process.argv[5] ?? 10);
const geo = SHOGI_WARS_VERTICAL;

/** これ以上の色差があるマスは「変わった」と見なす。実測のノイズは 0〜1。 */
const CELL_DIFF_THRESHOLD = 8;
/** この数だけ変化が無ければ、局面が落ち着いたと見なす */
const SETTLE_FRAMES = Math.max(2, Math.round(fps * 0.3));

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const cellDiff = (a: Uint8Array, b: Uint8Array, i: number) =>
  Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]);

const frames: Uint8Array[] = [];
await streamBoardCellColors(video, geo, fps, (cells) => frames.push(cells), {
  startSec,
  durationSec,
});
console.log(`# ${frames.length} フレーム（${fps}fps）を取得。1 フレーム ${9 * 9 * 3} バイト`);

// 直前の「落ち着いた状態」と比べ続け、変化が収まったところで次の状態を確定する
interface Event {
  time: number;
  cells: string[];
}
const events: Event[] = [];
let settled = frames[0];
let settledAt = 0;
let quiet = 0;

for (let i = 1; i < frames.length; i++) {
  const changed: number[] = [];
  for (let c = 0; c < 81; c++) {
    if (cellDiff(settled, frames[i], c) > CELL_DIFF_THRESHOLD) changed.push(c);
  }

  if (changed.length === 0) {
    quiet++;
    continue;
  }

  // 変化が出た。落ち着くまで待つ。
  let j = i;
  let stableFor = 0;
  let last = frames[i];
  while (j + 1 < frames.length && stableFor < SETTLE_FRAMES) {
    j++;
    let moved = false;
    for (let c = 0; c < 81; c++) {
      if (cellDiff(last, frames[j], c) > CELL_DIFF_THRESHOLD) { moved = true; break; }
    }
    stableFor = moved ? 0 : stableFor + 1;
    last = frames[j];
  }

  const finalChanged: number[] = [];
  for (let c = 0; c < 81; c++) {
    if (cellDiff(settled, last, c) > CELL_DIFF_THRESHOLD) finalChanged.push(c);
  }
  if (finalChanged.length > 0) {
    events.push({
      time: startSec + j / fps,
      cells: finalChanged.map((c) => `${9 - (c % 9)}${String.fromCharCode(97 + Math.floor(c / 9))}`),
    });
  }
  settled = last;
  settledAt = j;
  i = j;
}

console.log(`\n# 検出したイベント: ${events.length} 件`);
const byCount = new Map<number, number>();
for (const e of events) byCount.set(e.cells.length, (byCount.get(e.cells.length) ?? 0) + 1);
console.log('# 変化したマス数の内訳:');
for (const [n, c] of [...byCount].sort((a, b) => a[0] - b[0])) {
  const note = n === 1 ? '（ハイライトの点灯/消灯か、駒を取る手）' : n === 2 ? '（移動元＋移動先＝1 手らしい）' : n >= 10 ? '（場面転換）' : '';
  console.log(`    ${String(n).padStart(2)} マス: ${c} 件 ${note}`);
}

console.log('\n# 最初の 40 件');
for (const e of events.slice(0, 40)) {
  console.log(`  ${fmt(e.time).padStart(7)}  ${e.cells.length} マス: ${e.cells.slice(0, 6).join(' ')}${e.cells.length > 6 ? ' ...' : ''}`);
}

const interval = events.length > 1 ? (events.at(-1)!.time - events[0].time) / (events.length - 1) : NaN;
console.log(`\n# イベントの平均間隔: ${interval.toFixed(2)} 秒`);
