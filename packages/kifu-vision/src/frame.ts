/**
 * 動画からのフレーム取得
 *
 * ffmpeg にグレースケールの生データ（rawvideo/gray）を吐かせて、
 * そのまま Uint8Array として扱う。PNG のデコードを挟まないので
 * 画像ライブラリへの依存が要らず、1 画素 1 バイトで添字計算も素直になる。
 *
 * 駒の判別に色はほぼ寄与しない（駒字は黒、盤は木目）ため、
 * グレースケールで落として構わない。
 */

import { spawn, spawnSync } from 'node:child_process';
import type { BoardGeometry, Rect } from './geometry.ts';
import { boardRect } from './geometry.ts';

/**
 * ffmpeg に使わせるスレッド数。
 *
 * 既定のままだと ffmpeg は積んでいるコアを全部使いにいく。長い動画を
 * 端から流す処理なので、放っておくと手元の他の作業を圧迫する。
 * `KIFU_VISION_THREADS` で変えられる。
 */
export const FFMPEG_THREADS = Number(process.env.KIFU_VISION_THREADS ?? 4);

/** グレースケール画像。data[y * width + x] が輝度（0-255）。 */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function pixelAt(img: GrayImage, x: number, y: number): number {
  return img.data[y * img.width + x];
}

/**
 * 指定時刻のフレームを 1 枚、元解像度のまま取る。
 *
 * `-ss` を入力の前に置くと ffmpeg がキーフレームまで飛んでからデコードするので、
 * 長い動画でも頭から舐めずに済む。
 */
export function grabFrame(
  videoPath: string,
  seconds: number,
  width: number,
  height: number,
): GrayImage {
  const res = spawnSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-threads', String(FFMPEG_THREADS),
      '-ss', String(seconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      '-',
    ],
    { maxBuffer: width * height * 4 },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg が失敗しました (t=${seconds}): ${res.stderr.toString()}`);
  }
  const expected = width * height;
  if (res.stdout.length !== expected) {
    throw new Error(
      `フレームのサイズが想定と違います: ${res.stdout.length} バイト（期待 ${expected}）`,
    );
  }
  return { width, height, data: new Uint8Array(res.stdout) };
}

/** 画像から矩形を切り出す */
export function crop(img: GrayImage, rect: Rect): GrayImage {
  const data = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    const src = (rect.y + y) * img.width + rect.x;
    data.set(img.data.subarray(src, src + rect.w), y * rect.w);
  }
  return { width: rect.w, height: rect.h, data };
}

/**
 * 盤面だけを縮小して、動画全体から一定間隔で連続的に取り出す。
 *
 * 変化がどこで起きたかを知るだけなら元解像度は要らない。盤面に crop して
 * 縮小したものを 1 パスのシーケンシャルデコードで流し込むことで、
 * 全フレームを個別にシークするより桁違いに安く済む。
 *
 * @param fps 1 秒あたり何枚取るか
 * @param divisor 盤面をこの分の 1 に縮小する
 * @param onFrame 1 枚ごとに呼ばれる。index は 0 起点で、時刻は index / fps 秒。
 */
export async function streamBoardFrames(
  videoPath: string,
  geo: BoardGeometry,
  fps: number,
  divisor: number,
  onFrame: (img: GrayImage, index: number) => void,
): Promise<void> {
  const board = boardRect(geo);
  const w = Math.round(board.w / divisor);
  const h = Math.round(board.h / divisor);
  const frameBytes = w * h;

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-threads', String(FFMPEG_THREADS),
    '-i', videoPath,
    '-vf', `fps=${fps},crop=${board.w}:${board.h}:${board.x}:${board.y},scale=${w}:${h}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    '-',
  ]);

  // subarray で切り詰めると Buffer<ArrayBufferLike> になるので、その型で受ける
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let index = 0;
  const stderr: Buffer[] = [];
  ff.stderr.on('data', (c: Buffer) => stderr.push(c));

  ff.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      // subarray はコピーしないので、切り出した分を必ず複製してから渡す
      onFrame({ width: w, height: h, data: new Uint8Array(frame) }, index++);
      pending = pending.subarray(frameBytes);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg が終了コード ${code} で失敗: ${Buffer.concat(stderr).toString()}`));
        return;
      }
      resolve();
    });
  });
}
