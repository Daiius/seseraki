/**
 * 時計で棋譜の手番を検算する（本線には触れない独立プローブ）
 *
 * 追記 169 で分かったこと: **動いている方の時計が手番**。盤・色・駒種は
 * 手番のずれに沈黙するが、時計は手番そのものを直接示す。
 * ここではそれを全局・全手に自動で当てる。
 *
 *   pnpm --filter kifu-vision exec tsx probe-clock-audit.ts <動画> <棋譜 json> [--verbose]
 *   pnpm --filter kifu-vision exec tsx probe-clock-audit.ts <動画> --bootstrap <開始秒> <秒数>
 *
 * 🔒 認識の本線（extract-simple / scan-video）とは一切繋がっていない。
 */
import { readFileSync } from 'node:fs';
import { grabColorFrame, crop, type GrayImage } from './src/frame.ts';
import { ncc, shiftImage } from './src/template.ts';

// ─────────────────────────────────────────────────────────────────────
// 座標（1080x1920・将棋ウォーズ縦画面）
//
// 上（相手）は顔アイコンの右に **左詰め**、下（自分）は画面右端に **右詰め**で
// 「M:SS」が出る。数字の桁は 46〜47 画素間隔で並ぶので、幅 48 の窓を
// 字の中心に置けば隣の桁もコロンも入らない。字の高さは 72 画素（y 方向）。
//
// 測り方: 帯を V（RGB の最大値）で 2 値化し、列ごとの ink 数の塊を数えた。
// 3 時刻・上下で安定して次の塊が出る（数字は幅 33〜39・コロンは幅 12〜16）:
//   上 分 110..142 / コロン 158..173 / 秒十 189..224 / 秒一 230..263
//   下 分 916..954 / コロン 968..979 / 秒十 998..1031 / 秒一 1037..1072
// 🔴 **秒の 2 桁は 40 画素間隔で、分とコロンの側は 80 画素離れている。**
//    最初 47 画素間隔だと思って窓を置き、秒一の位だけが誤読された。
// ⚠ 上は左詰めなので **10:00（開始直後）だけ桁が右へ 1 つずれる**。
//    その数フレームは「読めない」として捨てる（下は右詰めなのでずれない）。
// ─────────────────────────────────────────────────────────────────────
export interface ClockGeometry {
  /** 分・秒十・秒一 の窓の左端 x */
  digitX: [number, number, number];
  y: number;
  w: number;
  h: number;
}

export const CLOCK_TOP: ClockGeometry = { digitX: [102, 182, 222], y: 214, w: 48, h: 80 };
export const CLOCK_BOTTOM: ClockGeometry = { digitX: [910, 990, 1030], y: 1588, w: 48, h: 80 };

const FRAME_W = 1080;
const FRAME_H = 1920;

/**
 * 「明度」フレーム（HSV の V ＝ RGB の最大値）を取る。
 *
 * 🔴 **輝度（-pix_fmt gray）では上の時計が読めなかった。** 手番でない側の時計は
 * 暗く沈んだ赤で描かれ、輝度に落とすと背景との差が消える（実測: 窓の標準偏差が
 * 白い時計 75〜83 に対し 13〜17、NCC も 0.34〜0.48 までしか出ない）。
 * V なら白い字も赤い字も高い値を取り、暗い箱の背景とはっきり分かれる。
 */
function grabValueFrame(video: string, seconds: number): GrayImage {
  const rgb = grabColorFrame(video, seconds, FRAME_W, FRAME_H);
  const data = new Uint8Array(FRAME_W * FRAME_H);
  for (let i = 0; i < data.length; i++) {
    const r = rgb.data[i * 3], g = rgb.data[i * 3 + 1], b = rgb.data[i * 3 + 2];
    data[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  return { width: FRAME_W, height: FRAME_H, data };
}

export function digitImage(frame: GrayImage, geo: ClockGeometry, index: 0 | 1 | 2): GrayImage {
  return crop(frame, { x: geo.digitX[index], y: geo.y, w: geo.w, h: geo.h });
}

/** 画像の散らばり（字が写っていれば大きい）。真っ暗な窓を弾くのに使う。 */
function stdev(img: GrayImage): number {
  let s = 0;
  for (const v of img.data) s += v;
  const m = s / img.data.length;
  let d = 0;
  for (const v of img.data) d += (v - m) * (v - m);
  return Math.sqrt(d / img.data.length);
}

function meanAbsDiff(a: GrayImage, b: GrayImage): number {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return s / a.data.length;
}

// ─────────────────────────────────────────────────────────────────────
// 数字テンプレートの自動生成
//
// 🔒 **ラベルを人手で付けない。** 秒の一の位は 1 秒ごとに 1 ずつ減り、
// 9 へ折り返した瞬間に十の位が変わる。だから
//   「十の位が変わる直前のサンプル＝0」
// と決めれば、あとは (j - i) mod 10 で全サンプルのラベルが決まる。
// 駒テンプレートを初期局面から起こしたのと同じ考え方（外から用意しない）。
// ─────────────────────────────────────────────────────────────────────
export interface DigitTemplates {
  /** 0..9 の平均画像 */
  imgs: GrayImage[];
  /** 診断値 */
  diag: {
    side: 'top' | 'bottom';
    samples: number;
    perLabel: number[];
    withinMin: number;
    crossMax: number;
    /** 類を何個ずらして数字に割り当てたか（時計の性質から自動で決まる） */
    rotation: number;
    /** その回し方で「ちょうど 1 秒ずつ減った」サンプル数 */
    rotationScore: number;
  };
}

function averageImages(imgs: GrayImage[]): GrayImage {
  const { width, height } = imgs[0];
  const acc = new Float64Array(width * height);
  for (const im of imgs) for (let i = 0; i < acc.length; i++) acc[i] += im.data[i];
  const data = new Uint8Array(acc.length);
  for (let i = 0; i < acc.length; i++) data[i] = Math.round(acc[i] / imgs.length);
  return { width, height, data };
}

export function bootstrapDigits(video: string, from: number, seconds: number): DigitTemplates {
  const N = Math.max(20, Math.min(60, Math.floor(seconds)));
  const cells: Record<'top' | 'bottom', GrayImage[][]> = { top: [[], [], []], bottom: [[], [], []] };
  for (let i = 0; i < N; i++) {
    const f = grabValueFrame(video, from + i);
    for (const g of [CLOCK_TOP, CLOCK_BOTTOM] as const) {
      const key = g === CLOCK_TOP ? 'top' : 'bottom';
      for (const d of [0, 1, 2] as const) cells[key][d].push(digitImage(f, g, d));
    }
  }

  // 1 秒ごとに一の位が変わっている方＝走っている時計。
  // ⚠ 窓の中で手番が変わることもあるので、**変わり続けている最長の連続区間**を使う。
  let side: 'top' | 'bottom' = 'top';
  let range = { from: 0, len: 0 };
  for (const s of ['top', 'bottom'] as const) {
    let start = 0;
    for (let i = 1; i <= N; i++) {
      const changed = i < N && meanAbsDiff(cells[s][2][i - 1], cells[s][2][i]) > 6;
      if (!changed) {
        if (i - start > range.len) { range = { from: start, len: i - start }; side = s; }
        start = i;
      }
    }
  }
  if (range.len < 20) throw new Error(`走り続けている時計の区間が短すぎます（${range.len} 秒）`);

  // ラベルはまだ分からないので、**まず 10 個の類へ分けるだけ**にする。
  // 一の位は 1 秒ごとに 1 ずつ減るので、添字を 10 で割った余りが同じものは同じ数字。
  const groups: GrayImage[][] = Array.from({ length: 10 }, () => []);
  for (let i = range.from; i < range.from + range.len; i++) {
    groups[((-i) % 10 + 10) % 10].push(cells[side][2][i]);
  }
  if (groups.some((g) => g.length === 0)) throw new Error('10 個の類が揃いませんでした');
  const base = groups.map(averageImages);

  // ⭐ **回し方（どの類が 0 か）は、時計そのものに決めさせる。**
  // 🔴 最初は「十の位が変わる直前が 0」で決めていた。**背景の演出で十の位の窓が
  //    動いた場所を掴んで 1 つずれ、3 本目の時計が全桁 −1 で読まれた**
  //    （7:50 を 6:49・0:40 を 9:39）。ずれても各桁の見た目は整合するので気づけない。
  //    ずれた側は「秒の十の位が 9」を頻繁に出すので `×`（読めない）が量産され、
  //    残った読みも 10 秒ずれる——3 本目で判断できない区間が半分になった正体がこれ。
  // 正しい回し方なら、1 秒ごとのサンプルで **時計の値がちょうど 1 ずつ減る**。
  // ずれていると十の位の繰り下がりのたびに −11 などが出るので、10 通り試すと 1 つだけ残る。
  // **外から答えを与えず、時計の性質だけで決まる。**
  //
  // ⚠ 10 通りを素朴に読み直すと NCC が 10 倍かかる。**類の判定は回し方に依らない**ので、
  // サンプルごとの「どの類か」を 1 度だけ求めて、回し方は添字の付け替えだけで済ませる。
  const cls: (number | null)[][] = [0, 1, 2].map((d) =>
    Array.from({ length: range.len }, (_, k) => classifyBase(cells[side][d][range.from + k], base)),
  );
  let bestRot = 0;
  let bestScore = -1;
  const rotScores: number[] = [];
  for (let rot = 0; rot < 10; rot++) {
    // imgs[v] = base[(v + rot) % 10] なので、類 c は数字 (c - rot) mod 10
    const val = (c: number | null) => (c === null ? null : ((c - rot) % 10 + 10) % 10);
    let good = 0;
    let prev: number | null = null;
    for (let k = 0; k < range.len; k++) {
      const m = val(cls[0][k]), s10 = val(cls[1][k]), s1 = val(cls[2][k]);
      const v = m === null || s10 === null || s1 === null || s10 > 5 ? null : m * 60 + s10 * 10 + s1;
      if (v !== null && prev !== null && prev - v === 1) good++;
      prev = v;
    }
    rotScores[rot] = good;
    if (good > bestScore) { bestScore = good; bestRot = rot; }
  }
  const runnerUp = Math.max(...rotScores.map((v, r) => (r === bestRot ? -1 : v)));
  if (bestScore < range.len - 5 || bestScore <= runnerUp + 3) {
    throw new Error(`回し方を決められません（最良 ${bestScore}/${range.len - 1}・次点 ${runnerUp}）`);
  }
  const imgs = base.map((_, d) => base[(d + bestRot) % 10]);

  // 診断: 同じ数字の中の最悪一致と、別の数字どうしの最良一致
  let withinMin = 1;
  for (let d = 0; d < 10; d++) {
    for (const im of groups[(d + bestRot) % 10]) withinMin = Math.min(withinMin, ncc(imgs[d], im));
  }
  let crossMax = -1;
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) {
    if (a !== b) crossMax = Math.max(crossMax, ncc(imgs[a], imgs[b]));
  }
  return {
    imgs,
    diag: {
      side, samples: range.len, perLabel: groups.map((g) => g.length), withinMin, crossMax,
      rotation: bestRot, rotationScore: bestScore,
    },
  };
}

/** どの類にいちばん近いかだけを返す（回し方に依らないので 1 度だけ計算する） */
function classifyBase(img: GrayImage, base: GrayImage[]): number | null {
  if (stdev(img) < MIN_SD) return null;
  let best = -Infinity;
  let second = -Infinity;
  let cls = -1;
  for (let d = 0; d < base.length; d++) {
    let sc = -Infinity;
    for (let dy = -SHIFT_Y; dy <= SHIFT_Y; dy++) {
      for (let dx = -SHIFT_X; dx <= SHIFT_X; dx++) {
        const v = ncc(img, shiftImage(base[d], dx, dy));
        if (v > sc) sc = v;
      }
    }
    if (sc > best) { second = best; best = sc; cls = d; }
    else if (sc > second) second = sc;
  }
  return best < MIN_SCORE ? null : cls;
}
// ─────────────────────────────────────────────────────────────────────
// 読み取り
// ─────────────────────────────────────────────────────────────────────
export interface DigitRead { value: number; score: number; margin: number }

/** 字が写っていないと見なす散らばりの下限（真っ黒 / 単色の窓を弾く） */
const MIN_SD = 8;
/**
 * テンプレートを当てるときに探すずれの幅。
 *
 * 🔴 **±3 では足りなかった。** 桁の窓は等間隔（46〜47px）に置いてあるが、
 * 字は等幅ではないので窓の中での位置が桁ごとに 4〜5 画素ずれる（実測: 同じ
 * 「3」が秒十の位では窓内 x=6..40、秒一の位では x=2..35）。±3 だと後者が
 * 「1」と誤読された。
 */
const SHIFT_X = Number(process.env.KIFU_VISION_CLOCK_SHIFT_X ?? 7);
const SHIFT_Y = Number(process.env.KIFU_VISION_CLOCK_SHIFT_Y ?? 4);
/** 採用する NCC の下限 */
const MIN_SCORE = Number(process.env.KIFU_VISION_CLOCK_MIN_SCORE ?? 0.72);

export function readDigit(img: GrayImage, t: DigitTemplates): DigitRead | null {
  if (stdev(img) < MIN_SD) { if (process.env.KIFU_VISION_CLOCK_DEBUG) console.log(`    sd=${stdev(img).toFixed(1)} 低すぎ`); return null; }
  const scores: number[] = [];
  for (let d = 0; d < 10; d++) {
    let best = -Infinity;
    for (let dy = -SHIFT_Y; dy <= SHIFT_Y; dy++) {
      for (let dx = -SHIFT_X; dx <= SHIFT_X; dx++) {
        const s = ncc(img, shiftImage(t.imgs[d], dx, dy));
        if (s > best) best = s;
      }
    }
    scores[d] = best;
  }
  const order = scores.map((s, d) => ({ s, d })).sort((a, b) => b.s - a.s);
  if (process.env.KIFU_VISION_CLOCK_DEBUG) console.log(`    sd=${stdev(img).toFixed(1)} 上位: ` + order.slice(0,3).map(o=>`${o.d}:${o.s.toFixed(3)}`).join(' '));
  if (order[0].s < MIN_SCORE) return null;
  return { value: order[0].d, score: order[0].s, margin: order[0].s - order[1].s };
}

export interface ClockRead { seconds: number; worst: number }

/**
 * 「いま光っている方の時計」を返す（数字を読まない独立の指標）。
 *
 * 手番でない側の時計は暗く沈めて描かれる。窓の標準偏差（V）で実測すると
 * **手番側 65〜80 に対し非手番側 27〜33** とはっきり分かれた。
 * Δ時計と違って **1 フレームだけで手番が分かる**ので、手が密に並ぶ場所でも使える。
 */
export function clockInk(frame: GrayImage, geo: ClockGeometry): number {
  return (stdev(digitImage(frame, geo, 0)) + stdev(digitImage(frame, geo, 1)) + stdev(digitImage(frame, geo, 2))) / 3;
}

/** 明るさの比がこれ以上ならどちらが手番か決める */
const INK_RATIO = Number(process.env.KIFU_VISION_CLOCK_INK_RATIO ?? 1.5);

export function brightSide(frame: GrayImage): 'top' | 'bottom' | null {
  const t = clockInk(frame, CLOCK_TOP);
  const b = clockInk(frame, CLOCK_BOTTOM);
  if (t > b * INK_RATIO) return 'top';
  if (b > t * INK_RATIO) return 'bottom';
  return null;
}

export function readClock(frame: GrayImage, geo: ClockGeometry, t: DigitTemplates): ClockRead | null {
  const m = readDigit(digitImage(frame, geo, 0), t);
  const s10 = readDigit(digitImage(frame, geo, 1), t);
  const s1 = readDigit(digitImage(frame, geo, 2), t);
  if (!m || !s10 || !s1) return null;
  if (s10.value > 5) return null; // 秒の十の位は 0..5。外れたら読み違い。
  return { seconds: m.value * 60 + s10.value * 10 + s1.value, worst: Math.min(m.score, s10.score, s1.score) };
}

// ─────────────────────────────────────────────────────────────────────
// 検算
// ─────────────────────────────────────────────────────────────────────
interface Move { time: number; usi: string; side: 'sente' | 'gote' }

export interface IntervalCheck {
  index: number;      // moves[index] を指すまでの考慮時間
  usi: string;
  kifuSide: 'sente' | 'gote';
  expected: 'top' | 'bottom';
  from: number; to: number; span: number;
  dTop: number | null; dBottom: number | null;
  /** 数字を読まない独立の指標（区間の両端で光っていた側） */
  brightFrom: 'top' | 'bottom' | null;
  brightTo: 'top' | 'bottom' | null;
  verdict: 'ok' | 'mismatch' | 'missing' | 'unknown';
  note: string;
}

const PAD = Number(process.env.KIFU_VISION_CLOCK_PAD ?? 1.5);
const MIN_SPAN = Number(process.env.KIFU_VISION_CLOCK_MIN_SPAN ?? 8);
/** 走っている側の減りが span からこれ以上ずれたら判断しない */
const TOL = Number(process.env.KIFU_VISION_CLOCK_TOL ?? 2);
/** 止まっている側の減りの上限 */
const STILL = Number(process.env.KIFU_VISION_CLOCK_STILL ?? 1);

export function auditGame(
  video: string,
  moves: Move[],
  bottomIsSente: boolean,
  templates: DigitTemplates,
  verbose = false,
): IntervalCheck[] {
  const screenOf = (s: 'sente' | 'gote'): 'top' | 'bottom' =>
    (s === 'sente') === bottomIsSente ? 'bottom' : 'top';

  const cache = new Map<number, GrayImage>();
  const frameAt = (t: number): GrayImage => {
    const key = Math.round(t * 10);
    let f = cache.get(key);
    if (!f) { f = grabValueFrame(video, t); cache.set(key, f); }
    return f;
  };

  const out: IntervalCheck[] = [];
  for (let k = 1; k < moves.length; k++) {
    const from = moves[k - 1].time + PAD;
    const to = moves[k].time - PAD;
    if (moves[k].time - moves[k - 1].time < MIN_SPAN) continue;
    const span = to - from;
    if (span < 4) continue;

    const fa = frameAt(from);
    const fb = frameAt(to);
    const ta = readClock(fa, CLOCK_TOP, templates);
    const tb = readClock(fb, CLOCK_TOP, templates);
    const ba = readClock(fa, CLOCK_BOTTOM, templates);
    const bb = readClock(fb, CLOCK_BOTTOM, templates);
    const dTop = ta && tb ? ta.seconds - tb.seconds : null;
    const dBottom = ba && bb ? ba.seconds - bb.seconds : null;

    const expected = screenOf(moves[k].side);
    let verdict: IntervalCheck['verdict'] = 'unknown';
    let note = '';
    if (dTop === null || dBottom === null) {
      note = `読めない（top=${dTop === null ? '×' : dTop} bottom=${dBottom === null ? '×' : dBottom}）`;
    } else {
      const runs = (d: number) => Math.abs(d - span) <= TOL;
      const still = (d: number) => d >= -STILL && d <= STILL;
      const topRuns = runs(dTop) && still(dBottom);
      const botRuns = runs(dBottom) && still(dTop);
      if (topRuns && !botRuns) verdict = expected === 'top' ? 'ok' : 'mismatch';
      else if (botRuns && !topRuns) verdict = expected === 'bottom' ? 'ok' : 'mismatch';
      else if (dTop >= 3 && dBottom >= 3 && Math.abs(dTop + dBottom - span) <= TOL) {
        // 🔒 **区間の途中で手番が変わっている。** 棋譜はこの区間に手が 1 つも無いと
        // 言っているのに、両方の時計が減っている。切り替わった時刻まで分かる
        // （from + 先に走っていた側の減り）。
        // ⚠ **「手を取りこぼした」と決めつけない。** 1 本目 65 手目で絵を見たところ、
        //    手は棋譜にあり、**その時刻が 19.5 秒遅かった**（盤は 877 秒で動いているのに
        //    棋譜は 896.5 秒と言う）。区間の**境目がずれている**ことしか分からない。
        verdict = 'missing';
        const first = expected === 'top' ? dTop : dBottom;
        note = `区間の途中で手番が変わった＝境目がずれている（切替は ${(from + first).toFixed(0)} 秒ごろ・Δ上=${dTop} Δ下=${dBottom} 経過=${span.toFixed(1)}）`;
      } else note = `どちらとも言えない（span=${span.toFixed(1)} dTop=${dTop} dBottom=${dBottom}）`;
    }
    const row: IntervalCheck = {
      index: k, usi: moves[k].usi, kifuSide: moves[k].side, expected,
      from, to, span, dTop, dBottom,
      brightFrom: brightSide(fa), brightTo: brightSide(fb),
      verdict, note,
    };
    out.push(row);
    if (verbose) {
      console.log(
        `  #${String(k + 1).padStart(3)} ${moves[k].usi.padEnd(6)} ${moves[k].side === 'sente' ? '▲' : '▽'}`
        + ` 期待=${expected.padEnd(6)} ${from.toFixed(1)}→${to.toFixed(1)}(${span.toFixed(1)}s)`
        + ` Δ上=${dTop === null ? ' ×' : String(dTop).padStart(3)} Δ下=${dBottom === null ? ' ×' : String(dBottom).padStart(3)}`
        + ` 光=${(row.brightFrom ?? '?').padEnd(6)}${(row.brightTo ?? '?').padEnd(6)}`
        + ` ${verdict === 'ok' ? '✅' : verdict === 'mismatch' ? '🔴 手番が逆' : verdict === 'missing' ? '🟠 境目ずれ: ' + row.note : '❔ ' + row.note}`,
      );
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────
function pickBootstrapWindow(moves: Move[]): { from: number; seconds: number } {
  let best = { from: moves[0].time, seconds: 0 };
  for (let k = 1; k < moves.length; k++) {
    const gap = moves[k].time - moves[k - 1].time;
    if (gap > best.seconds) best = { from: moves[k - 1].time + 2, seconds: gap - 3 };
  }
  return best;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('使い方: tsx probe-clock-audit.ts <動画> <棋譜 json>... [--verbose]');
  console.error('        tsx probe-clock-audit.ts <動画> --bootstrap <開始秒> <秒数>');
  process.exit(1);
}
const video = args[0];
const verbose = args.includes('--verbose');

if (args[1] === '--bootstrap') {
  const t = bootstrapDigits(video, Number(args[2]), Number(args[3]));
  console.log(`# テンプレート生成: ${t.diag.side} の時計 / ${t.diag.samples} サンプル`);
  console.log(`  ラベルごとの枚数: ${t.diag.perLabel.join(' ')}`);
  console.log(`  同ラベル内の最悪一致 ${t.diag.withinMin.toFixed(3)} / 別ラベル間の最良一致 ${t.diag.crossMax.toFixed(3)}`);
  console.log(`  回し方 ${t.diag.rotation}（1 秒ずつ減ったサンプル ${t.diag.rotationScore}/${t.diag.samples - 1}）`);
  process.exit(0);
}

if (args[1] === '--read') {
  // 使い方: --read <bootstrap開始> <bootstrap秒数> <読む秒>...
  const t = bootstrapDigits(video, Number(args[2]), Number(args[3]));
  console.log(`# テンプレート: ${t.diag.side} / 同ラベル最悪 ${t.diag.withinMin.toFixed(3)} / 別ラベル最良 ${t.diag.crossMax.toFixed(3)} / 回し方 ${t.diag.rotation}（${t.diag.rotationScore}/${t.diag.samples - 1}）`);
  const fmt = (r: ClockRead | null) => (r === null ? '  読めず' : `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, '0')}(${r.worst.toFixed(2)})`);
  for (const a of args.slice(4)) {
    const sec = Number(a);
    const f = grabValueFrame(video, sec);
    console.log(`  t=${a}: 上 ${fmt(readClock(f, CLOCK_TOP, t))}  下 ${fmt(readClock(f, CLOCK_BOTTOM, t))}`);
  }
  process.exit(0);
}

const kifuPaths = args.slice(1).filter((a) => !a.startsWith('--'));
let templates: DigitTemplates | null = null;
const summary: string[] = [];

for (const path of kifuPaths) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const runs = [...data.runs].sort((a: any, b: any) => a.startedAt - b.startedAt);
  const moves: Move[] = runs[0].moves;
  if (!templates) {
    const w = pickBootstrapWindow(moves);
    templates = bootstrapDigits(video, w.from, w.seconds);
    console.log(`# 数字テンプレート: ${w.from.toFixed(0)} 秒から ${templates.diag.samples} 秒間の ${templates.diag.side} の時計から自動生成`);
    console.log(`  ラベルごとの枚数 ${templates.diag.perLabel.join(' ')} / 同ラベル最悪 ${templates.diag.withinMin.toFixed(3)} / 別ラベル最良 ${templates.diag.crossMax.toFixed(3)} / 回し方 ${templates.diag.rotation}（1 秒刻み ${templates.diag.rotationScore}/${templates.diag.samples - 1}）\n`);
  }
  console.log(`== ${path.split('/').pop()}（${data.game} 局目・${data.bottomIsSente ? '下が先手' : '上が先手'}・${moves.length} 手）`);
  const rows = auditGame(video, moves, data.bottomIsSente, templates, verbose);
  const ok = rows.filter((r) => r.verdict === 'ok').length;
  const bad = rows.filter((r) => r.verdict === 'mismatch');
  const miss = rows.filter((r) => r.verdict === 'missing');
  const unk = rows.filter((r) => r.verdict === 'unknown');
  // ⚠ 区間の途中で手番が変わった行は「どちらが多く減ったか」に意味が無いので外す。
  const inkRows = rows.filter((r) => r.verdict !== 'missing' && r.brightFrom !== null && r.brightFrom === r.brightTo && r.dTop !== null && r.dBottom !== null);
  const inkAgree = inkRows.filter((r) => r.brightFrom === (r.dTop! > r.dBottom! ? 'top' : 'bottom')).length;
  console.log(`   検算できた区間 ${rows.length}（${MIN_SPAN} 秒以上の考慮時間）: 一致 ${ok} / 🔴 手番が逆 ${bad.length} / 🟠 境目ずれ ${miss.length} / 判断せず ${unk.length}`);
  console.log(`   明るさの指標（数字を読まない）と Δ時計の一致: ${inkAgree}/${inkRows.length}`);
  for (const r of bad) {
    console.log(`   🔴 ${r.index + 1} 手目 ${r.usi}（${r.kifuSide === 'sente' ? '先手' : '後手'}＝画面${r.expected === 'top' ? '上' : '下'}）`
      + ` ${r.from.toFixed(1)}〜${r.to.toFixed(1)} 秒: 実際に減ったのは画面${r.dTop! > r.dBottom! ? '上' : '下'}`
      + `（Δ上=${r.dTop} Δ下=${r.dBottom} / 経過 ${r.span.toFixed(1)} / 光っていたのは ${r.brightFrom ?? '?'}→${r.brightTo ?? '?'}）`);
  }
  for (const r of miss) console.log(`   🟠 ${r.index + 1} 手目 ${r.usi} の前 ${r.from.toFixed(1)}〜${r.to.toFixed(1)} 秒: ${r.note}`);
  if (!verbose) for (const r of unk) console.log(`   ❔ ${r.index + 1} 手目 ${r.usi} ${r.from.toFixed(1)}〜${r.to.toFixed(1)}: ${r.note}`);
  summary.push(`${path.split('/').pop()}: 区間 ${rows.length} / 一致 ${ok} / 逆 ${bad.length} / 境目ずれ ${miss.length} / 不明 ${unk.length}`);
}

console.log('\n# まとめ');
for (const s of summary) console.log(`  ${s}`);
