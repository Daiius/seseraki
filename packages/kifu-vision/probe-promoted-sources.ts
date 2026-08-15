// 成駒のテンプレート候補を、**確定した棋譜の論理**からフルサイズで切り出す（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-promoted-sources.ts <動画> <開始秒> <終了秒> <棋譜json...> <出力先>
//
// ⭐ **ラベルを絵から決めない。** 棋譜を初期局面から再生すれば、どの時刻に
// どのマスへ何が乗っているかは論理で決まる。成駒は初期局面に無いので動画から
// 起こすしかないが、**手の列が確定していれば正解ラベルは付いている**。
//
// 🔒 **安全網: 再生した盤の「駒の有無」が、その時刻の絵と 81 マス全部一致すること。**
// 一致しなければ、時刻がずれているか画面の向きの読みが違うか演出が乗っている。
// **どれであっても、その絵からテンプレートを起こしてはいけない。**
//
// 🔒 ポインタが乗ったマスからは起こさない（`hasPointer`）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { cellImage, ncc, resample, rotate180 } from './src/template.ts';
import { loadTemplates } from './src/template-store.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { occupancy, occupancyDistance, hasPointer } from './src/occupancy.ts';
import { applyMove, createInitialState, type BoardState, type Side } from 'shared';
import { readFileSync } from 'node:fs';

const video = process.argv[2];
const fromSec = Number(process.argv[3]);
const toSec = Number(process.argv[4]);
const outDir = process.argv[process.argv.length - 1];
const kifuPaths = process.argv.slice(5, process.argv.length - 1);
const STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';

const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calibration = calibrateFromFrames(
  Array.from({ length: CAL_POINTS }, (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1))
    .filter((s) => s > 0)
    .map((s) => grabFrame(video, Math.round(s), SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const canon = loadTemplates(STORE) ?? [];
mkdirSync(outDir, { recursive: true });
const writePgm = (name: string, img: GrayImage) => {
  const head = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  writeFileSync(`${outDir}/${name}.pgm`, Buffer.concat([head, Buffer.from(img.data)]));
};

interface Cand {
  kind: string; side: Side; at: number; square: string; name: string;
  w: number; h: number; agree: number | null; sep: number; sepWith: string;
  game: number; ply: number; hold: number;
}
const cands: Cand[] = [];
let checked = 0;
let rejectedOcc = 0;
let rejectedPointer = 0;

for (const path of kifuPaths) {
  const kifu = JSON.parse(readFileSync(path, 'utf8'));
  const bottomIsSente: boolean = kifu.bottomIsSente;
  const game: number = kifu.game ?? 1;
  for (const run of kifu.runs) {
    const moves: { usi: string; time: number }[] = run.moves;
    let state: BoardState = createInitialState();
    for (let i = 0; i < moves.length; i++) {
      try {
        state = applyMove(state, moves[i].usi);
      } catch {
        break; // 再生できないところから先は論理で決まらない
      }
      const hold = (moves[i + 1]?.time ?? moves[i].time + 4) - moves[i].time;
      if (hold < 2.5) continue; // アニメーションと次の手を避ける

      // 画面の向きへ写す。画面の下側の駒が「▲向き」に描かれる。
      const toScreen = (row: number, col: number): [number, number] =>
        bottomIsSente ? [row, col] : [8 - row, 8 - col];
      const toScreenSide = (side: Side): Side =>
        bottomIsSente ? side : side === 'sente' ? 'gote' : 'sente';

      const wantOcc: boolean[][] = Array.from({ length: 9 }, () => new Array(9).fill(false));
      const promoted: { row: number; col: number; kind: string; side: Side }[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const p = state.board[r][c];
          if (!p) continue;
          const [sr, sc] = toScreen(r, c);
          wantOcc[sr][sc] = true;
          if (p.kind.startsWith('+')) {
            promoted.push({ row: sr, col: sc, kind: p.kind, side: toScreenSide(p.side) });
          }
        }
      }
      if (promoted.length === 0) continue;

      const at = Math.round((moves[i].time + Math.min(moves[i].time + 2, moves[i].time + hold / 2)) * 5) / 10;
      const sampleAt = moves[i].time + Math.min(1.5, hold / 2);
      const board = grabBoard(sampleAt);
      checked++;
      // 🔒 安全網。1 マスでも食い違えば起こさない。
      if (occupancyDistance(occupancy(board), wantOcc) !== 0) {
        rejectedOcc++;
        continue;
      }
      for (const p of promoted) {
        const cell = cellImage(board, p.row, p.col);
        if (hasPointer(cell)) {
          rejectedPointer++;
          continue;
        }
        const c = canon.find((x) => x.kind === p.kind && x.side === p.side);
        const agree = c ? ncc(resample(c.img, cell.width, cell.height), cell) : null;
        const others = canon.filter((x) => !(x.kind === p.kind && x.side === p.side));
        const top = others
          .map((o) => ({ o, s: ncc(resample(o.img, cell.width, cell.height), cell) }))
          .sort((a, b) => b.s - a.s)[0];
        const square = `${9 - p.col}${String.fromCharCode(97 + p.row)}`;
        const name = `g${game}-${Math.round(sampleAt * 10)}-${p.side}-${p.kind.replace('+', 'p')}-${square}`;
        writePgm(name, cell);
        writePgm(`${name}-view`, p.side === 'gote' ? rotate180(cell) : cell);
        cands.push({
          kind: p.kind, side: p.side, at: sampleAt, square, name,
          w: cell.width, h: cell.height,
          agree: agree === null ? null : Number(agree.toFixed(4)),
          sep: Number(top.s.toFixed(4)),
          sepWith: `${top.o.side === 'sente' ? '▲' : '▽'}${top.o.kind}`,
          game, ply: i + 1, hold: Number(hold.toFixed(1)),
        });
      }
    }
  }
}

writeFileSync(`${outDir}/index.json`, JSON.stringify({ video, cands }, null, 2));
const kinds = new Set(cands.map((c) => `${c.side}-${c.kind}`));
console.log(
  `# ${video}  局面 ${checked} 個を見た（有無が合わず捨てた ${rejectedOcc} / ポインタ ${rejectedPointer}）\n` +
    `  候補 ${cands.length} 枚・${kinds.size} 種: ${[...kinds].sort().join(' ')}`,
);
