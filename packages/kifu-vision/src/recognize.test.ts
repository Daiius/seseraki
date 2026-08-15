import { describe, expect, it } from 'vitest';
import { createInitialState, type Square } from 'shared';
import { carryUnknowns, boardsEqual, boardDiff, recognizeBoard } from './recognize.ts';
import { inferMove } from './moves.ts';
import { cellImage, cellImageForSide, type Template } from './template.ts';
import type { YuvImage } from './frame.ts';
import { hasPointer } from './occupancy.ts';
import { isUnknown } from './uncertain.ts';
import type { GrayImage } from './frame.ts';

function emptyBoard(): Square[][] {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null as Square));
}

function pos(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

function put(board: Square[][], usi: string, piece: Square): void {
  const p = pos(usi);
  board[p.row][p.col] = piece;
}

describe('carryUnknowns', () => {
  it('読めなかったマスに直前の駒を戻す', () => {
    const previous = emptyBoard();
    put(previous, '5e', { kind: 'S', side: 'sente' });

    // ポインタに覆われて銀が金と誤読された
    const read = emptyBoard();
    put(read, '5e', { kind: 'G', side: 'sente' });

    const carried = carryUnknowns(read, [pos('5e')], previous);
    expect(carried[pos('5e').row][pos('5e').col]).toEqual({ kind: 'S', side: 'sente' });
  });

  it('読めなかったマスが無ければ元の配置と同じものを返す', () => {
    const board = createInitialState().board;
    expect(carryUnknowns(board, [], emptyBoard())).toEqual(board);
  });

  it('元の配置を書き換えない', () => {
    const previous = emptyBoard();
    put(previous, '5e', { kind: 'S', side: 'sente' });
    const read = emptyBoard();
    put(read, '5e', { kind: 'G', side: 'sente' });

    carryUnknowns(read, [pos('5e')], previous);
    expect(read[pos('5e').row][pos('5e').col]).toEqual({ kind: 'G', side: 'sente' });
  });

  it('ポインタが作った偽の駒を消して、本来の 1 手が読めるようになる', () => {
    // 7g の歩が 7f へ動いた。同時に 3e にポインタが重なって偽の駒が湧いた。
    const before = emptyBoard();
    put(before, '7g', { kind: 'P', side: 'sente' });
    const read = emptyBoard();
    put(read, '7f', { kind: 'P', side: 'sente' });
    put(read, '3e', { kind: 'N', side: 'gote' }); // 偽物

    // そのままでは 3 マス動いたことになって読めない
    expect(inferMove(before, read).move).toBeNull();

    // 偽物のマスは一致度が低いので「読めなかったマス」に入る。引き継げば消える。
    const carried = carryUnknowns(read, [pos('3e')], before);
    const result = inferMove(before, carried);
    expect(result.move?.usi).toBe('7g7f');
  });

  it('駒が取られて消えた場合は引き継いでも辻褄が合わない（別経路に落ちる）', () => {
    // 8八の角が 2b の角を取った。2b が読めなかったとする。
    const before = emptyBoard();
    put(before, '8h', { kind: 'B', side: 'sente' });
    put(before, '2b', { kind: 'B', side: 'gote' });
    const read = emptyBoard();
    put(read, '2b', { kind: 'P', side: 'sente' }); // 誤読

    // 引き継ぐと 2b が後手の角のままになり、先手の角だけが消えた形になる
    const carried = carryUnknowns(read, [pos('2b')], before);
    expect(inferMove(before, carried).failure).toBe('piece-vanished');

    // 素の読みなら（駒種は誤っていても）移動として形は取れる
    expect(inferMove(before, read).changedCells).toBe(2);
  });
});

/**
 * 各マスの標準偏差と縞の向きを指定して合成した盤画像（`occupancy.test.ts` と同じ作り）
 *
 * 縞の向きで「似ている / 似ていない」を作る。横縞どうしは NCC が 1.0
 * （NCC は明るさとコントラストに影響されないので、振幅が違っても 1.0）、
 * 横縞と縦縞は平均を引くと直交するのでちょうど 0 になる。
 */
function boardWithSd(
  sds: number[][],
  vertical: boolean[][] = [],
  /** マスの明るさの中心。ポインタ（白）を作るときだけ上げる */
  bases: number[][] = [],
  /**
   * 左上の一角だけ暗い。**どのテンプレートとも中途半端にしか似ず、しかも
   * 1 位と 2 位が並ぶ**マスを作るため（NCC 0.459・差 0.000）。
   * 実測のポインタが掛かった空マス（▽角 0.467 対 ▽銀 0.454）とほぼ同じ形。
   */
  mixed: boolean[][] = [],
): GrayImage {
  const cell = 10;
  const size = cell * 9;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / cell);
      const col = Math.floor(x / cell);
      const sd = sds[row][col];
      const base = bases[row]?.[col] ?? 128;
      const dark = mixed[row]?.[col]
        ? x % cell < cell * 0.4 && y % cell < cell / 2
        : vertical[row]?.[col]
          ? x % cell < cell / 2
          : y % cell < cell / 2;
      data[y * size + x] = base + (dark ? -sd : sd);
    }
  }
  return { width: size, height: size, data };
}

describe('recognizeBoard の駒の有無（3 値）', () => {
  const sds = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 5));
  const vert = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => false));
  sds[3][4] = 20; // 覆われて平らになった帯（12 < sd <= 30）。横縞
  sds[3][6] = 20; // 同じく覆われているが、こちらは縦縞（照合が決定的になる）
  vert[3][6] = true;
  sds[8][0] = 60; // 駒がはっきり見えている（横縞）
  sds[8][2] = 40; // もう 1 種のテンプレート（横縞・振幅だけ違う）
  sds[8][4] = 60; // 縦縞のテンプレート
  vert[8][4] = true;
  // ポインタの白（235 超）を被った縦縞のマス。NCC は明るさに影響されないので
  // 照合は決まるが、`hasPointer` は「読めなくて当然」と言う。
  const bases = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 128));
  sds[5][2] = 15;
  vert[5][2] = true;
  bases[5][2] = 235;
  // 🔴 ポインタが隅に掛かった空マス（実測 2 本目 16:37 の 4e）。sd は十分に
  // 大きいので「駒あり」の門は通るが、**どのテンプレートとも中途半端にしか
  // 似ず、1 位と 2 位も並ぶ**（NCC 0.577 で 3 種が同点）。
  const mix = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => false));
  sds[6][6] = 60;
  mix[6][6] = true;
  const img = boardWithSd(sds, vert, bases, mix);
  // ⚠ テンプレートが 1 種しか無いと 1 位と 2 位の差が定義できず（常に 1）、
  // 覆われたマスが必ず「決定的」になってしまう。**紛れる相手を必ず置く。**
  const templates: Template[] = [
    // 🔒 テンプレートは**本線と同じ窓**で切る（向きごとにずらす・追記 141）。
    // 片方だけ動かすと照合が成り立たない。
    { kind: 'P', side: 'sente', samples: 1, img: cellImageForSide(img, 8, 0, 'sente') },
    { kind: 'L', side: 'sente', samples: 1, img: cellImageForSide(img, 8, 2, 'sente') },
    { kind: 'G', side: 'gote', samples: 1, img: cellImageForSide(img, 8, 4, 'gote') },
  ];
  const r = recognizeBoard(img, templates);

  it('照合が決まらない覆われたマスは未確定になる（「空」と断定しない）', () => {
    // 横縞なので ▲歩 とも ▲香 とも NCC 1.0 で並ぶ。差が無いので決められない。
    expect(isUnknown(r.board[3][4])).toBe(true);
  });

  it('未確定にした理由が「覆われていた」として残る', () => {
    const covered = r.lowConfidence.filter((c) => c.covered);
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ row: 3, col: 4 });
  });

  it('⭐ 覆われていても、照合が決定的なら駒として読む', () => {
    // 縦縞なので ▽金 だけが 1.0、横縞のテンプレートは 0。差が開くので決まる。
    // 🔴 ここを捨てていたせいで、打った駒がその場で取られる形が丸ごと消えていた。
    expect(r.board[3][6]).toEqual({ kind: 'G', side: 'gote' });
    expect(r.lowConfidence.some((c) => c.row === 3 && c.col === 6)).toBe(false);
  });

  it('⭐ ポインタが乗っていても、照合が決定的なら駒として読む', () => {
    // 🔴 打ちの演出は白く光るので、`hasPointer` から見るとマウスポインタと
    // 区別が付かない（実測 20:57 の 3e）。ポインタは「読めなくて当然」という
    // **推定**にすぎないので、決定的な証拠が出たら推定の方を譲る。
    expect(hasPointer(cellImage(img, 5, 2))).toBe(true);
    expect(r.board[5][2]).toEqual({ kind: 'G', side: 'gote' });
  });

  it('通常の空マスは空のまま', () => {
    expect(r.board[0][0]).toBeNull();
  });

  it('はっきり見えている駒はそのまま読める', () => {
    expect(r.board[8][0]).toEqual({ kind: 'P', side: 'sente' });
  });

  it('⭐ よく似ているなら、2 位と並んでいても盤に置く（金⇔全のような組）', () => {
    // 横縞なので ▲歩 とも ▲香 とも NCC 1.0 で並び、差は 0。それでも
    // **「そこに駒がある」ことは疑っていない**ので置く。ここで差を求めると、
    // 実測では本物の `G*8f`（金・NCC 0.815・差 0.028）が落ちて 1 本目が
    // 92 → 75 手に退行した。
    expect(r.cells[8][0].margin).toBeLessThan(0.05);
    expect(isUnknown(r.board[8][0])).toBe(false);
  });

  it('🔴 弱くしか似ておらず、しかも 2 位と並ぶなら盤に置かない', () => {
    // 🔴 実測（2 本目 16:37 の 4e）: マウスポインタが隅に半分だけ掛かった
    // **空マス**が sd=32.6 で「駒あり」の門を通り、▽角 0.467 対 ▽銀 0.454
    // という差 0.013 の読みで盤に置かれた。差分は「空 → 駒」＝打ちの形なので
    // そのまま棋譜に入り、偽の `B*4e` から 13 手が総崩れになった。
    expect(r.cells[6][6].score).toBeLessThan(0.6);
    expect(r.cells[6][6].margin).toBeLessThan(0.05);
    expect(isUnknown(r.board[6][6])).toBe(true);
    expect(r.lowConfidence.some((c) => c.row === 6 && c.col === 6)).toBe(true);
  });
});

describe('boardsEqual / boardDiff', () => {
  it('同じ配置を同じと判定する', () => {
    expect(boardsEqual(createInitialState().board, createInitialState().board)).toBe(true);
  });

  it('食い違うマスを挙げる', () => {
    const a = emptyBoard();
    const b = emptyBoard();
    put(b, '5e', { kind: 'G', side: 'sente' });
    const diff = boardDiff(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ row: 4, col: 4, before: null });
  });
});

/**
 * 🔴 **色の検算は片側だけだった**（追記 139 で見つけて放置し、追記 142 で直した）。
 *
 * 「成駒と読めたが朱でない → 生駒に読み直す」はあったが、**逆が無かった**。
 * 実測（2 本目 2 局目 30:19）では、成った銀を `▲金` と読み、「銀が金になった」
 * という説明の付かない差分になって断片が切れていた。金と全は形では割れない
 * （NCC 0.70〜0.81）ので、**色でしか決められない**。
 */
describe('字の色で成駒と生駒を読み直す（両向き）', () => {
  const cell = 10;
  const size = cell * 9;

  /** 上半分が暗い絵。`vertical` なら左半分が暗い。 */
  const make = (vertical = false): GrayImage => {
    const data = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dark = vertical ? x % cell < cell / 2 : y % cell < cell / 2;
        data[y * size + x] = dark ? 60 : 200;
      }
    }
    return { width: size, height: size, data };
  };

  /**
   * 同じ絵に色を付ける。`redInk` なら**暗い画素だけ**を赤くする
   * （インクの R−G が木地より大きくなる＝朱）。
   * ⚠ R−G は `2.116(V−128) + 0.344(U−128)` なので V を動かせばよい。
   */
  const withInk = (img: GrayImage, redInk: boolean): YuvImage => {
    const u = new Uint8Array(img.data.length).fill(128);
    const v = new Uint8Array(img.data.length);
    for (let i = 0; i < img.data.length; i++) {
      const dark = img.data[i] < 128;
      // 木地は常に少し赤い（実物の駒も橙）。インクは朱のときだけ強く赤い。
      v[i] = dark ? (redInk ? 190 : 140) : 150;
    }
    return { width: img.width, height: img.height, y: img.data, u, v };
  };

  const img = make();
  const templates: Template[] = [
    { kind: 'G', side: 'sente', samples: 1, img: cellImageForSide(img, 0, 0, 'sente') },
    // 成駒。字の形は金とまったく同じにしてある（実物の 金⇔全 と同じ状況）。
    { kind: '+S', side: 'sente', samples: 1, img: cellImageForSide(img, 0, 0, 'sente') },
    { kind: 'P', side: 'gote', samples: 1, img: cellImageForSide(make(true), 0, 0, 'gote') },
  ];

  it('🔴 生駒と読めても、字が朱なら成駒として読み直す', () => {
    const r = recognizeBoard(img, templates, { colorBoard: withInk(img, true) });
    expect(r.board[4][4]).toEqual({ kind: '+S', side: 'sente' });
  });

  it('字が朱でなければ生駒のまま', () => {
    const r = recognizeBoard(img, templates, { colorBoard: withInk(img, false) });
    expect(r.board[4][4]).toEqual({ kind: 'G', side: 'sente' });
  });

  it('色を渡さなければ今までどおり形だけで読む', () => {
    const r = recognizeBoard(img, templates);
    expect(r.board[4][4]).toEqual({ kind: 'G', side: 'sente' });
  });
});
