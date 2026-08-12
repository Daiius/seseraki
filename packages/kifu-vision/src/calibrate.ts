/**
 * 盤の格子を動画ごとに測り直す
 *
 * `SHOGI_WARS_VERTICAL` の定数は 1 本の動画から測ったもので、**別の動画では
 * 数ピクセルずれうる**（録画の解像度・切り出し・UI の版）。ずれると切り出す
 * 位置が全マスで一様にずれ、一致度が落ちる。実測では切り出しを ±3 画素
 * 探し直すだけで、下位 5% の一致度が 0.679 → 0.972 まで上がった。
 * **いちばん読みにくいマスほど、位置ずれの影響を受ける。**
 *
 * ⚠ ただし照合のたびにずらして探すのは高く付く（±3 で 49 倍）。
 * ずれは**マスごとではなく動画ごとの性質**なので、初めに 1 度測って
 * 座標そのものを直す方が、速くて確実。
 *
 * 測り方: **等間隔に並ぶ 10 本の線が、いちばん「両隣のマス中央より暗く」なる
 * (原点, 間隔) を探す。** 格子線は暗い細線なので、正しく重なったときだけ差が開く。
 *
 * ⚠ 元の定数は「線上の輝度**合計**が最小」で求めたが、それでは足りなかった。
 * 盤には背景のグラデーションがあり、画面端には黒帯が出ることもあるので、
 * **格子でない所へ寄せた方が合計は下がりうる**。1 本ずつ測って**中央値**を採る。
 */

import type { BoardGeometry } from './geometry.ts';
import { boardRect } from './geometry.ts';
import { crop, type GrayImage } from './frame.ts';
import { bestShiftNcc, cellImage, ncc, resample, MATCH_INSET } from './template.ts';

export interface CalibrationResult {
  geo: BoardGeometry;
  /** 元の座標からのずれ（画素） */
  shift: { x: number; y: number };
  /** マス寸法の変化（画素） */
  resize: { w: number; h: number };
  /**
   * 格子線がどれだけはっきり出ているか。
   * 「線上の輝度」と「マス中央の輝度」の差。大きいほど信頼できる。
   */
  contrast: { x: number; y: number };
}

export interface CalibrateOptions {
  /** 原点を探す範囲（±画素） */
  originRange?: number;
  /** マス寸法を探す範囲（±割合） */
  pitchRange?: number;
  /** 原点の刻み */
  originStep?: number;
  /** マス寸法の刻み */
  pitchStep?: number;
}

/** 直交方向に平均した輝度の並び（縦線を探すなら列ごとの平均） */
function profile(img: GrayImage, vertical: boolean, from: number, to: number): Float64Array {
  const n = vertical ? img.width : img.height;
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(vertical ? img.height : img.width, Math.ceil(to));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = lo; j < hi; j++) {
      s += vertical ? img.data[j * img.width + i] : img.data[i * img.width + j];
    }
    out[i] = s / (hi - lo);
  }
  return out;
}

function at(prof: Float64Array, x: number): number | null {
  const i = Math.round(x);
  return i < 0 || i >= prof.length ? null : prof[i];
}

/**
 * 線 1 本ずつの「くっきりさ」＝ 両隣のマス中央より、どれだけ暗いか。
 *
 * ⚠ **合計ではなく 1 本ずつ測って中央値を採るのが要点。** 合計だと、外れた 1 本が
 * 極端な値を取るだけで全体が引きずられる（画面端の黒帯に線が 1 本乗るだけで、
 * そこが「最良」になってしまう）。中央値なら、駒に覆われた線が何本かあっても、
 * 黒帯に当たった線が 1〜2 本あっても効かない。
 *
 * ⚠ 「暗すぎる線は黒帯だから捨てる」という足切りも試したが**駄目だった**。
 * 背景が暗い場面では本物の格子線も同じくらい暗くなり、**正解の方が捨てられる**。
 * 外れ値に強くするのは足切りではなく中央値の仕事。
 */
function lineContrasts(prof: Float64Array, origin: number, pitch: number): number[] | null {
  const out: number[] = [];
  for (let i = 0; i <= 9; i++) {
    const line = at(prof, origin + pitch * i);
    if (line === null) return null; // 10 本すべてが画面内にあること
    const left = i > 0 ? at(prof, origin + pitch * (i - 0.5)) : null;
    const right = i < 9 ? at(prof, origin + pitch * (i + 0.5)) : null;
    const neighbours = [left, right].filter((v): v is number => v !== null);
    if (neighbours.length === 0) return null;
    out.push(neighbours.reduce((a, b) => a + b, 0) / neighbours.length - line);
  }
  return out;
}

/**
 * 当てはまりの良さ。**線の暗さそのものではなく、隣のマス中央との差の中央値**を使う。
 *
 * ⚠ 生の暗さで測ると失敗する。**盤には背景のグラデーションがある**（上ほど暗い）ので、
 * 格子でなくても暗い側へ寄せれば合計が下がる。さらに画面端の黒帯（別解像度からの
 * 切り出しや letterbox）に線が 1 本当たるだけで、そこが「最良」になってしまう。
 *
 * 実測（12 画素ずらした絵）: 合計で測ると「-4.75 画素ずれ・マス寸法 -0.95」と答えた。
 * 原点とマス寸法が互いを打ち消す degeneracy に落ちていた。中央値にすると当たる。
 */
function fitScore(prof: Float64Array, origin: number, pitch: number): number {
  const cs = lineContrasts(prof, origin, pitch);
  if (!cs) return -Infinity;
  const s = [...cs].sort((a, b) => a - b);
  return (s[4] + s[5]) / 2;
}

function search(
  prof: Float64Array,
  seedOrigin: number,
  seedPitch: number,
  opts: Required<CalibrateOptions>,
): { origin: number; pitch: number; contrast: number } {
  let best = { origin: seedOrigin, pitch: seedPitch, score: -Infinity };
  const pitchLo = seedPitch * (1 - opts.pitchRange);
  const pitchHi = seedPitch * (1 + opts.pitchRange);
  for (let pitch = pitchLo; pitch <= pitchHi; pitch += opts.pitchStep) {
    for (let o = seedOrigin - opts.originRange; o <= seedOrigin + opts.originRange; o += opts.originStep) {
      const score = fitScore(prof, o, pitch);
      if (score > best.score) best = { origin: o, pitch, score };
    }
  }
  return { origin: best.origin, pitch: best.pitch, contrast: best.score };
}

/**
 * フレーム 1 枚から盤の格子を測り直す。
 *
 * @param frame 盤が写っているフレーム（切り出す前の全体）
 * @param seed 出発点にする座標。ここから ±`originRange` 画素の範囲を探す。
 */
export function calibrateGeometry(
  frame: GrayImage,
  seed: BoardGeometry,
  options: CalibrateOptions = {},
): CalibrationResult {
  const opts: Required<CalibrateOptions> = {
    originRange: options.originRange ?? 24,
    pitchRange: options.pitchRange ?? 0.03,
    originStep: options.originStep ?? 0.25,
    pitchStep: options.pitchStep ?? 0.05,
  };

  // 盤の内側だけを見る。外の UI（持ち駒帯・ボタン）を巻き込まないように、
  // 探索範囲より広めに取ったうえで盤の中央寄りに寄せる。
  const cols = profile(frame, true, seed.originY + seed.cellH * 0.5, seed.originY + seed.cellH * 8.5);
  const rows = profile(frame, false, seed.originX + seed.cellW * 0.5, seed.originX + seed.cellW * 8.5);

  const x = search(cols, seed.originX, seed.cellW, opts);
  const y = search(rows, seed.originY, seed.cellH, opts);

  return {
    geo: { ...seed, originX: x.origin, originY: y.origin, cellW: x.pitch, cellH: y.pitch },
    shift: { x: x.origin - seed.originX, y: y.origin - seed.originY },
    resize: { w: x.pitch - seed.cellW, h: y.pitch - seed.cellH },
    contrast: { x: x.contrast, y: y.contrast },
  };
}

/**
 * 測り直した結果を採用してよいか。
 *
 * ⚠ **盤が写っていないフレーム**（対局者紹介の VS 画面・感想戦・広告）を渡しても、
 * 「いちばん暗い等間隔の 10 本」は必ずどこかに見つかる。**探索は必ず答えを返すので、
 * 答えが返ったことは盤があった証拠にならない。** 線のはっきりさで足切りする。
 *
 * 実測（同じ動画）:
 *
 * | フレーム | くっきり（縦, 横） |
 * |---|---|
 * | 盤が写っている 5 点 | (25.9〜32.3, 38.1〜43.5) |
 * | **0:00 の VS 画面** | **(9.4, 12.8)** ← 盤は無い |
 *
 * 間が広く空いているので 18 で切る。
 */
export function isCalibrationTrustworthy(result: CalibrationResult, minContrast = 18): boolean {
  return result.contrast.x >= minContrast && result.contrast.y >= minContrast;
}

/** 中身の分かっているマス。格子を詰め直すときの手掛かりになる。 */
export interface KnownCell {
  row: number;
  col: number;
  /** そこに写っているはずの駒の絵。寸法は違っていてよい（引き伸ばして合わせる）。 */
  template: GrayImage;
}

export interface RefineResult {
  geo: BoardGeometry;
  /** 詰め直す前後の一致度（中央値） */
  before: number;
  after: number;
  /** 各マスで測った、格子をずらすべき量（画素）。傾きが出ればマス寸法が違う。 */
  shifts: { row: number; col: number; dx: number; dy: number; score: number }[];
}

/**
 * y = a + b*x を当てはめる。**傾きは組ごとの傾きの中央値、切片は残差の中央値**
 * （Theil–Sen）。
 *
 * ⚠ **最小二乗では駄目だった。** 手掛かりのマスは全部が読めるとは限らない——
 * ハイライトが乗る、ポインタが被る、そもそも駒が違う。そういうマスは
 * 「探索範囲の端」というでたらめなずれを返す。最小二乗は二乗で効かせるので、
 * **1 枚の外れ値が全体の当てはめを壊す**。実際、合成した絵で試したときに
 * 一致度 0.00 のマスが 2 枚混ざっただけで、原点もマス寸法も動かせなくなった。
 *
 * 中央値なら、半分より少ない外れ値は結果に触れられない。
 */
function fitLine(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0 };
  if (n === 1) return { a: ys[0], b: 0 };

  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (xs[i] === xs[j]) continue;
      slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  const b = slopes.length > 0 ? median(slopes) : 0;
  return { a: median(xs.map((x, i) => ys[i] - b * x)), b };
}

/**
 * **格子線ではなく、中身の分かっているマスとの一致で格子を詰め直す。**
 *
 * `calibrateGeometry` は格子線を当てにするので、線がはっきり出ていれば
 * 正しい答えを返す。ところが**格子が合っていても照合が通らないこと**がある。
 * 外から受け取った絵（別の端末で撮った解析画面など）では、駒がマスの中の
 * どこに描かれるかが動画と微妙に違い、切り出しが数画素ずれるためである。
 *
 * 実測（受け取った解析画面）: 格子線での測り直しは効いていた（くっきりさ 39.4/36.0・
 * 当たりからのずれ 0.7 画素以内）のに、**そのまま照合すると 20 マス中 12 マスしか
 * 読めず NCC も 0.4 前後**だった。±5 画素ずらせば 20/20・NCC 0.9 に跳ね上がる。
 * つまり**測るべきは線の位置ではなく、駒の絵が実際に描かれている位置**だった。
 *
 * ⭐ ずれが**列や段に比例して増えていれば、それはマス寸法の誤り**（原点だけの
 * 問題ではない）。1 マスずつ測ったずれに直線を当てはめて、切片を原点の補正、
 * 傾きをマス寸法の補正として取り出す。
 *
 * @param known 中身の分かっているマス。**列と段が広く散っているほど寸法が正確に出る**
 *   （同じ段に固まっていると、傾きの手掛かりが片方向しか無い）。
 */
export function refineByTemplates(
  img: GrayImage,
  seed: BoardGeometry,
  known: KnownCell[],
  options: { inset?: number; range?: number; rounds?: number; minScore?: number } = {},
): RefineResult {
  const inset = options.inset ?? MATCH_INSET;
  const range = options.range ?? 6;
  const rounds = options.rounds ?? 3;
  /** 手掛かりとして使うのに必要な一致度。これを下回るマスは当てはめから外す。 */
  const minScore = options.minScore ?? 0.3;

  const measure = (geo: BoardGeometry) => {
    const board = crop(img, boardRect(geo));
    const cw = board.width / 9;
    const ch = board.height / 9;
    // 切り出したマスをテンプレートの寸法へ引き伸ばすので、ずれも同じ比率で戻す。
    const sx = Math.floor(cw * (1 - inset * 2));
    const sy = Math.floor(ch * (1 - inset * 2));
    return known.map((k) => {
      const cell = resample(cellImage(board, k.row, k.col, inset), k.template.width, k.template.height);
      const best = bestShiftNcc(cell, k.template, range);
      return {
        row: k.row,
        col: k.col,
        // テンプレート画素でのずれを、盤画像の画素に戻す
        dx: (best.dx * sx) / k.template.width,
        dy: (best.dy * sy) / k.template.height,
        score: best.score,
      };
    });
  };

  const scoreAt = (geo: BoardGeometry) => {
    const board = crop(img, boardRect(geo));
    const vs = known.map((k) =>
      ncc(resample(cellImage(board, k.row, k.col, inset), k.template.width, k.template.height), k.template),
    );
    return median(vs);
  };

  const before = scoreAt(seed);
  let geo = seed;
  let shifts = measure(geo);

  for (let i = 0; i < rounds; i++) {
    shifts = measure(geo);
    // 合わなかったマスは手掛かりにしない。ハイライトやポインタで潰れたマスは
    // 「探索範囲の端」というでたらめなずれを返すので、混ぜると当てはめが濁る。
    // ⚠ 全部落ちてしまったら、落とさずに当てはめる（動かないよりましなので）。
    const usable = shifts.filter((s) => s.score >= minScore);
    const use = usable.length >= 3 ? usable : shifts;
    const fx = fitLine(use.map((s) => s.col), use.map((s) => s.dx));
    const fy = fitLine(use.map((s) => s.row), use.map((s) => s.dy));
    // 切り出しの開始位置は origin + cell*index + cell*inset なので、
    // 寸法を b だけ動かすと inset のぶんも動く。原点はその分を差し引く。
    const next: BoardGeometry = {
      ...geo,
      originX: geo.originX + fx.a - fx.b * inset,
      originY: geo.originY + fy.a - fy.b * inset,
      cellW: geo.cellW + fx.b,
      cellH: geo.cellH + fy.b,
    };
    // 動きが画素以下になったら止める
    const moved = Math.abs(fx.a) + Math.abs(fy.a) + Math.abs(fx.b) * 9 + Math.abs(fy.b) * 9;
    geo = next;
    if (moved < 0.05) break;
  }

  return { geo, before, after: scoreAt(geo), shifts: measure(geo) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export interface VideoCalibration extends CalibrationResult {
  /** 測って採用できたフレーム数 */
  used: number;
  /** 測ろうとしたフレーム数 */
  tried: number;
}

/**
 * 複数のフレームから測って、中央値を採る。
 *
 * 1 枚だけで決めると、たまたま演出が乗った絵に引きずられる。ずれは動画ごとの
 * 性質で時間によらないはずなので、**何枚か測って同じ答えが出ることが確かめになる**。
 * 採用できる絵が 1 枚も無ければ null（呼び出し側は元の座標を使う）。
 */
export function calibrateFromFrames(
  frames: GrayImage[],
  seed: BoardGeometry,
  options: CalibrateOptions = {},
): VideoCalibration | null {
  const good = frames
    .map((f) => calibrateGeometry(f, seed, options))
    .filter((r) => isCalibrationTrustworthy(r));
  if (good.length === 0) return null;

  const geo: BoardGeometry = {
    ...seed,
    originX: median(good.map((r) => r.geo.originX)),
    originY: median(good.map((r) => r.geo.originY)),
    cellW: median(good.map((r) => r.geo.cellW)),
    cellH: median(good.map((r) => r.geo.cellH)),
  };
  return {
    geo,
    shift: { x: geo.originX - seed.originX, y: geo.originY - seed.originY },
    resize: { w: geo.cellW - seed.cellW, h: geo.cellH - seed.cellH },
    contrast: { x: median(good.map((r) => r.contrast.x)), y: median(good.map((r) => r.contrast.y)) },
    used: good.length,
    tried: frames.length,
  };
}
