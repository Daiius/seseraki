/**
 * 動画からのフレーム取得
 *
 * ffmpeg にグレースケールの生データ（rawvideo/gray）を吐かせて、
 * そのまま Uint8Array として扱う。PNG のデコードを挟まないので
 * 画像ライブラリへの依存が要らず、1 画素 1 バイトで添字計算も素直になる。
 *
 * 🔴 **「駒の判別に色は寄与しない」は誤りだった。** 生駒の字は黒だが、
 * **成駒の字は朱**である。形だけを見る NCC では `金` と `全` が 0.70〜0.81 相関して
 * 割り切れない（追記 62）のに対し、色は完全に分かれる（`src/ink.ts`）。
 * 駒種の照合は今もグレースケールで行い、**成りの検算にだけ色を使う**。
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
 * 輝度と色を 1 回の ffmpeg で取る。
 *
 * 🔴 **rgb24 で取って自分で輝度に落としてはいけない。** 実測で
 * `-pix_fmt gray` と 72% の画素がずれた（最大 18）。動画は YUV で符号化されて
 * いるので、rgb24 経由だと YUV→RGB→輝度と 2 回変換が入り、レンジの伸長も挟まる。
 * `sd` が動けば駒の有無の判定が動く——**色を足すために輝度を変えることになる。**
 *
 * ⭐ `gray` は本質的に Y 平面そのもの。**フルレンジの `yuvj444p`** で取れば
 * Y は `gray` と**画素単位で 100% 一致**する（実測）。`yuv444p`（リミテッド
 * レンジ）では一致率 1.3% なので、**`j` を落とさないこと**。
 */
export interface YuvImage {
  width: number;
  height: number;
  /** Y 平面。`-pix_fmt gray` と同じ値。 */
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** Y 平面をそのままグレースケール画像として見る（複製しない）。 */
export function yuvGray(img: YuvImage): GrayImage {
  return { width: img.width, height: img.height, data: img.y };
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

/**
 * 指定時刻のフレームを 1 枚、色付きで取る。
 *
 * `grabFrame` と同じ経路で `-pix_fmt` だけを変えたもの。転送量は 3 倍になるが、
 * **ffmpeg の起動が支配的**（1 枚 0.15 秒）なので、gray を別に取り直すより
 * ここから Y 平面を取り出す方が安い。
 */
export function grabFrameYuv(
  videoPath: string,
  seconds: number,
  width: number,
  height: number,
): YuvImage {
  const res = spawnSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-threads', String(FFMPEG_THREADS),
      '-ss', String(seconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuvj444p',
      '-',
    ],
    { maxBuffer: width * height * 8 },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg が失敗しました (t=${seconds}): ${res.stderr.toString()}`);
  }
  const n = width * height;
  if (res.stdout.length !== n * 3) {
    throw new Error(
      `フレームのサイズが想定と違います: ${res.stdout.length} バイト（期待 ${n * 3}）`,
    );
  }
  const buf = new Uint8Array(res.stdout);
  return {
    width,
    height,
    y: buf.subarray(0, n),
    u: buf.subarray(n, n * 2),
    v: buf.subarray(n * 2, n * 3),
  };
}

/** YUV 画像を切り出す（`crop` の色版）。 */
export function cropYuv(img: YuvImage, rect: Rect): YuvImage {
  const { x, y, w, h } = rect;
  const out = { y: new Uint8Array(w * h), u: new Uint8Array(w * h), v: new Uint8Array(w * h) };
  for (const plane of ['y', 'u', 'v'] as const) {
    for (let dy = 0; dy < h; dy++) {
      const src = (y + dy) * img.width + x;
      out[plane].set(img[plane].subarray(src, src + w), dy * w);
    }
  }
  return { width: w, height: h, ...out };
}

/**
 * 静止画ファイル（PNG など）をグレースケールで読む。
 *
 * 動画と同じ ffmpeg 経路に乗せるので、画像ライブラリへの依存は増えない。
 * 寸法はファイルに書いてあるので `ffprobe` に聞く（動画と違い、こちらは
 * 呼び出し側が正解を知らないのが普通）。
 *
 * 用途は**外から受け取った盤面の絵からテンプレートを起こすこと**。
 * 成駒は初期局面に無いので動画からは「成った瞬間」を捉えるしかなく、
 * そこがいちばん読みにくい。並べて見せてもらった絵から採る方が確実に安い。
 */
export function loadImage(path: string): GrayImage {
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    path,
  ]);
  if (probe.status !== 0) {
    throw new Error(`ffprobe が失敗しました (${path}): ${probe.stderr.toString()}`);
  }
  const [width, height] = probe.stdout.toString().trim().split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`画像の寸法を読めませんでした (${path}): ${probe.stdout.toString().trim()}`);
  }

  const res = spawnSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-threads', String(FFMPEG_THREADS),
      '-i', path,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      '-',
    ],
    { maxBuffer: width * height * 4 },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg が失敗しました (${path}): ${res.stderr.toString()}`);
  }
  if (res.stdout.length !== width * height) {
    throw new Error(
      `画像のサイズが想定と違います: ${res.stdout.length} バイト（期待 ${width * height}）`,
    );
  }
  return { width, height, data: new Uint8Array(res.stdout) };
}

/** カラー画像。data は RGB が 1 画素 3 バイトで並ぶ。 */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * 指定時刻のフレームをカラーで取る。
 *
 * 駒の判別には色は要らないが、**直前に指した手のマスに付くオレンジの
 * ハイライト**は色でしか判らない。グレースケールに落とすと木目に紛れる。
 */
export function grabColorFrame(
  videoPath: string,
  seconds: number,
  width: number,
  height: number,
): RgbImage {
  const res = spawnSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-threads', String(FFMPEG_THREADS),
      '-ss', String(seconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ],
    { maxBuffer: width * height * 12 },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg が失敗しました (t=${seconds}): ${res.stderr.toString()}`);
  }
  const expected = width * height * 3;
  if (res.stdout.length !== expected) {
    throw new Error(`フレームのサイズが想定と違います: ${res.stdout.length} バイト（期待 ${expected}）`);
  }
  return { width, height, data: new Uint8Array(res.stdout) };
}

/** カラー画像から矩形を切り出す */
export function cropRgb(img: RgbImage, rect: Rect): RgbImage {
  const data = new Uint8Array(rect.w * rect.h * 3);
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * img.width + rect.x) * 3;
    data.set(img.data.subarray(src, src + rect.w * 3), y * rect.w * 3);
  }
  return { width: rect.w, height: rect.h, data };
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
/**
 * 盤面を 9x9 に潰して、各マスの平均色だけを動画全体から流し取る。
 *
 * 手が指されたマスにはオレンジのハイライトが付く。これは色でしか判らないが、
 * **必要なのはマスの平均色だけ**なので、盤面をそのまま 9x9 に面積平均で
 * 縮小すれば 1 マス 1 画素になる。1 フレーム 243 バイトなので、30fps で
 * 30 分の動画でも 13MB 程度にしかならず、全編をメモリに載せられる。
 *
 * 盤の背景は位置によって色が違う（上ほど赤い）ので絶対値では測れないが、
 * 背景は動かないので**同じマスを時刻どうしで比べれば打ち消える**。実測では
 * 静止した局面のノイズが 0〜1、手が指されたマスが 20〜76 と桁違いに分かれた。
 *
 * マウスポインタは面積が小さく平均色をほとんど動かさないので、輝度の
 * 散らばりを使う `occupancy` と違ってポインタに惑わされない。
 *
 * @param onFrame cells は 9*9*3 バイト。[(row*9+col)*3 + 0..2] が R,G,B。
 */
export async function streamBoardCellColors(
  videoPath: string,
  geo: BoardGeometry,
  fps: number,
  onFrame: (cells: Uint8Array, index: number) => void,
  range?: { startSec?: number; durationSec?: number },
): Promise<void> {
  const board = boardRect(geo);
  const frameBytes = 9 * 9 * 3;

  const seek = range?.startSec ? ['-ss', String(range.startSec)] : [];
  const limit = range?.durationSec ? ['-t', String(range.durationSec)] : [];

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-threads', String(FFMPEG_THREADS),
    ...seek,
    '-i', videoPath,
    ...limit,
    // flags=area で面積平均になる。既定の bicubic だと隣のマスが滲む。
    '-vf', `fps=${fps},crop=${board.w}:${board.h}:${board.x}:${board.y},scale=9:9:flags=area`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  ]);

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let index = 0;
  const stderr: Buffer[] = [];
  ff.stderr.on('data', (c: Buffer) => stderr.push(c));

  ff.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      onFrame(new Uint8Array(pending.subarray(0, frameBytes)), index++);
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

export async function streamBoardFrames(
  videoPath: string,
  geo: BoardGeometry,
  fps: number,
  divisor: number,
  onFrame: (img: GrayImage, index: number) => void,
  range?: { startSec?: number; durationSec?: number },
): Promise<void> {
  const board = boardRect(geo);
  const w = Math.round(board.w / divisor);
  const h = Math.round(board.h / divisor);
  const frameBytes = w * h;

  // 範囲を絞れると、高い fps で細かく見たいときに全編を流さずに済む。
  // index は範囲の先頭からの通し番号になるので、時刻は startSec + index / fps。
  const seek = range?.startSec ? ['-ss', String(range.startSec)] : [];
  const limit = range?.durationSec ? ['-t', String(range.durationSec)] : [];

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-threads', String(FFMPEG_THREADS),
    ...seek,
    '-i', videoPath,
    ...limit,
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
