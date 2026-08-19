// 戦法エフェクト（「戦法 ○○」の帯）が出ている時刻を探し、帯を切り出す。
//
//   pnpm --filter kifu-vision exec tsx probe-tactic-banner.ts <動画パス> <開始秒> <終了秒> [刻み秒]
//
// ⭐ **エフェクトには戦法名が書いてある**（各局 1 回・戦法が確定した直後）。
// seseraki 本体の戦型判定の**正解ラベル**として使える。
//
// ⚠ **ここでやるのは「出ている時刻を見つけて切り出す」ところまで。**
// 戦法名そのものを読むには、戦法ごとの見本が要る。手元の素材は 1 本の動画・2 局で、
// **両局とも同じ戦法**なので、認識器を作っても検証できない（追記 108）。
//
// 帯は**黒い筆書きの下地に金色の文字**で、盤（木目・明るい）よりはっきり暗い。
// 盤に切り出したうえで、帯の位置の平均輝度が落ちる時刻を探す。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 60);
const stepSec = Number(process.argv[5] ?? 0.5);
const OUT_DIR = process.env.KIFU_VISION_OUT_DIR ?? 'data/tactic-banner';
const geo = SHOGI_WARS_VERTICAL;

/**
 * 帯の位置（盤に切り出した画像に対する割合）。
 *
 * 0:20.4 のフレームを目で見て決めた。盤の中央下寄りで、左右にはみ出さない範囲。
 * **ここを厳密に合わせる必要はない**——見たいのは「暗くなったか」だけ。
 */
const BANNER = { x0: 0.12, x1: 0.82, y0: 0.62, y1: 0.78 };

function regionMean(img: GrayImage, r: typeof BANNER): number {
  const x0 = Math.round(img.width * r.x0);
  const x1 = Math.round(img.width * r.x1);
  const y0 = Math.round(img.height * r.y0);
  const y1 = Math.round(img.height * r.y1);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += img.data[y * img.width + x];
      n++;
    }
  }
  return sum / n;
}

function dumpPgm(img: GrayImage, path: string) {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;

const samples: { t: number; mean: number; img: GrayImage }[] = [];
for (let t = fromSec; t <= toSec; t += stepSec) {
  const board = crop(grabFrame(video, t, geo.frameW, geo.frameH), boardRect(geo));
  samples.push({ t: Number(t.toFixed(2)), mean: regionMean(board, BANNER), img: board });
}

const means = samples.map((s) => s.mean).sort((a, b) => a - b);
const median = means[means.length >> 1];
console.log(`# ${fmt(fromSec)}〜${fmt(toSec)} を ${stepSec} 秒刻み（${samples.length} 点）`);
console.log(`  帯の位置の平均輝度: 中央値 ${median.toFixed(1)} / 最小 ${means[0].toFixed(1)} / 最大 ${means.at(-1)!.toFixed(1)}`);

// 中央値からこれだけ暗ければ、帯が出ているとみなす。
const DROP = Number(process.env.KIFU_VISION_BANNER_DROP ?? 25);
const dark = samples.filter((s) => s.mean < median - DROP);
console.log(`  中央値より ${DROP} 以上暗い時刻: ${dark.length} 点`);
for (const s of dark) console.log(`    ${fmt(s.t)}  ${s.mean.toFixed(1)}`);

// ⚠ **いちばん暗い 1 枚が、いちばん読める 1 枚とは限らない。** 帯は滑り込んで
// 滑り出ていくので、黒い下地がいちばん広い瞬間と、文字が全部出ている瞬間はずれる。
// **暗いフレームを全部書き出して、人が選べるようにする。**
//
// ⚠ 判定は「窓の中央値より暗いか」なので、**窓全体が演出中だと何も出ない**。
// 演出の外を含む広い範囲で走らせること（実測: 0:15〜0:32 で 0:17〜0:21 が出る）。
for (const darkest of dark) {
  const r = BANNER;
  const x0 = Math.round(darkest.img.width * r.x0);
  const x1 = Math.round(darkest.img.width * r.x1);
  const y0 = Math.round(darkest.img.height * r.y0);
  const y1 = Math.round(darkest.img.height * r.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * darkest.img.width + x0;
    data.set(darkest.img.data.subarray(src, src + w), y * w);
  }
  const path = `${OUT_DIR}/banner-at${darkest.t.toFixed(2).replace('.', '_')}s.pgm`;
  dumpPgm({ width: w, height: h, data }, path);
  console.log(`  書き出した: ${path}（輝度 ${darkest.mean.toFixed(1)}）`);
}
