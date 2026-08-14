import { describe, expect, it } from 'vitest';
import type { GrayImage } from './frame.ts';
import type { BoardGeometry } from './geometry.ts';
import { calibrateGeometry, calibrateFromFrames, isCalibrationTrustworthy, refineByTemplates, fitScore, fitScoreFast } from './calibrate.ts';
import { crop } from './frame.ts';
import { boardRect } from './geometry.ts';
import { cellImage } from './template.ts';

const SEED: BoardGeometry = {
  originX: 10,
  originY: 20,
  cellW: 30,
  cellH: 34,
  frameW: 320,
  frameH: 360,
};

/** 指定した格子で線を引いた盤の絵を作る（線は暗く、マスの中は明るい） */
function drawBoard(geo: Partial<BoardGeometry> & { frameW: number; frameH: number }): GrayImage {
  const g = { ...SEED, ...geo };
  const data = new Uint8Array(g.frameW * g.frameH).fill(180);
  const put = (x: number, y: number) => {
    if (x >= 0 && x < g.frameW && y >= 0 && y < g.frameH) data[y * g.frameW + x] = 40;
  };
  for (let i = 0; i <= 9; i++) {
    const x = Math.round(g.originX + g.cellW * i);
    for (let y = Math.round(g.originY); y <= Math.round(g.originY + g.cellH * 9); y++) put(x, y);
    const y = Math.round(g.originY + g.cellH * i);
    for (let x2 = Math.round(g.originX); x2 <= Math.round(g.originX + g.cellW * 9); x2++) put(x2, y);
  }
  return { width: g.frameW, height: g.frameH, data };
}

describe('格子の測り直し', () => {
  it('ずれていない盤なら、元の座標がそのまま返る', () => {
    const r = calibrateGeometry(drawBoard({ frameW: 320, frameH: 360 }), SEED);
    // ⚠ ぴったりには当たらない。線には幅があり、探索も 0.25 画素刻みなので、
    // **精度は 1 画素程度**。ずれを 7 画素から 1 画素に減らせれば目的は足りる。
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y)).toBeLessThanOrEqual(1);
  });

  it('⭐ 平行にずれた盤を当てて、ずれ量を返す', () => {
    const actual = { ...SEED, originX: 16, originY: 25 };
    const r = calibrateGeometry(drawBoard(actual), SEED);
    expect(Math.abs(r.geo.originX - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.geo.originY - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.x - 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y - 5)).toBeLessThanOrEqual(1);
  });

  it('⚠ 背景に明暗のむらがあっても、暗い側へ引きずられない', () => {
    // 生の暗さで測ると失敗した場面。盤の背景は上ほど暗いグラデーションで、
    // 格子でない所へ寄せた方が「線上の輝度合計」は下がりうる。
    const img = drawBoard({ frameW: 320, frameH: 360 });
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = y * img.width + x;
        img.data[i] = Math.max(0, img.data[i] - Math.round((y / img.height) * 90));
      }
    }
    const r = calibrateGeometry(img, SEED);
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.shift.y)).toBeLessThanOrEqual(1);
  });

  it('⚠ 画面端に黒帯があっても、そこを「限りなく暗い格子線」と取らない', () => {
    const img = drawBoard({ frameW: 320, frameH: 360 });
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < 14; x++) img.data[y * img.width + x] = 0;
    }
    const r = calibrateGeometry(img, SEED);
    expect(Math.abs(r.shift.x)).toBeLessThanOrEqual(1);
  });

  it('マスの大きさが違う盤も当てられる', () => {
    const actual = { ...SEED, cellW: 30.75, cellH: 33.2 };
    const r = calibrateGeometry(drawBoard(actual), SEED);
    expect(r.geo.cellW).toBeCloseTo(30.75, 0);
    expect(r.geo.cellH).toBeCloseTo(33.2, 0);
  });

  it('🔴 盤が写っていない絵でも「答え」は返るが、はっきりしないので採用しない', () => {
    // 一様な絵。格子はどこにも無いが、探索は必ず最小値を見つけてしまう。
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    const r = calibrateGeometry(flat, SEED);
    expect(r.geo).toBeDefined();
    expect(isCalibrationTrustworthy(r)).toBe(false);
  });

  it('採用できる絵が 1 枚も無ければ null を返す', () => {
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    expect(calibrateFromFrames([flat, flat], SEED)).toBeNull();
  });

  it('複数枚から中央値を採る。盤の無い絵は混ざっても無視される', () => {
    const actual = { ...SEED, originX: 16, originY: 25 };
    const flat: GrayImage = { width: 320, height: 360, data: new Uint8Array(320 * 360).fill(150) };
    const r = calibrateFromFrames([drawBoard(actual), flat, drawBoard(actual)], SEED);
    expect(r).not.toBeNull();
    expect(r!.used).toBe(2);
    expect(r!.tried).toBe(3);
    expect(r!.geo.originX).toBeCloseTo(16, 0);
  });
});

describe('テンプレートとの一致で格子を詰め直す', () => {
  /**
   * 格子線に加えて、各マスの中に**駒に見立てた塊**を描いた絵を作る。
   *
   * ⚠ 市松のような**周期のある模様では試せない**。ずらすと別の周期に噛み合って
   * 相関が戻ってしまい、「詰め直せた」ことの確かめにならない（実際そう書いて
   * 嵌った）。塊のように**局所的な模様**なら、ずれるほど素直に相関が落ちる。
   */
  function drawWithPieces(geo: BoardGeometry): GrayImage {
    const img = drawBoard(geo);
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const x0 = geo.originX + geo.cellW * col;
        const y0 = geo.originY + geo.cellH * row;
        // マスごとに大きさと位置を変える（同じ絵が並ぶと、どの列に合わせても
        // 同じ相関が出てしまい、傾きが測れない）
        const rx = geo.cellW * 0.3 + (row % 3);
        const ry = geo.cellH * 0.28 + (col % 3);
        const cx = x0 + geo.cellW / 2 + ((col % 2) - 0.5) * 2;
        const cy = y0 + geo.cellH / 2 + ((row % 2) - 0.5) * 2;
        for (let y = Math.floor(y0); y < y0 + geo.cellH; y++) {
          for (let x = Math.floor(x0); x < x0 + geo.cellW; x++) {
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
            if (d < 1) img.data[y * img.width + x] = 50;
          }
        }
      }
    }
    return img;
  }

  /** 正しい格子で切り出した「正解の駒の絵」を手掛かりとして用意する */
  function knownFrom(img: GrayImage, geo: BoardGeometry, cells: [number, number][]) {
    const board = crop(img, boardRect(geo));
    return cells.map(([row, col]) => ({ row, col, template: cellImage(board, row, col) }));
  }

  const SPREAD: [number, number][] = [
    [0, 0], [0, 4], [0, 8], [2, 2], [4, 4], [4, 1], [4, 7], [6, 6], [8, 0], [8, 3], [8, 8],
  ];

  it('⭐ 格子線は合っているのに切り出しがずれている絵を、駒の位置で直す', () => {
    // 実際に踏んだ形: 受け取った絵は格子線から測れば正しいのに、駒の描かれる
    // 位置が動画と違って、そのままでは 20 マス中 12 マスしか読めなかった。
    const truth: BoardGeometry = { ...SEED, originX: 13.5, originY: 22.5 };
    const img = drawWithPieces(truth);
    const known = knownFrom(img, truth, SPREAD);

    // 2 画素ずれた座標から出発する
    const off: BoardGeometry = { ...truth, originX: truth.originX - 2, originY: truth.originY + 2 };
    const r = refineByTemplates(img, off, known);

    expect(r.after).toBeGreaterThan(r.before);
    expect(r.after).toBeGreaterThan(0.9);
    expect(Math.abs(r.geo.originX - truth.originX)).toBeLessThan(1);
    expect(Math.abs(r.geo.originY - truth.originY)).toBeLessThan(1);
  });

  it('⭐ ずれが列に比例していれば、マス寸法の誤りとして直す', () => {
    // 原点だけを動かしても直らない形。切片と傾きを分けて取り出せているか。
    // 実測もこの大きさだった（1 列あたり 0.4 画素）。
    const truth: BoardGeometry = { ...SEED, cellW: 30.4 };
    const img = drawWithPieces(truth);
    const known = knownFrom(img, truth, SPREAD);

    const r = refineByTemplates(img, SEED, known);
    expect(r.after).toBeGreaterThan(r.before);
    expect(Math.abs(r.geo.cellW - truth.cellW)).toBeLessThan(0.3);
  });

  it('既に合っている絵なら、動かさない', () => {
    const truth: BoardGeometry = { ...SEED };
    const img = drawWithPieces(truth);
    const known = knownFrom(img, truth, SPREAD);
    const r = refineByTemplates(img, truth, known);
    expect(Math.abs(r.geo.originX - truth.originX)).toBeLessThan(0.5);
    expect(Math.abs(r.geo.cellW - truth.cellW)).toBeLessThan(0.2);
  });
});

describe('fitScoreFast は fitScore と 1 ビットも変わらない', () => {
  // 🔒 Phase I は「結果が 1 ビットも変わってはいけない」変更。速くした側が
  // 元と同じ値を返すことを、**同じ入力を大量に通して**見張る。
  // ⚠ 中央値は同点で割れうるので、`toBeCloseTo` ではなく **`toBe`** で見る。
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  it('でたらめな並びで一致する', () => {
    const next = rng(42);
    for (let trial = 0; trial < 30; trial++) {
      const prof = new Float64Array(400);
      for (let i = 0; i < prof.length; i++) prof[i] = next() * 255;
      for (let k = 0; k < 40; k++) {
        const origin = next() * 420 - 10;
        const pitch = 20 + next() * 30;
        expect(fitScoreFast(prof, origin, pitch)).toBe(fitScore(prof, origin, pitch));
      }
    }
  });

  it('格子が並んだ絵でも、端をはみ出す場合でも一致する', () => {
    const prof = new Float64Array(200);
    for (let i = 0; i < prof.length; i++) prof[i] = i % 20 === 0 ? 30 : 200;
    for (let origin = -30; origin <= 230; origin += 0.25) {
      for (const pitch of [19.5, 20, 20.5]) {
        expect(fitScoreFast(prof, origin, pitch)).toBe(fitScore(prof, origin, pitch));
      }
    }
  });

  it('端に寄って隣が 1 つも取れないときも同じく捨てる', () => {
    const prof = new Float64Array(12);
    for (let i = 0; i < prof.length; i++) prof[i] = 100 + i;
    // 10 本が収まらない配置。どちらも -Infinity を返す。
    expect(fitScoreFast(prof, 0, 5)).toBe(fitScore(prof, 0, 5));
    expect(fitScoreFast(prof, -100, 1)).toBe(fitScore(prof, -100, 1));
  });
});
