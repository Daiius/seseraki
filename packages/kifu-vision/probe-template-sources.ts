// 採取源になりうる初期局面を全部集めて、起こした駒の絵を目視できる形に出す（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-template-sources.ts <動画> <開始秒> <終了秒> <出力先> [追加の秒...]
//
// 🔒 **初期局面であることを毎回確かめてから起こす。** ラベルは初期配置から自明という
// 前提でしか正しくないので、1 手でも進んでいたら全部ずれる。
//
// 🔒 **後手の駒は 180 度回して書き出す**（`-view` 付き）。`と`→`ス` に見えるので、
// 回さずに眺めると誤ラベルを平気で通す。人が見るのは回した方。
import { mkdirSync, writeFileSync } from 'node:fs';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { extractTemplates, ncc, resample, rotate180 } from './src/template.ts';
import { loadTemplates } from './src/template-store.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { findSegments } from './src/segments.ts';
import { occupancy, occupancyDistance } from './src/occupancy.ts';
import { createInitialState } from 'shared';

const video = process.argv[2];
const fromSec = Number(process.argv[3]);
const toSec = Number(process.argv[4]);
const outDir = process.argv[5];
const extraTimes = process.argv.slice(6).map(Number);
const STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';

const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calSeconds = Array.from(
  { length: CAL_POINTS },
  (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1),
)
  .filter((s) => s > 0)
  .map((s) => Math.round(s));
const calibration = calibrateFromFrames(
  calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const { board: initialBoard } = createInitialState();
const INITIAL_OCCUPANCY = initialBoard.map((r) => r.map((c) => c !== null));

const coarse = await findSegments(video, geo, 1, 4);
const found = coarse
  .filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0)
  .map((s) => s.representativeTime);
const times = [...new Set([...found, ...extraTimes])].sort((a, b) => a - b);

mkdirSync(outDir, { recursive: true });
const writePgm = (name: string, img: { width: number; height: number; data: Uint8Array }) => {
  const head = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  writeFileSync(`${outDir}/${name}.pgm`, Buffer.concat([head, Buffer.from(img.data)]));
};

const canon = loadTemplates(STORE) ?? [];
const rows: unknown[] = [];

for (const at of times) {
  const board = grabBoard(at);
  // 🔒 その時刻が本当に初期局面か。1 手でも進んでいたらラベルが全部ずれる。
  const dist = occupancyDistance(occupancy(board), INITIAL_OCCUPANCY);
  if (dist !== 0) {
    rows.push({ at, skipped: `初期局面ではない（有無が ${dist} マス違う）` });
    continue;
  }
  const plain = extractTemplates(board);
  for (const t of plain) {
    const others = plain.filter((o) => o !== t);
    const top = others.map((o) => ({ o, s: ncc(o.img, t.img) })).sort((a, b) => b.s - a.s)[0];
    const c = canon.find((x) => x.kind === t.kind && x.side === t.side);
    const agree = c ? ncc(resample(c.img, t.img.width, t.img.height), t.img) : null;
    const name = `${Math.round(at * 10)}-${t.side}-${t.kind.replace('+', 'p')}`;
    writePgm(name, t.img);
    // 人が読める向き（後手は回す）
    writePgm(`${name}-view`, t.side === 'gote' ? rotate180(t.img) : t.img);
    rows.push({
      at, kind: t.kind, side: t.side, name,
      w: t.img.width, h: t.img.height,
      sep: Number(top.s.toFixed(4)),
      sepWith: `${top.o.side === 'sente' ? '▲' : '▽'}${top.o.kind}`,
      agree: agree === null ? null : Number(agree.toFixed(4)),
    });
  }
}

writeFileSync(`${outDir}/index.json`, JSON.stringify({ video, geo, times, rows }, null, 2));
console.log(`# ${video}  初期局面 ${times.map((t) => t.toFixed(1)).join(', ')} 秒  → ${outDir}`);
