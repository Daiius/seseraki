/**
 * 対局時計の「明るさ」で手番を追う（盤とは独立の拘束）
 *
 * 追記 169〜170 で分かったこと: **動いている方の時計が手番**であり、さらに
 * 手番でない側の時計は暗く沈めて描かれるので、時計窓の V（HSV の明度 =
 * RGB の最大値）の標準偏差を見るだけで **数字を読まずに 1 フレームで手番が
 * 分かる**（実測: 手番側 65〜83 / 非手番側 25〜35・Δ時計との突き合わせで
 * 170 区間完全一致）。
 *
 * 盤の読みは王手の演出（白閃光・赤「王手」文字）に覆われて切れることがあるが、
 * 時計は画面の上下の帯にあって演出の外にいる。ここで組み立てるのは:
 *
 *   1. 毎サンプルの手番の記録（`ClockTimeline`）
 *   2. 手番の**反転**の検出 ＝「このあたりで 1 手指された」という盤と独立の証拠
 *   3. 追いつき（挿し込み・2 手分解）の説明が時計と矛盾しないかの判定
 *
 * ⚠ **時計が決められるのは「手数・境目・手番」だけ。** 何を指したかは盤から
 * 取るしかない。だから使い方は「反転時刻の周辺を狙って読み直す」「手数の
 * 合わない説明を退ける」であって、時計から手を発明することではない。
 *
 * 🔒 時計が読めない素材（レイアウト違い・時計なし）では `brightSide*` が null を
 * 返し続け、タイムラインは何も主張しない——本線は従来どおりに動く。
 */
import type { GrayImage, YuvImage } from './frame.ts';
import { crop } from './frame.ts';

// ─────────────────────────────────────────────────────────────────────
// 座標（1080x1920・将棋ウォーズ縦画面）— probe-clock-audit.ts から移設
//
// 上（相手）は顔アイコンの右に左詰め、下（自分）は画面右端に右詰めで
// 「M:SS」が出る。測り方は probe-clock-audit.ts の説明を見ること。
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

/** 時計座標が前提とするフレーム寸法。違う素材では手番の指標は黙る。 */
export const CLOCK_FRAME_W = 1080;
export const CLOCK_FRAME_H = 1920;

export function digitImage(frame: GrayImage, geo: ClockGeometry, index: 0 | 1 | 2): GrayImage {
  return crop(frame, { x: geo.digitX[index], y: geo.y, w: geo.w, h: geo.h });
}

/** 画像の散らばり（字が写っていれば大きい）。真っ暗な窓を弾くのにも使う。 */
export function stdev(img: GrayImage): number {
  let s = 0;
  for (const v of img.data) s += v;
  const m = s / img.data.length;
  let d = 0;
  for (const v of img.data) d += (v - m) * (v - m);
  return Math.sqrt(d / img.data.length);
}

/**
 * 「いま光っている方の時計」を測る材料（数字を読まない独立の指標）。
 *
 * 手番でない側の時計は暗く沈めて描かれる。窓の標準偏差（V）で実測すると
 * **手番側 65〜80 に対し非手番側 27〜33** とはっきり分かれた。
 */
export function clockInk(valueFrame: GrayImage, geo: ClockGeometry): number {
  return (
    (stdev(digitImage(valueFrame, geo, 0)) +
      stdev(digitImage(valueFrame, geo, 1)) +
      stdev(digitImage(valueFrame, geo, 2))) /
    3
  );
}

/** 明るさの比がこれ以上ならどちらが手番か決める */
export const INK_RATIO = Number(process.env.KIFU_VISION_CLOCK_INK_RATIO ?? 1.5);

/** V（明度）のフレームから、光っている側を返す。割れなければ null。 */
export function brightSide(valueFrame: GrayImage): 'top' | 'bottom' | null {
  const t = clockInk(valueFrame, CLOCK_TOP);
  const b = clockInk(valueFrame, CLOCK_BOTTOM);
  if (t > b * INK_RATIO) return 'top';
  if (b > t * INK_RATIO) return 'bottom';
  return null;
}

/**
 * YUV フレームの窓だけを V（= max(R,G,B)）へ起こす。
 *
 * 走査の本線は既に yuvj444p のフレームを持っている（色は駒字の朱/黒判定に使う）。
 * 時計のためだけに rgb24 で取り直すのは ffmpeg の起動が高くつくので、
 * 手元の YUV から**窓の分だけ** RGB へ戻して V を取る（6 窓 ≈ 2.3 万画素）。
 *
 * 変換は BT.601 フルレンジ（yuvj444p はフルレンジ・u=Cb / v=Cr）:
 *   R = Y + 1.402(Cr−128)
 *   G = Y − 0.344136(Cb−128) − 0.714136(Cr−128)
 *   B = Y + 1.772(Cb−128)
 */
export function yuvValueWindow(
  frame: YuvImage,
  rect: { x: number; y: number; w: number; h: number },
): GrayImage {
  const { x, y, w, h } = rect;
  const data = new Uint8Array(w * h);
  for (let dy = 0; dy < h; dy++) {
    const src = (y + dy) * frame.width + x;
    const dst = dy * w;
    for (let dx = 0; dx < w; dx++) {
      const Y = frame.y[src + dx];
      const cb = frame.u[src + dx] - 128;
      const cr = frame.v[src + dx] - 128;
      const r = Y + 1.402 * cr;
      const g = Y - 0.344136 * cb - 0.714136 * cr;
      const b = Y + 1.772 * cb;
      const v = r > g ? (r > b ? r : b) : g > b ? g : b;
      data[dst + dx] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { width: w, height: h, data };
}

function clockInkYuv(frame: YuvImage, geo: ClockGeometry): number {
  let sum = 0;
  for (const i of [0, 1, 2] as const) {
    sum += stdev(
      yuvValueWindow(frame, { x: geo.digitX[i], y: geo.y, w: geo.w, h: geo.h }),
    );
  }
  return sum / 3;
}

/**
 * YUV フレームから、光っている側を返す。
 *
 * ⚠ 時計座標は 1080x1920 の将棋ウォーズ縦画面で測ったもの。寸法が違う素材では
 * 窓が別の場所を見てしまうので、指標そのものを出さない（null）。
 */
export function brightSideYuv(frame: YuvImage): 'top' | 'bottom' | null {
  if (frame.width !== CLOCK_FRAME_W || frame.height !== CLOCK_FRAME_H) return null;
  const t = clockInkYuv(frame, CLOCK_TOP);
  const b = clockInkYuv(frame, CLOCK_BOTTOM);
  if (t > b * INK_RATIO) return 'top';
  if (b > t * INK_RATIO) return 'bottom';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// 手番のタイムライン
// ─────────────────────────────────────────────────────────────────────

/**
 * 同じ側が何サンプル続いたら「本当にその側の手番」とみなすか。
 *
 * ポインタや紛れは 1 サンプルで消えるはず、という `ReadingHistory` と同じ理屈。
 * 0.5 秒刻みなら 2 サンプル ＝ 1 秒。これより速い応酬は反転として見えない
 * （見えなかった手は「時計が言う手数」に入らないだけで、嘘はつかない）。
 */
export const CLOCK_MIN_RUN = Number(process.env.KIFU_VISION_CLOCK_MIN_RUN ?? 2);

/**
 * 「窓を時計で判定してよい」と言うために許すサンプル間隔の上限（秒）。
 *
 * これより大きい穴（読めなかった・盤が写っていなかった）が窓にあると、
 * その間の反転を見逃しているかもしれないので、判定を出さない。
 * 0.5 秒刻みで 3 サンプル強を許す値にしてある。
 */
export const CLOCK_COVER_GAP = Number(process.env.KIFU_VISION_CLOCK_COVER_GAP ?? 1.6);

/**
 * ⏹ **「この窓で 1 手も指されていない」という否定の主張は、時計からは出さない。**
 *
 * かつては「判定できたサンプルが全部同じ側なら、間に手は無い」として挿し込みを
 * 止めていた（veto）。これは成り立たない——相手が即座に指し返すと手番は
 * `bottom → top → bottom` と往復し、**2 つのサンプルの隙間で完結する**ので
 * 時計には痕跡が 1 つも残らない。乱戦の取り返しは実際にこの速さで起こる
 * （review bot OCL-69066369・High）。
 *
 * サンプル間隔の上限で条件付ける案も採らなかった。**間隔をどれだけ詰めても
 * 「その隙間に往復が収まらない」ことは証明できない**（有限のサンプリングで
 * 不在は示せない）。閾値は「どれくらい起こりにくいか」を言い換えているだけで、
 * 否定の根拠にはならない。
 *
 * 🔒 **時計に言えるのは肯定だけにする。** 反転が見えたなら手はあった（`confirm`）。
 * 見えなかったことは何の証拠でもない（`unknown`）。**幻の挿し込みは、観測に
 * 基づく側——絶食・検疫（`src/absence.ts`。行き先が一度も駒として写らない）——が
 * 取り消す。** 3 本目の幻の角打ちは実際にそちらが独立に止めている。
 */

export type ClockSide = 'top' | 'bottom';

export interface ClockFlip {
  /** 反転の推定時刻（前の側の最後のサンプルと、次の側の最初のサンプルの中点） */
  t: number;
  /** 反転の前に光っていた側 ＝ **この反転で指した側** */
  from: ClockSide;
  /** 反転の後に光っている側 ＝ 次に指す側 */
  to: ClockSide;
}

export interface GapJudgement {
  /**
   * confirm: 窓の中の反転がちょうど 1 回で、指した側も期待と一致
   * unknown: 判定を出せない（被覆が足りない・反転が多い・期待とずれる・
   *          反転が 1 回も見えない）
   *
   * 🔒 **否定の verdict は無い。** 反転が見えないことは「手が無かった」ではない。
   */
  verdict: 'confirm' | 'unknown';
  /** confirm のとき、その反転の時刻 */
  flipTime?: number;
  /**
   * 📏 unknown のうち、「判定できたサンプルが全部同じ側だった」もの。
   *
   * ⭐ **旧実装が veto を出していた場所そのもの**（review bot OCL-69066369 で
   * 誤りと分かった推論）。判定には一切使わず、**どれだけの窓でその推論に
   * 頼っていたか**を数えるためだけに印を返す。
   */
  constantSide?: boolean;
}

interface Sample {
  t: number;
  side: ClockSide | null;
}

/**
 * 走査中に観測した「光っている側」の時系列。
 *
 * 記録はほぼ昇順に来る（格子の時刻）が、読み直しの挿し込みは過去の時刻を
 * 持ち込むので、挿入位置を探して順序を保つ。
 */
export class ClockTimeline {
  private samples: Sample[] = [];

  record(t: number, side: ClockSide | null): void {
    const s = this.samples;
    if (s.length === 0 || s[s.length - 1].t < t) {
      s.push({ t, side });
      return;
    }
    // 過去の時刻（読み直しの挿し込み）。二分探索で位置を探す。
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (s[lo] && s[lo].t === t) {
      s[lo] = { t, side }; // 同じ時刻は読み直しで上書き
      return;
    }
    s.splice(lo, 0, { t, side });
  }

  /** 記録済みのサンプル数（診断用） */
  get size(): number {
    return this.samples.length;
  }

  private inWindow(from: number, to: number): Sample[] {
    return this.samples.filter((s) => s.t >= from && s.t <= to);
  }

  /**
   * 窓の中を隙間なく見ていたか。
   *
   * 「反転が無い」と言い切るにはこれが要る。サンプルの間隔（窓の端との距離を
   * 含む）が `CLOCK_COVER_GAP` を超える穴があれば、その間の反転を見逃して
   * いるかもしれない。⚠ null（割れなかった）サンプルも**穴**として数える——
   * 割れない瞬間にこそ反転が居るかもしれないから。
   */
  hasCoverage(from: number, to: number, maxGap = CLOCK_COVER_GAP): boolean {
    const gap = this.maxDecidedGap(from, to);
    return gap !== null && gap <= maxGap;
  }

  /**
   * 窓の中で、判定できたサンプルどうしの**いちばん広い隙間**（窓の端との距離も含む）。
   *
   * ⭐ これが「時計で何を否定できるか」の物差しになる。見逃した手番があるとしても、
   * **この隙間より長くは続いていない**——言えるのはそこまでで、それ以上ではない。
   * ⚠ null（割れなかった）サンプルは穴として数える（割れない瞬間にこそ反転が居うる）。
   *
   * @returns サンプルが 1 つも無ければ null（何も測れていない）
   */
  maxDecidedGap(from: number, to: number): number | null {
    if (to <= from) return null;
    const decided = this.inWindow(from, to).filter((s) => s.side !== null);
    if (decided.length === 0) return null;
    let worst = 0;
    let prev = from;
    for (const s of decided) {
      worst = Math.max(worst, s.t - prev);
      prev = s.t;
    }
    return Math.max(worst, to - prev);
  }

  /**
   * 窓の中の手番の反転を数える。
   *
   * 平滑化: null を除いた列で同じ側の連続をまとめ、`CLOCK_MIN_RUN` 未満の
   * 短い連続は紛れとして捨てる。捨てたあとで隣り合う同じ側はつなぐ。
   * 残った塊の境目が反転で、時刻は両側のサンプルの中点。
   */
  flipsIn(from: number, to: number, minRun = CLOCK_MIN_RUN): ClockFlip[] {
    const decided = this.inWindow(from, to).filter((s) => s.side !== null) as {
      t: number;
      side: ClockSide;
    }[];
    // 同じ側の連続をまとめる
    interface Run {
      side: ClockSide;
      first: number;
      last: number;
      count: number;
    }
    const runs: Run[] = [];
    for (const s of decided) {
      const last = runs[runs.length - 1];
      if (last && last.side === s.side) {
        last.last = s.t;
        last.count++;
      } else {
        runs.push({ side: s.side, first: s.t, last: s.t, count: 1 });
      }
    }
    // 短い連続（紛れ）を捨て、隣り合う同じ側をつなぐ
    const kept: Run[] = [];
    for (const r of runs) {
      if (r.count < minRun) continue;
      const last = kept[kept.length - 1];
      if (last && last.side === r.side) {
        last.last = r.last;
        last.count += r.count;
      } else {
        kept.push({ ...r });
      }
    }
    const flips: ClockFlip[] = [];
    for (let i = 1; i < kept.length; i++) {
      flips.push({
        t: (kept[i - 1].last + kept[i].first) / 2,
        from: kept[i - 1].side,
        to: kept[i].side,
      });
    }
    return flips;
  }

  /**
   * 窓の中で（判定できた）サンプルが**全部同じ側**だったなら、その側を返す。
   *
   * ⚠ `flipsIn` は `CLOCK_MIN_RUN` 未満の短い連続を紛れとして捨てるので、
   * 「反転 0 回」だけでは **1 秒未満の速い手**（打った駒がその場で取られる形）を
   * 見逃した場合と区別できない。こちらは短い連続も含めて 1 サンプルでも
   * 別の側が写っていれば null を返す——`flipsIn` より強い条件ではある。
   *
   * 🔴 **だがこれは「間に手は無かった」の証拠にならない。** 手番が**サンプルの
   * 隙間で完結する**（0.5 秒未満で指し返す）と、別の側は 1 サンプルにも写らない。
   * 🔒 **否定には使わない**（このファイル冒頭「否定の主張は出さない」の項）。
   * 用途は「その推論に頼っていた窓がどれだけあったか」を数える診断だけ。
   */
  constantSideIn(from: number, to: number): ClockSide | null {
    const decided = this.inWindow(from, to).filter((s) => s.side !== null);
    if (decided.length < CLOCK_MIN_RUN) return null;
    const side = decided[0].side;
    return decided.every((s) => s.side === side) ? side : null;
  }

  /**
   * 「t0 の手と t1 の手のあいだに、side の相手の手が 1 手だけあったはず」という
   * 挿し込みの仮説を、時計で検める。
   *
   * `expectedMover` は挿し込もうとしている手の側（＝反転で指したはずの側）を
   * **画面の側**（top/bottom）で渡す。
   *
   * 🔒 **返すのは肯定（`confirm`）か判定不能（`unknown`）だけ。** 反転が
   * 1 回も見えないことを「間に手は無い」と読み替えない——手番はサンプルの
   * 隙間で往復しうるので、見えないことは何の証拠でもない。
   * ⚠ 窓の両端は手そのものの反転が掛かるので、少し内側だけを見る。
   *
   * 全サンプル同側だった窓には `constantSide` の印だけ付けて unknown を返す。
   * 挿し込みは従来どおり行われ、**幻は絶食・検疫（`src/absence.ts`）が
   * 後から取り消す**——そちらは「写らなかった」という観測に基づくので、
   * サンプルの隙間に隠れる余地が無い。
   */
  judgeGap(from: number, to: number, expectedMover: ClockSide): GapJudgement {
    if (to - from < 2) return { verdict: 'unknown' }; // 端を除くと何も残らない
    const flips = this.flipsIn(from, to);
    if (flips.length === 1 && flips[0].from === expectedMover) {
      return { verdict: 'confirm', flipTime: flips[0].t };
    }
    const inner = { from: from + 0.6, to: to - 0.6 };
    if (flips.length === 0 && this.constantSideIn(inner.from, inner.to) !== null) {
      // 全サンプル同側。**それでも否定しない**（隙間に手番が収まりうる）。
      return { verdict: 'unknown', constantSide: true };
    }
    return { verdict: 'unknown' };
  }
}

/**
 * 内部の手番ラベル（走査中は「画面の下＝sente」で組んである）を画面の側へ写す。
 * 実際の先後への回転は書き出し時に行われるので、走査中はこれでよい。
 */
export function screenSideOf(side: 'sente' | 'gote'): ClockSide {
  return side === 'sente' ? 'bottom' : 'top';
}

/**
 * 反転時刻の周辺で「読みに行く価値のある」時刻を作る。
 *
 * 手が指された直後 1〜2 秒は演出（白閃光・王手の文字・着手ハイライト）に
 * 覆われやすいので、**指す直前**（反転の少し前）と**演出が引いたあと**を狙う。
 * 実測（追記 172 予定）で調整すること。
 */
export const CLOCK_REREAD_OFFSETS: readonly number[] = [-1.0, 2.0, 3.0];

export function rereadTimes(
  flips: readonly { t: number }[],
  bounds: { from: number; to: number },
  offsets: readonly number[] = CLOCK_REREAD_OFFSETS,
): number[] {
  const out = new Set<number>();
  for (const f of flips) {
    for (const o of offsets) {
      const t = Number((f.t + o).toFixed(3));
      if (t > bounds.from && t < bounds.to) out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}
