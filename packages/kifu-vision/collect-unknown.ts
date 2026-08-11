// テンプレートを持っていない駒（成駒とみられる）のマス画像を集める。
//
// 動画の大半で「桂が 5 枚」のように駒数が規定を超えており、テンプレートの無い
// 成駒が別の駒として読まれている。その駒が動いた手は読めないので、中盤以降が
// まるごと欠ける。**成駒テンプレートを手に入れないとこれ以上は伸びない。**
//
// ここでは候補のマスを切り出して PNG に落とすところまでやる。何の駒かは
// 画像を見て決める（`identify-unknown.sh` から claude -p に渡す）。
//
// 似た絵ばかり集めても仕方ないので、既に集めたものと十分違う絵だけ残す。
//
//   pnpm --filter kifu-vision exec tsx collect-unknown.ts <動画パス> [開始秒] [終了秒] [間隔秒]
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { extractTemplates, cellImage, ncc } from './src/template.ts';
import { recognizeBoard } from './src/recognize.ts';
import { overflowCells } from './src/sanity.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 1140);
const stepSec = Number(process.argv[5] ?? 5);
const geo = SHOGI_WARS_VERTICAL;
const OUT_DIR = process.env.KIFU_VISION_UNKNOWN_DIR ?? 'data/unknown';

/** 既に集めた絵とこれ以上似ていたら、同じ駒とみなして捨てる */
const DUP_NCC = 0.9;
/** これだけ集まったら打ち切る（成駒は 6 種 × 2 向きしかない） */
const MAX_SAMPLES = 24;

const fmt = (t: number) => `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

console.log('# 初期局面からテンプレートを作る');
const coarse = await findSegments(video, geo, 1);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
if (initials.length === 0) {
  console.error('初期局面が見つかりません');
  process.exit(1);
}
const templateSeg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const templates = extractTemplates(grabBoard(templateSeg.representativeTime));
console.log(`  ${templates.length} 種（生駒のみ）`);

/** グレースケールを PNG に落とす。ffmpeg に生データを食わせる。 */
function writePng(img: GrayImage, path: string) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      '-s', `${img.width}x${img.height}`,
      '-i', 'pipe:0',
      // 小さいままだと見づらいので 3 倍に伸ばす（補間なし）
      '-vf', 'scale=iw*3:ih*3:flags=neighbor',
      '-y', path,
    ],
    { input: Buffer.from(img.data) },
  );
  if (res.status !== 0) throw new Error(res.stderr.toString());
}

mkdirSync(OUT_DIR, { recursive: true });

interface Sample {
  img: GrayImage;
  at: number;
  usi: string;
  readAs: string;
  score: number;
}
const samples: Sample[] = [];

console.log(`\n# ${fmt(fromSec)}〜${fmt(toSec)} を ${stepSec} 秒間隔で走査`);
for (let t = fromSec; t <= toSec && samples.length < MAX_SAMPLES; t += stepSec) {
  const img = grabBoard(t);
  const recognized = recognizeBoard(img, templates);
  const scores = recognized.cells.map((r) => r.map((c) => c.score));

  // 規定より多い駒種のマス＝テンプレートの無い駒が別の駒として読まれている疑い
  for (const cell of overflowCells(recognized.board, scores)) {
    const piece = recognized.board[cell.row][cell.col];
    if (!piece) continue;
    const cut = cellImage(img, cell.row, cell.col);

    // 既に集めた絵と似ていれば捨てる
    if (samples.some((s) => ncc(s.img, cut) > DUP_NCC)) continue;

    samples.push({
      img: cut,
      at: t,
      usi: `${9 - cell.col}${String.fromCharCode(97 + cell.row)}`,
      readAs: `${piece.side === 'sente' ? 'sente' : 'gote'}-${piece.kind}`,
      score: scores[cell.row][cell.col],
    });
    console.log(`  ${fmt(t)} ${samples.at(-1)!.usi} を ${piece.kind}(${piece.side}) と誤読 NCC=${scores[cell.row][cell.col].toFixed(3)}`);
    if (samples.length >= MAX_SAMPLES) break;
  }
}

console.log(`\n# ${samples.length} 枚を書き出す`);
const index: unknown[] = [];
for (const [i, s] of samples.entries()) {
  const name = `unknown-${String(i).padStart(2, '0')}-${fmt(s.at)}-${s.usi}.png`;
  writePng(s.img, `${OUT_DIR}/${name}`);
  index.push({ file: name, at: s.at, square: s.usi, misreadAs: s.readAs, ncc: s.score });
  console.log(`  ${name}`);
}
writeFileSync(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 2));
console.log(`\n# 目録: ${OUT_DIR}/index.json`);
