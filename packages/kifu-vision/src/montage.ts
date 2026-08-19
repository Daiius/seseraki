/**
 * テンプレートを 1 枚の絵に並べて、目で確かめられるようにする。
 *
 * ⚠ **これは飾りではなく、手順の一部である。** 自動学習で貯めたテンプレートは
 * 3 度ラベルを間違えた。うち 2 度は「後手の駒を回さずに眺めた」ことが原因で、
 * `と` は回さないと `ス` に見える。数値だけ見ていても気付けない。
 *
 * PGM（P5）で書き出す。ヘッダが 3 行のテキストで、あとは輝度が 1 画素 1 バイト
 * 並ぶだけなので、画像ライブラリを足さずに済む。見るときは ffmpeg で PNG に
 * 変換する（`toPng`）。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GrayImage } from './frame.ts';

export function writePgm(img: GrayImage, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

/** 整数倍に拡大する（補間しない。元の画素をそのまま見たいので） */
export function magnify(img: GrayImage, factor: number): GrayImage {
  const width = img.width * factor;
  const height = img.height * factor;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = img.data[Math.floor(y / factor) * img.width + Math.floor(x / factor)];
    }
  }
  return { width, height, data };
}

export interface MontageCell {
  img: GrayImage;
  /** 下に添える見出し。**空でもよいが、付けないと取り違える。** */
  caption?: string;
}

/**
 * 画像を格子状に並べる。寸法が違っても、いちばん大きいものに枠を合わせる。
 *
 * 見出しは画像には焼き込まない（フォントを持ち込みたくない）。並び順を
 * 呼び出し側が `captions` として受け取り、標準出力に出す方が確実で、
 * 絵と突き合わせるのも難しくない。
 */
export function montage(
  cells: MontageCell[],
  options: { columns?: number; gap?: number; background?: number } = {},
): { img: GrayImage; captions: string[] } {
  const columns = options.columns ?? 6;
  const gap = options.gap ?? 6;
  const bg = options.background ?? 255;
  const cw = Math.max(...cells.map((c) => c.img.width));
  const ch = Math.max(...cells.map((c) => c.img.height));
  const rows = Math.ceil(cells.length / columns);
  const width = columns * cw + (columns + 1) * gap;
  const height = rows * ch + (rows + 1) * gap;
  const data = new Uint8Array(width * height).fill(bg);

  cells.forEach((cell, i) => {
    const r = Math.floor(i / columns);
    const c = i % columns;
    const x0 = gap + c * (cw + gap);
    const y0 = gap + r * (ch + gap);
    for (let y = 0; y < cell.img.height; y++) {
      data.set(
        cell.img.data.subarray(y * cell.img.width, (y + 1) * cell.img.width),
        (y0 + y) * width + x0,
      );
    }
  });

  return {
    img: { width, height, data },
    captions: cells.map((c, i) => `${Math.floor(i / columns)}行${i % columns}列: ${c.caption ?? ''}`),
  };
}

/** PGM を PNG に変換する（人が見るため。ffmpeg 頼みで依存を増やさない） */
export function toPng(pgmPath: string, pngPath: string): void {
  const res = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', pgmPath, pngPath]);
  if (res.status !== 0) {
    throw new Error(`PNG への変換に失敗しました: ${res.stderr.toString()}`);
  }
}
