// 切り出し窓が、字が実際に描かれている位置と合っているかを測る（Phase M 段取り 1）。
//
//   pnpm --filter kifu-vision exec tsx probe-cell-window.ts <動画パス> <初期局面の秒> [較正の右端秒]
//   例: probe-cell-window.ts data/videos/fQR9Fx7DOvk.mp4 2 1833
//
// 🔴 きっかけはユーザの指摘（追記 140 末尾）:
//   「字の下端が切れている。窓の上には余白が残り、下は `玉` の点・`金` の下棒・
//    `歩` の左払いが外に出ている」
//
// 切り出し窓は格子から一定の割合（MATCH_INSET = 0.24）で**上下左右とも同じだけ**
// 内側に詰めている。窓の位置を**格子線**から決めていて、**字が実際に描かれている
// 位置**から決めていない。ここで測るのは 3 つ:
//
//   (a) インクがマスの中のどこにあるか（重心・外接矩形）。**現行の窓から何画素はみ出すか**
//   (b) 窓を変えると**紛らわしい組**の相関がどう動くか（中央値ではなく、割れるかどうか）
//   (c) refineByTemplates を動画フレームに当てると格子がどれだけ動くか
//
// 🔒 **測るだけ。本線には触らない。**
// ⚠ (b) で「窓を変えたら一致度が上がった」は当てにならない——テンプレートも同じ窓で
// 切り出すので、**自分自身との一致は窓をどこに置いても高く出る**。見るべきは
// **違う駒どうしの相関（非対角）が下がるか**＝情報が増えて割れやすくなったか。

import type { PieceKind, Side } from 'shared';
import { createInitialState } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { ncc, resample, MATCH_INSET, type Template } from './src/template.ts';
import { loadTemplates } from './src/template-store.ts';
import { calibrateFromFrames, refineByTemplates, type KnownCell } from './src/calibrate.ts';
import { magnify, montage, writePgm, toPng } from './src/montage.ts';

const video = process.argv[2];
const at = Number(process.argv[3]);
const calTo = Number(process.argv[4] ?? 1833);
/** 動画をまたいだ検証に使う 2 本目（省略可） */
const video2 = process.argv[5];
const at2 = Number(process.argv[6]);
const calTo2 = Number(process.argv[7] ?? 2120);
if (!video || !Number.isFinite(at)) {
  console.error('使い方: probe-cell-window.ts <動画> <初期局面の秒> [較正の右端秒] [2本目 秒 右端]');
  process.exit(1);
}

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
/**
 * ⚠ ここでいう「下側 / 上側」は**画面での位置**であって先手後手ではない。
 * 画面の下が後手の動画があるので（1 本目 1 局目）、`Side` をそのまま
 * 先手後手と読むと取り違える。初期局面の row 6〜8 が下側。
 */
const screenSide = (side: Side) => (side === 'sente' ? '下側' : '上側');

// --- 較正（本線と同じ 9 点・同じ撒き方にする。ここがずれると全部ずれる） ---
const CAL_POINTS = 9;
const calSeconds = Array.from({ length: CAL_POINTS }, (_, i) => 1 + ((calTo - 2) * i) / (CAL_POINTS - 1))
  .filter((s) => s > 0)
  .map((s) => Math.round(s));
const calibration = calibrateFromFrames(
  calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
console.log(`# 較正: ${calibration ? `${calibration.used}/${calibration.tried} 枚` : '失敗（定数のまま）'}`);
console.log(`  マス寸法 ${(geo.cellW).toFixed(2)} x ${(geo.cellH).toFixed(2)}`);

const board = crop(grabFrame(video, at, geo.frameW, geo.frameH), boardRect(geo));
const cw = board.width / 9;
const ch = board.height / 9;
console.log(`  盤 ${board.width}x${board.height}（マス ${cw.toFixed(2)} x ${ch.toFixed(2)}）  ${at} 秒`);

// ---------------------------------------------------------------------------
// 窓の指定。現行は insetX = insetY = 0.24・ずれ 0。
// ⚠ 縦のずれは**画素**で持つ（割合だと読み取りにくい）。
// ---------------------------------------------------------------------------
interface Window {
  name: string;
  insetX: number;
  insetY: number;
  /**
   * 窓を下へずらす画素数（負なら上へ）。
   *
   * 🔴 **絵を見て分かったこと**（2026-08-16・(d)）: 字は**駒の中で下寄り**に
   * 描かれている。上側の駒は 180 度回して描かれるので、**画面では上寄り**になる。
   * だから「窓を一律に下へずらす」と、下側は直るが上側は悪化する。
   * → **駒の向きごとにずらす**必要がある。`dyGote` を省くと `dy` と同じ値を使う
   * （＝一律のずらし。比較のために残してある）。
   */
  dy: number;
  dyGote?: number;
}

function windowCell(src: GrayImage, row: number, col: number, win: Window): GrayImage {
  const w = Math.floor(cw * (1 - win.insetX * 2));
  const h = Math.floor(ch * (1 - win.insetY * 2));
  const x0 = Math.round(cw * col + cw * win.insetX);
  const y0 = Math.round(ch * row + ch * win.insetY + win.dy);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, y0 + y));
    const sx = Math.min(src.width - w, Math.max(0, x0));
    data.set(src.data.subarray(sy * src.width + sx, sy * src.width + sx + w), y * w);
  }
  return { width: w, height: h, data };
}

/** マス全体（窓を掛けない）を取り出す。インクの位置を測るのに使う。 */
function fullCell(src: GrayImage, row: number, col: number): GrayImage {
  return windowCell(src, row, col, { name: 'full', insetX: 0, insetY: 0, dy: 0 });
}

// ---------------------------------------------------------------------------
// (a) インクがマスの中のどこにあるか
//
// 駒字は木地より暗い。閾値は絶対値で置かず、**そのマスの分布から決める**
// （マスごとに明るさが違う・ハイライトが乗ることもある）。
//   中央値と 5 パーセンタイルの間を取る = 「はっきり暗い画素」だけを拾う。
// 🔒 代用であることを承知しておく。ここで見たいのは「字がどこまで伸びているか」で、
//    厳密なインク量ではない。
// ---------------------------------------------------------------------------
function percentile(values: Uint8Array, p: number): number {
  const s = Array.from(values).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

interface Ink {
  /** マス中心を原点とした重心（画素） */
  cx: number;
  cy: number;
  /** 外接矩形（マス左上を原点とした画素） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
  /** 駒の木地の外接矩形（同じ座標系） */
  bodyY0: number;
  bodyY1: number;
}

/**
 * 🔴 **最初の実装は測るものを間違えていた**（2026-08-16）。
 *
 * 「マスの中で暗い画素」を拾ったら、外接矩形がほぼ全マスで `0〜127`＝マス全体に
 * なった。駒字ではなく**駒の外側の暗い盤面と格子線**を拾っていたためである。
 * 重心も下側 +26.3 / 上側 -6.9 と出たが、これは**駒の五角形の向き**を測っていた
 * （下向きの駒は下の隅が暗い）。字の位置ではない。
 *
 * 🔒 **暗さは字の代用にならない。** 字は**駒の木地の内側**にしかないので、
 * 先に木地を見つけ、その内側だけで測る。
 *
 * 木地は駒の中でいちばん明るい領域なので、マスの明暗を 2 つに割り（大津の方法）、
 * 明るい側を木地とする。字は木地より暗いので、木地の内側でもう一度割る。
 */
function otsu(values: number[]): number {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

function inkOf(cell: GrayImage): Ink | null {
  const all = Array.from(cell.data);
  // 1. 木地（明るい側）を見つける
  const bodyThr = otsu(all);
  /** 各行で木地が横に広がっている範囲。ここより外は駒の外なので見ない。 */
  const span: Array<[number, number] | null> = [];
  let bodyY0 = cell.height;
  let bodyY1 = -1;
  for (let y = 0; y < cell.height; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < cell.width; x++) {
      if (cell.data[y * cell.width + x] <= bodyThr) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    // 木地が細切れの行（駒の角）は使わない
    if (lo < 0 || hi - lo < cell.width * 0.25) {
      span.push(null);
      continue;
    }
    span.push([lo, hi]);
    if (y < bodyY0) bodyY0 = y;
    if (y > bodyY1) bodyY1 = y;
  }
  if (bodyY1 < 0) return null;

  // 2. 木地の内側だけを集めて、もう一度割る（＝字）
  const inside: number[] = [];
  for (let y = 0; y < cell.height; y++) {
    const s = span[y];
    if (!s) continue;
    for (let x = s[0]; x <= s[1]; x++) inside.push(cell.data[y * cell.width + x]);
  }
  const inkThr = otsu(inside);

  let sx = 0;
  let sy = 0;
  let n = 0;
  let x0 = cell.width;
  let y0 = cell.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < cell.height; y++) {
    const s = span[y];
    if (!s) continue;
    for (let x = s[0]; x <= s[1]; x++) {
      if (cell.data[y * cell.width + x] > inkThr) continue;
      sx += x;
      sy += y;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (n === 0) return null;
  return {
    cx: sx / n - (cell.width - 1) / 2,
    cy: sy / n - (cell.height - 1) / 2,
    x0, y0, x1, y1,
    pixels: n,
    bodyY0,
    bodyY1,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const { board: initial } = createInitialState();

console.log('\n## (a) インクの位置（マス全体で測る。原点はマス中心）');
console.log('⚠ 「下側 / 上側」は画面での位置。先手後手ではない（画面の下が後手の動画がある）');

interface Row {
  side: Side;
  kind: PieceKind;
  ink: Ink;
}
const rows: Row[] = [];
for (let row = 0; row < 9; row++) {
  for (let col = 0; col < 9; col++) {
    const piece = initial[row][col];
    if (!piece) continue;
    const ink = inkOf(fullCell(board, row, col));
    if (ink) rows.push({ side: piece.side, kind: piece.kind, ink });
  }
}

// 現行の窓の境界（マス左上を原点とした画素）
const curTop = Math.round(ch * MATCH_INSET);
const curBottom = curTop + Math.floor(ch * (1 - MATCH_INSET * 2)) - 1;
const curLeft = Math.round(cw * MATCH_INSET);
const curRight = curLeft + Math.floor(cw * (1 - MATCH_INSET * 2)) - 1;
console.log(`  現行の窓: x ${curLeft}〜${curRight} / y ${curTop}〜${curBottom}（マスは ${Math.round(cw)}x${Math.round(ch)}）`);

for (const side of ['sente', 'gote'] as Side[]) {
  const rs = rows.filter((r) => r.side === side);
  if (rs.length === 0) continue;
  console.log(`\n  ### ${screenSide(side)}（${rs.length} マス）`);
  console.log('  駒   重心x  重心y   字の上下   木地の上下   窓からのはみ出し（上/下/左/右）');
  const byKind = new Map<PieceKind, Row[]>();
  for (const r of rs) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  for (const [kind, list] of byKind) {
    const cx = median(list.map((r) => r.ink.cx));
    const cy = median(list.map((r) => r.ink.cy));
    const y0 = median(list.map((r) => r.ink.y0));
    const y1 = median(list.map((r) => r.ink.y1));
    const x0 = median(list.map((r) => r.ink.x0));
    const x1 = median(list.map((r) => r.ink.x1));
    const by0 = median(list.map((r) => r.ink.bodyY0));
    const by1 = median(list.map((r) => r.ink.bodyY1));
    // はみ出し: 正なら窓の外に出ている
    const over = [curTop - y0, y1 - curBottom, curLeft - x0, x1 - curRight];
    const mark = over.some((v) => v > 0) ? ' ⚠' : '';
    console.log(
      `  ${NAMES[kind]}  ${cx.toFixed(1).padStart(5)} ${cy.toFixed(1).padStart(6)}` +
        `   ${String(y0).padStart(3)}〜${String(y1).padStart(3)}` +
        `   ${String(by0).padStart(3)}〜${String(by1).padStart(3)}` +
        `      ${over.map((v) => String(v).padStart(4)).join(' ')}${mark}`,
    );
  }
  console.log(
    `  中央値: 重心 (${median(rs.map((r) => r.ink.cx)).toFixed(2)}, ${median(rs.map((r) => r.ink.cy)).toFixed(2)})` +
      `  インク上端 ${median(rs.map((r) => r.ink.y0))}  下端 ${median(rs.map((r) => r.ink.y1))}`,
  );
}

console.log(
  `\n  全体の重心（縦）: ${median(rows.map((r) => r.ink.cy)).toFixed(2)} 画素` +
    ` = マス高の ${((median(rows.map((r) => r.ink.cy)) / ch) * 100).toFixed(1)}%`,
);
console.log('  🔒 下側と上側で符号が逆なら、窓を一律にずらすのは誤り（駒は 180 度回して描かれる）');
console.log(
  '  🔴 ただし (a) の数値は当てにならない——**盤も駒も同じ木目**なので、明暗では\n' +
    '     駒の内側を切り出せない（木地の上下が 0〜127 ＝マス全体になっている）。\n' +
    '     🔒 代用が外れたら絵を見る（§4）。→ (d) へ',
);

// ---------------------------------------------------------------------------
// (d) 絵を見る
//
// 🔒 (a) の代用が 2 回続けて外れたので、**マスを拡大して窓の枠を焼き込み、
// 人が見て確かめる**。「字の下端が切れている」は目で見れば 1 秒で分かる。
// ⚠ 上側の駒は 180 度回して並べる（回さないと `と` が `ス` に見える・§4）。
// ---------------------------------------------------------------------------
function rotate180(img: GrayImage): GrayImage {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) data[i] = img.data[img.data.length - 1 - i];
  return { width: img.width, height: img.height, data };
}

/** 窓の枠を破線で焼き込む（木地でも字でも見えるよう 0 と 255 を交互に置く） */
function drawWindow(cell: GrayImage): GrayImage {
  const out = { width: cell.width, height: cell.height, data: Uint8Array.from(cell.data) };
  const put = (x: number, y: number, i: number) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    out.data[y * out.width + x] = i % 2 === 0 ? 0 : 255;
  };
  for (let x = curLeft; x <= curRight; x++) {
    put(x, curTop, x);
    put(x, curBottom, x);
  }
  for (let y = curTop; y <= curBottom; y++) {
    put(curLeft, y, y);
    put(curRight, y, y);
  }
  return out;
}

const outDir = process.env.KIFU_VISION_OUT_DIR ?? 'data/out';
/** 見たい駒。ユーザの指摘に出てくる `玉`（点）・`金`（下棒）・`歩`（左払い）を必ず入れる */
const WANT: PieceKind[] = ['K', 'G', 'P', 'S', 'L', 'R'];
const picked: { img: GrayImage; caption: string }[] = [];
for (const side of ['sente', 'gote'] as Side[]) {
  for (const kind of WANT) {
    let found: GrayImage | null = null;
    for (let row = 0; row < 9 && !found; row++) {
      for (let col = 0; col < 9 && !found; col++) {
        const p = initial[row][col];
        if (p && p.side === side && p.kind === kind) found = fullCell(board, row, col);
      }
    }
    if (!found) continue;
    const framed = drawWindow(found);
    picked.push({
      img: magnify(side === 'gote' ? rotate180(framed) : framed, 4),
      caption: `${screenSide(side)} ${NAMES[kind]}`,
    });
  }
}
const sheet = montage(picked.map((p) => ({ img: p.img })), { columns: WANT.length, gap: 8, background: 128 }).img;
const pgm = `${outDir}/window.pgm`;
writePgm(sheet, pgm);
toPng(pgm, `${outDir}/window.png`);
console.log(`\n## (d) 絵にした: ${outDir}/window.png`);
console.log(`  並び（左上から右へ）: ${picked.map((p) => p.caption).join(' / ')}`);
console.log('  枠が現在の切り出し窓。⚠ 上側の駒は 180 度回して並べてある');

// ---------------------------------------------------------------------------
// (b) 窓を変えると紛らわしさがどう動くか
//
// 🔒 見るのは**非対角の最大**（違う駒どうしがどれだけ似ているか）。
// 対角（自分自身との一致）は窓をどこに置いても高く出るので判断に使えない。
// ---------------------------------------------------------------------------
function templatesAt(win: Window): Template[] {
  const buckets = new Map<string, { kind: PieceKind; side: Side; sum: Float64Array; n: number; w: number; h: number }>();
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = initial[row][col];
      if (!piece) continue;
      const dy = piece.side === 'gote' ? (win.dyGote ?? win.dy) : win.dy;
      const cell = windowCell(board, row, col, { ...win, dy });
      const key = `${piece.side}:${piece.kind}`;
      let b = buckets.get(key);
      if (!b) {
        b = { kind: piece.kind, side: piece.side, sum: new Float64Array(cell.data.length), n: 0, w: cell.width, h: cell.height };
        buckets.set(key, b);
      }
      for (let i = 0; i < cell.data.length; i++) b.sum[i] += cell.data[i];
      b.n++;
    }
  }
  return [...buckets.values()].map((b) => ({
    kind: b.kind,
    side: b.side,
    samples: b.n,
    img: { width: b.w, height: b.h, data: Uint8Array.from(b.sum, (v) => Math.round(v / b.n)) },
  }));
}

interface Pair {
  a: Template;
  b: Template;
  s: number;
}
/**
 * 🔒 **見るのは「同じ向きどうし」の最悪値。**
 *
 * 実際の照合で取り違えが起きるのは `▲桂` と `▲銀`、`▲金` と `▲全` のような
 * **同じ向きの駒どうし**である。向きが違えば字が 180 度回っているので、
 * そもそも相関が低い。向きごとに別の窓を使う案では、**違う向きの相関は
 * 別々の切り出しから測ることになって意味を持たない**ので、分けて出す。
 */
function confusion(ts: Template[]): { worstSame: Pair[]; medianSame: number } {
  const pairs: Pair[] = [];
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      if (ts[i].side !== ts[j].side) continue;
      pairs.push({ a: ts[i], b: ts[j], s: ncc(ts[i].img, ts[j].img) });
    }
  }
  pairs.sort((p, q) => q.s - p.s);
  return { worstSame: pairs.slice(0, 5), medianSame: median(pairs.map((p) => p.s)) };
}

const label = (t: Template) => `${t.side === 'sente' ? '▲' : '▽'}${NAMES[t.kind]}`;

const candidates: Window[] = [
  { name: '現行 (0.24, 0.24, dy=0)', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 0 },
  // 一律のずらし（比較のため。片側が必ず悪化するはず）
  { name: '一律 下へ +4px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 4 },
  { name: '一律 上へ -4px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: -4 },
  // 向きごとのずらし（駒から見て下へ寄せる）
  { name: '向きごと ±2px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 2, dyGote: -2 },
  { name: '向きごと ±4px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 4, dyGote: -4 },
  { name: '向きごと ±6px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 6, dyGote: -6 },
  { name: '向きごと ±8px', insetX: MATCH_INSET, insetY: MATCH_INSET, dy: 8, dyGote: -8 },
  // 窓を広げる（背景を巻き込むぶん不利になるはず）
  { name: '縦を広く (0.24, 0.18)', insetX: MATCH_INSET, insetY: 0.18, dy: 0 },
  { name: '縦を広く (0.24, 0.14)', insetX: MATCH_INSET, insetY: 0.14, dy: 0 },
  { name: '全体に広く (0.18, 0.18)', insetX: 0.18, insetY: 0.18, dy: 0 },
  // 広げたうえで向きごとに寄せる
  { name: '(0.24,0.18) 向きごと ±4', insetX: MATCH_INSET, insetY: 0.18, dy: 4, dyGote: -4 },
  // 折り返す所まで掃く（窓が駒の縁へ出れば、影は駒ごとに共通なので相関は上がるはず）
  ...[10, 12, 14, 16].map((d) => ({
    name: `向きごと ±${d}px`,
    insetX: MATCH_INSET,
    insetY: MATCH_INSET,
    dy: d,
    dyGote: -d,
  })),
];

console.log('\n## (b) 窓ごとの紛らわしさ（**同じ向き**の違う駒どうしの相関。低いほどよい）');
console.log('  窓                        寸法      中央値   いちばん紛らわしい組');
for (const win of candidates) {
  const ts = templatesAt(win);
  const { worstSame, medianSame } = confusion(ts);
  console.log(
    `  ${win.name.padEnd(24)} ${ts[0].img.width}x${ts[0].img.height}` +
      `   ${medianSame.toFixed(3).padStart(6)}   ` +
      worstSame.slice(0, 3).map((p) => `${label(p.a)}⇔${label(p.b)} ${p.s.toFixed(3)}`).join('  '),
  );
}

// ---------------------------------------------------------------------------
// (c) refineByTemplates を動画フレームに当てたら格子がどれだけ動くか
//
// 🔴 これは **geo 全体（原点とマス寸法）を動かす**。geo は駒の有無（sd）の
// 切り出しにも使われるので、動かせば sd が動き、駒の有無が動き、手が変わる。
// **どれだけ動くのか**をここで測っておく（動きが 0 なら引っかかり 1 は杞憂）。
// ---------------------------------------------------------------------------
console.log('\n## (c) refineByTemplates を動画フレームに当てる');
const probe = templatesAt(candidates[0]);
const stored = loadTemplates('data/templates/shogi-wars-vertical.json', {
  width: probe[0].img.width,
  height: probe[0].img.height,
});
if (!stored) {
  console.log('  保存済みテンプレートが無いので飛ばす');
} else {
  const known: KnownCell[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = initial[row][col];
      if (!piece) continue;
      const t = stored.find((s) => s.kind === piece.kind && s.side === piece.side);
      if (t) known.push({ row, col, template: t.img });
    }
  }
  const full = crop(grabFrame(video, at, geo.frameW, geo.frameH), {
    x: 0, y: 0, w: geo.frameW, h: geo.frameH,
  });
  const r = refineByTemplates(full, geo, known);
  console.log(`  手掛かり ${known.length} マス（保存済みテンプレートを正解として使う）`);
  console.log(`  一致度の中央値: ${r.before.toFixed(4)} → ${r.after.toFixed(4)}`);
  console.log(
    `  格子の動き: 原点 (${(r.geo.originX - geo.originX).toFixed(2)}, ${(r.geo.originY - geo.originY).toFixed(2)})` +
      `  マス寸法 (${(r.geo.cellW - geo.cellW).toFixed(3)}, ${(r.geo.cellH - geo.cellH).toFixed(3)})`,
  );
  const dys = r.shifts.map((s) => s.dy);
  const dxs = r.shifts.map((s) => s.dx);
  console.log(`  残るずれの中央値: (${median(dxs).toFixed(2)}, ${median(dys).toFixed(2)}) 画素`);
  console.log('  🔒 原点が 1 画素以上動くなら、駒の有無（sd）にも効く。窓だけ動かすのとは別物');
}

// ---------------------------------------------------------------------------
// (e) 動画をまたいだ検証
//
// 🔒 (b) は**同じフレームから起こしたテンプレートどうし**を比べているので、
// 「窓を変えたら分離が良くなった」が**その 1 枚に都合よく合わせただけ**でないかを
// 確かめられない（GOAL §4「数字が良くなったことを仕組みが正しいの証拠にしない」）。
//
// そこで **1 本目から起こしたテンプレートで、2 本目のマスを読む**。
// ⚠ 実際の照合では**マスの向きは分からない**ので、向きごとの窓を使うなら
// **1 マスにつき 2 通り切り出し、それぞれをその向きのテンプレートと比べる**ことになる。
// ここでもその通りに測る（そうしないと本線で再現できない数字になる）。
// ---------------------------------------------------------------------------
if (video2 && Number.isFinite(at2)) {
  console.log(`\n## (e) 1 本目のテンプレートで 2 本目を読む（${video2} ${at2} 秒）`);
  const calSeconds2 = Array.from({ length: CAL_POINTS }, (_, i) => 1 + ((calTo2 - 2) * i) / (CAL_POINTS - 1))
    .filter((s) => s > 0)
    .map((s) => Math.round(s));
  const cal2 = calibrateFromFrames(
    calSeconds2.map((s) => grabFrame(video2, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
    SHOGI_WARS_VERTICAL,
  );
  const geo2 = cal2?.geo ?? SHOGI_WARS_VERTICAL;
  const board2 = crop(grabFrame(video2, at2, geo2.frameW, geo2.frameH), boardRect(geo2));
  const cw2 = board2.width / 9;
  const ch2 = board2.height / 9;
  console.log(`  較正: ${cal2 ? `${cal2.used}/${cal2.tried} 枚` : '失敗'}  マス ${cw2.toFixed(2)} x ${ch2.toFixed(2)}`);

  /** 2 本目のマスを、指定の向きの窓で切り出す（マス寸法が違えばテンプレートに合わせる） */
  const cell2 = (row: number, col: number, win: Window, side: Side, w: number, h: number): GrayImage => {
    const dy = side === 'gote' ? (win.dyGote ?? win.dy) : win.dy;
    const ww = Math.floor(cw2 * (1 - win.insetX * 2));
    const hh = Math.floor(ch2 * (1 - win.insetY * 2));
    const x0 = Math.round(cw2 * col + cw2 * win.insetX);
    const y0 = Math.round(ch2 * row + ch2 * win.insetY + dy);
    const data = new Uint8Array(ww * hh);
    for (let y = 0; y < hh; y++) {
      const sy = Math.min(board2.height - 1, Math.max(0, y0 + y));
      const sx = Math.min(board2.width - ww, Math.max(0, x0));
      data.set(board2.data.subarray(sy * board2.width + sx, sy * board2.width + sx + ww), y * ww);
    }
    const img = { width: ww, height: hh, data };
    return ww === w && hh === h ? img : resample(img, w, h);
  };

  console.log('  窓                        正解  一致度の中央値  差（1位-2位）の中央値  最小の差');
  for (const win of candidates) {
    const ts = templatesAt(win);
    const { width: tw, height: th } = ts[0].img;
    let correct = 0;
    const hits: number[] = [];
    const margins: number[] = [];
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const piece = initial[row][col];
        if (!piece) continue;
        // 🔒 向きごとに切り出し、その向きのテンプレートとだけ比べる
        const bySide: Record<Side, GrayImage> = {
          sente: cell2(row, col, win, 'sente', tw, th),
          gote: cell2(row, col, win, 'gote', tw, th),
        };
        const ranked = ts
          .map((t) => ({ t, s: ncc(bySide[t.side], t.img) }))
          .sort((a, b) => b.s - a.s);
        const truth = ranked.find((r) => r.t.kind === piece.kind && r.t.side === piece.side)!;
        const bestWrong = ranked.find((r) => r.t.kind !== piece.kind || r.t.side !== piece.side)!;
        if (ranked[0].t.kind === piece.kind && ranked[0].t.side === piece.side) correct++;
        hits.push(truth.s);
        margins.push(truth.s - bestWrong.s);
      }
    }
    console.log(
      `  ${win.name.padEnd(24)} ${String(correct).padStart(3)}/40` +
        `   ${median(hits).toFixed(3).padStart(8)}` +
        `        ${median(margins).toFixed(3).padStart(8)}` +
        `        ${Math.min(...margins).toFixed(3).padStart(7)}`,
    );
  }
  console.log('  🔒 見るのは正解数と**最小の差**。中央値が上がっても、最小が縮めば取り違えは増える');
}
