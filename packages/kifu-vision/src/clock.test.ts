import { describe, expect, it } from 'vitest';
import type { YuvImage } from './frame.ts';
import {
  ClockTimeline,
  brightSideYuv,
  yuvValueWindow,
  rereadTimes,
  screenSideOf,
  CLOCK_TOP,
  CLOCK_BOTTOM,
  CLOCK_FRAME_W,
  CLOCK_FRAME_H,
  type ClockSide,
} from './clock.ts';

// ─────────────────────────────────────────────────────────────────────
// V（明度）の計算
// ─────────────────────────────────────────────────────────────────────

/** RGB → yuvj444p（BT.601 フルレンジ）。ffmpeg が動画で行う変換の逆向き。 */
function rgbToYuv(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 + (b - y) * 0.564;
  const cr = 128 + (r - y) * 0.713;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(y), c(cb), c(cr)];
}

function solidYuv(w: number, h: number, rgb: [number, number, number]): YuvImage {
  const [y, u, v] = rgbToYuv(...rgb);
  return {
    width: w,
    height: h,
    y: new Uint8Array(w * h).fill(y),
    u: new Uint8Array(w * h).fill(u),
    v: new Uint8Array(w * h).fill(v),
  };
}

describe('yuvValueWindow', () => {
  it('V = max(R,G,B) を近似する（往復の丸めで ±3 まで）', () => {
    // 白い字・明るい赤・暗い赤（時計に実際に出る 3 色相当）と原色
    const colors: [number, number, number][] = [
      [255, 255, 255],
      [230, 80, 80],
      [90, 30, 30],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [40, 40, 40],
    ];
    for (const rgb of colors) {
      const img = solidYuv(4, 4, rgb);
      const win = yuvValueWindow(img, { x: 0, y: 0, w: 4, h: 4 });
      const expected = Math.max(...rgb);
      expect(Math.abs(win.data[0] - expected)).toBeLessThanOrEqual(3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 明るさの手番指標
// ─────────────────────────────────────────────────────────────────────

/** 指定した側の時計窓だけ「散らばった」画素にしたフレームを作る */
function frameWithBrightClock(side: ClockSide | 'both' | 'neither'): YuvImage {
  const img = solidYuv(CLOCK_FRAME_W, CLOCK_FRAME_H, [40, 40, 40]);
  const paint = (geo: typeof CLOCK_TOP, amplitude: number) => {
    for (const x0 of geo.digitX) {
      for (let dy = 0; dy < geo.h; dy++) {
        for (let dx = 0; dx < geo.w; dx++) {
          // 市松に白を打って標準偏差を作る（amplitude が大きいほど散らばる）
          if ((dx + dy) % 2 === 0) {
            const i = (geo.y + dy) * CLOCK_FRAME_W + x0 + dx;
            img.y[i] = Math.min(255, 40 + amplitude);
          }
        }
      }
    }
  };
  // 実測に合わせる: 手番側の窓は sd 65〜83・非手番側は 25〜35 くらいに出るよう
  // 白の振幅を変える（sd ≈ amplitude / 2）
  paint(CLOCK_TOP, side === 'top' || side === 'both' ? 150 : side === 'neither' ? 0 : 60);
  paint(CLOCK_BOTTOM, side === 'bottom' || side === 'both' ? 150 : side === 'neither' ? 0 : 60);
  return img;
}

describe('brightSideYuv', () => {
  it('明るい方の時計を手番として返す', () => {
    expect(brightSideYuv(frameWithBrightClock('top'))).toBe('top');
    expect(brightSideYuv(frameWithBrightClock('bottom'))).toBe('bottom');
  });
  it('比が割れないときは null（両方明るい・両方暗い）', () => {
    expect(brightSideYuv(frameWithBrightClock('both'))).toBe(null);
    expect(brightSideYuv(frameWithBrightClock('neither'))).toBe(null);
  });
  it('前提の寸法（1080x1920）でないフレームでは黙る', () => {
    const img = solidYuv(1280, 720, [200, 200, 200]);
    expect(brightSideYuv(img)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────
// タイムライン: 反転の検出
// ─────────────────────────────────────────────────────────────────────

function timeline(samples: [number, ClockSide | null][]): ClockTimeline {
  const tl = new ClockTimeline();
  for (const [t, s] of samples) tl.record(t, s);
  return tl;
}

/** 0.5 秒刻みで side の列を record したタイムライン */
function gridTimeline(from: number, sides: (ClockSide | null)[]): ClockTimeline {
  const tl = new ClockTimeline();
  sides.forEach((s, i) => tl.record(from + i * 0.5, s));
  return tl;
}

describe('ClockTimeline.flipsIn', () => {
  it('きれいな交互から反転を数える（時刻は境目の中点・指した側は反転前の側）', () => {
    // 0〜5 秒 bottom → 5〜10 秒 top: 10 秒に 1 回の反転
    const tl = gridTimeline(0, [
      ...Array(10).fill('bottom'),
      ...Array(10).fill('top'),
    ] as ClockSide[]);
    const flips = tl.flipsIn(0, 10);
    expect(flips).toHaveLength(1);
    expect(flips[0].from).toBe('bottom'); // 指したのは bottom
    expect(flips[0].to).toBe('top');
    expect(flips[0].t).toBeCloseTo(4.75, 5); // 4.5（bottom の最後）と 5.0（top の最初）の中点
  });

  it('1 サンプルだけの紛れ（ポインタ等）は反転に数えない', () => {
    const sides = Array(20).fill('bottom') as (ClockSide | null)[];
    sides[7] = 'top'; // 1 サンプルだけの紛れ
    const tl = gridTimeline(0, sides);
    expect(tl.flipsIn(0, 10)).toHaveLength(0);
  });

  it('null（割れなかった）は連続を切らない', () => {
    const sides: (ClockSide | null)[] = [
      'bottom', 'bottom', null, null, 'bottom', 'bottom', 'top', 'top', 'top', 'top',
    ];
    const tl = gridTimeline(0, sides);
    const flips = tl.flipsIn(0, 5);
    expect(flips).toHaveLength(1);
    expect(flips[0].from).toBe('bottom');
  });

  it('速い応酬（各側 2 サンプル以上）も 1 手ずつ数える', () => {
    // bottom×4 → top×3 → bottom×3 → top×4: 反転 3 回 ＝ 3 手
    const tl = gridTimeline(0, [
      'bottom', 'bottom', 'bottom', 'bottom',
      'top', 'top', 'top',
      'bottom', 'bottom', 'bottom',
      'top', 'top', 'top', 'top',
    ] as ClockSide[]);
    const flips = tl.flipsIn(0, 7);
    expect(flips.map((f) => f.from)).toEqual(['bottom', 'top', 'bottom']);
  });

  it('過去の時刻の記録（読み直しの挿し込み）も順序に組み込まれる', () => {
    const tl = timeline([
      [0, 'bottom'], [0.5, 'bottom'], [3, 'top'], [3.5, 'top'],
    ]);
    // あとから 1.5 / 2.0 の読みが挿し込まれて top が早くから立っていたと分かる
    tl.record(2.0, 'top');
    tl.record(1.5, 'top');
    const flips = tl.flipsIn(0, 4);
    expect(flips).toHaveLength(1);
    expect(flips[0].t).toBeCloseTo(1.0, 5); // 0.5 と 1.5 の中点
  });
});

describe('ClockTimeline.hasCoverage', () => {
  it('隙間なく見ていれば true', () => {
    const tl = gridTimeline(0, Array(21).fill('bottom') as ClockSide[]);
    expect(tl.hasCoverage(0, 10)).toBe(true);
  });
  it('null の穴が上限を超えると false（割れない瞬間に反転が居るかもしれない）', () => {
    const sides = Array(21).fill('bottom') as (ClockSide | null)[];
    for (let i = 8; i <= 12; i++) sides[i] = null; // 4〜6 秒が割れない
    const tl = gridTimeline(0, sides);
    expect(tl.hasCoverage(0, 10)).toBe(false);
  });
  it('窓の端に近いサンプルが無くても false', () => {
    const tl = gridTimeline(5, Array(11).fill('bottom') as ClockSide[]); // 5〜10 秒だけ
    expect(tl.hasCoverage(0, 10)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 挿し込みの判定
// ─────────────────────────────────────────────────────────────────────

describe('ClockTimeline.judgeGap', () => {
  it('反転がちょうど 1 回・指した側も一致 → confirm と反転時刻', () => {
    const tl = gridTimeline(0, [
      ...Array(10).fill('bottom'),
      ...Array(10).fill('top'),
    ] as ClockSide[]);
    const j = tl.judgeGap(0, 9.5, 'bottom');
    expect(j.verdict).toBe('confirm');
    expect(j.flipTime).toBeCloseTo(4.75, 5);
  });

  it('反転 1 回でも指した側が違えば unknown（挿し込みの側と食い違う）', () => {
    const tl = gridTimeline(0, [
      ...Array(10).fill('bottom'),
      ...Array(10).fill('top'),
    ] as ClockSide[]);
    expect(tl.judgeGap(0, 9.5, 'top').verdict).toBe('unknown');
  });

  it('🔴 0.5 秒刻みで同じ側が並んでも veto は出さない（手番が隙間で完結しうる）', () => {
    // 🔴 review bot OCL-69066369（High）: 相手の手番が 2 サンプルの間（<0.5 秒）で
    // 終わると、時計には**痕跡が 1 つも残らない**。見えるのは「ずっと bottom」で
    // `hasCoverage` も真になる。それでも間には 2 手ある（指して、即座に指し返した）。
    // 🔒 **サンプリングの隙間を「無かった」の証拠に使わない。**
    const tl = gridTimeline(0, Array(21).fill('bottom') as ClockSide[]);
    expect(tl.flipsIn(0, 10)).toHaveLength(0);
    expect(tl.constantSideIn(0, 10)).toBe('bottom');
    expect(tl.hasCoverage(0, 10)).toBe(true);
    expect(tl.judgeGap(0, 10, 'top').verdict).toBe('unknown');
  });

  it('0.1 秒で読み直した窓で同じ側が並べば veto（隙間に手番が入る余地が無い）', () => {
    // ⭐ 繋がらない窓は `FINE_STEP`（0.1 秒）で読み直される。**実際に細かく見た窓なら**
    // 「間に手は無い」と言ってよい——見逃した手番があるとしても 0.1 秒未満になる。
    const tl = new ClockTimeline();
    for (let i = 0; i <= 100; i++) tl.record(Number((i * 0.1).toFixed(3)), 'bottom');
    expect(tl.judgeGap(0, 10, 'top').verdict).toBe('veto');
  });

  it('反転 0 回でも被覆が足りなければ unknown（見逃しかもしれない）', () => {
    const sides = Array(21).fill('bottom') as (ClockSide | null)[];
    for (let i = 8; i <= 12; i++) sides[i] = null;
    const tl = gridTimeline(0, sides);
    expect(tl.judgeGap(0, 10, 'top').verdict).toBe('unknown');
  });

  it('窓が狭すぎる（2 秒未満）なら unknown', () => {
    const tl = gridTimeline(0, Array(4).fill('bottom') as ClockSide[]);
    expect(tl.judgeGap(0, 1.5, 'top').verdict).toBe('unknown');
  });

  it('反転 0 回でも別の側のサンプルが 1 つでも混じれば unknown（速い手の見逃しかもしれない）', () => {
    // 打った駒がその場で取られる形: 相手の手番は 1 サンプルしか写らず、
    // 反転としては数えられない。それでも「間に手は無い」とは言い切れない。
    const sides = Array(21).fill('bottom') as (ClockSide | null)[];
    sides[15] = 'top'; // t=7.5 に 1 サンプルだけ相手の側
    const tl = gridTimeline(0, sides);
    expect(tl.judgeGap(0, 10, 'top').verdict).toBe('unknown');
  });

  it('粗い刻みで全サンプル同側なら unknown に coarse の印が付く（旧実装の veto 地点）', () => {
    // 📏 弱めたことでどれだけ挿し込みが通るようになったかを走査ログで数えるための印。
    const tl = gridTimeline(0, Array(21).fill('bottom') as ClockSide[]);
    const j = tl.judgeGap(0, 10, 'top');
    expect(j.verdict).toBe('unknown');
    expect(j.coarse).toBe(true);
  });

  it('別の側が混じった unknown には coarse の印は付かない（同側ですらない）', () => {
    const sides = Array(21).fill('bottom') as (ClockSide | null)[];
    sides[15] = 'top';
    const j = gridTimeline(0, sides).judgeGap(0, 10, 'top');
    expect(j.verdict).toBe('unknown');
    expect(j.coarse).toBeUndefined();
  });

  it('反転が 2 回以上なら unknown（1 手挿しでは説明できない）', () => {
    const tl = gridTimeline(0, [
      ...Array(6).fill('bottom'),
      ...Array(6).fill('top'),
      ...Array(6).fill('bottom'),
    ] as ClockSide[]);
    expect(tl.judgeGap(0, 8.5, 'bottom').verdict).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 読み直し時刻の生成
// ─────────────────────────────────────────────────────────────────────

describe('ClockTimeline.deniesMoveIn（「この窓で 1 手も指されていない」と言えるか）', () => {
  /** 刻みを指定してタイムラインを作る */
  function stepped(step: number, n: number, side: ClockSide | null = 'bottom'): ClockTimeline {
    const tl = new ClockTimeline();
    for (let i = 0; i <= n; i++) tl.record(Number((i * step).toFixed(3)), side);
    return tl;
  }

  it('細かく見ていて全部同じ側なら言える', () => {
    expect(stepped(0.1, 100).deniesMoveIn(0, 10)).toBe(true);
  });

  it('🔒 粗い刻み（0.5 秒）では言えない——手番が隙間で完結しうる', () => {
    expect(stepped(0.5, 20).deniesMoveIn(0, 10)).toBe(false);
  });

  it('🔒 細かく見ていても、別の側が 1 サンプルでも混じれば言えない', () => {
    const tl = new ClockTimeline();
    for (let i = 0; i <= 100; i++) tl.record(Number((i * 0.1).toFixed(3)), i === 55 ? 'top' : 'bottom');
    expect(tl.deniesMoveIn(0, 10)).toBe(false);
  });

  it('🔒 細かく見ていても、割れない穴が空いていれば言えない', () => {
    const tl = new ClockTimeline();
    for (let i = 0; i <= 100; i++) tl.record(Number((i * 0.1).toFixed(3)), i >= 50 && i <= 55 ? null : 'bottom');
    expect(tl.deniesMoveIn(0, 10)).toBe(false);
  });

  it('サンプルが 1 つも無ければ言えない', () => {
    expect(new ClockTimeline().deniesMoveIn(0, 10)).toBe(false);
  });
});

describe('ClockTimeline.maxDecidedGap', () => {
  it('窓の端との距離も含めて最大の隙間を返す', () => {
    const tl = timeline([[2, 'bottom'], [2.5, 'bottom'], [4, 'bottom']]);
    expect(tl.maxDecidedGap(1, 5)).toBeCloseTo(1.5, 5); // 2.5→4 の 1.5
    expect(tl.maxDecidedGap(0, 4)).toBeCloseTo(2.0, 5); // 窓の頭 0→2 の 2.0
  });

  it('割れなかったサンプルは穴として数える', () => {
    const tl = timeline([[1, 'bottom'], [1.5, null], [2, 'bottom']]);
    expect(tl.maxDecidedGap(1, 2)).toBeCloseTo(1.0, 5);
  });

  it('サンプルが 1 つも無ければ null', () => {
    expect(new ClockTimeline().maxDecidedGap(0, 10)).toBeNull();
  });
});

describe('rereadTimes', () => {
  it('反転の前後（指す直前と演出が引いたあと）を狙い、窓の外は捨てる', () => {
    const times = rereadTimes([{ t: 10 }], { from: 9.5, to: 12.5 });
    // -1.0 → 9.0 は from より前なので落ち、+2.0 → 12.0 だけが残る（+3.0 → 13.0 は外）
    expect(times).toEqual([12]);
  });
  it('複数の反転をまとめて昇順・重複なしで返す', () => {
    const times = rereadTimes([{ t: 10 }, { t: 13 }], { from: 0, to: 100 });
    expect(times).toEqual([9, 12, 13, 15, 16]);
  });

  it('🔒 反転から +3 秒経つ前に掘ると、演出が引いたあとの絵が 1 枚も残らない', () => {
    // ⚠ これが `extract-simple.ts` の `ESCAPE_REREAD_TAIL` の根拠。掘った反転は
    // 二度と掘り直さないので、**いちばん読みたい絵（演出が引いたあと）を窓の外に
    // 落としたまま印だけ付ける**のが最悪の形になる。まだ来ていない反転は残す。
    expect(rereadTimes([{ t: 10 }], { from: 5, to: 11 })).toEqual([9]);
    expect(rereadTimes([{ t: 10 }], { from: 5, to: 13.25 })).toEqual([9, 12, 13]);
  });
});

describe('screenSideOf', () => {
  it('走査中の内部ラベル（下＝sente）を画面の側に写す', () => {
    expect(screenSideOf('sente')).toBe('bottom');
    expect(screenSideOf('gote')).toBe('top');
  });
});
