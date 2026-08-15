// 棋譜の**成/不成**を、字の色で全局・全マス突き合わせて監査する。
//
//   pnpm --filter kifu-vision exec tsx probe-promotion-audit.ts <動画> <開始秒> <終了秒> <棋譜json...>
//
// 🔴 **通し再生は成/不成の誤りを見つけられない。** 成らずも成りもどちらも合法なので、
// 「合法 105/105・指摘ゼロ」でも棋譜が間違っていることがある。実際に 3 件見つかった
// （追記 140 で 2 件・追記 144 で 2 件。どれも満点の指標の下に隠れていた）。
//
// ⭐ **色は照合とはまったく独立した証拠。** 成駒は朱、生駒は黒で書かれている。
// 棋譜を初期局面から再生すれば、どの時刻にどのマスへ何が乗っているかは論理で決まる。
// **その成/不成と、画面の字の色が食い違えば、どちらかが間違っている。**
//
// 🔒 安全網は `probe-promoted-sources.ts` と同じ——**再生した盤の駒の有無が
// 81 マス全部その絵と一致すること**。一致しない絵は時刻ずれ・向きの読み違い・
// 演出のいずれかなので、色を測っても意味が無い。
// 🔒 ポインタが乗ったマスは見ない。
//
// ⚠ **駒が無いマスに `inkRedness` を使ってはいけない**（`ink.ts` の警告）。
// 字が無いと暗い側も木地になり、比が 1 に近づいて朱に見える。ここでは再生した盤に
// 駒があるマスだけを見るので条件を満たす。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, grabFrameYuv, cropYuv, crop, type YuvImage } from './src/frame.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { cellImage, MATCH_INSET } from './src/template.ts';
import { occupancy, occupancyDistance, hasPointer } from './src/occupancy.ts';
import { inkRedness } from './src/ink.ts';
import { PROMOTED_MIN_REDNESS, PROMOTED_CERTAIN_REDNESS } from './src/recognize.ts';
import { applyMove, createInitialState, type BoardState, type Side } from 'shared';
import { readFileSync } from 'node:fs';

const video = process.argv[2];
const fromSec = Number(process.argv[3]);
const toSec = Number(process.argv[4]);
const kifuPaths = process.argv.slice(5);
if (!video || kifuPaths.length === 0) {
  console.error('使い方: probe-promotion-audit.ts <動画> <開始秒> <終了秒> <棋譜json...>');
  process.exit(1);
}

const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calibration = calibrateFromFrames(
  Array.from({ length: CAL_POINTS }, (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1))
    .filter((s) => s > 0)
    .map((s) => grabFrame(video, Math.round(s), SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;

const NAMES: Record<string, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const redness = (color: YuvImage, row: number, col: number): number => {
  const cw = color.width / 9;
  const ch = color.height / 9;
  const w = Math.floor(cw * (1 - MATCH_INSET * 2));
  const h = Math.floor(ch * (1 - MATCH_INSET * 2));
  return inkRedness(
    cropYuv(color, {
      x: Math.round(cw * col + cw * MATCH_INSET),
      y: Math.round(ch * row + ch * MATCH_INSET),
      w,
      h,
    }),
  ).ratio;
};

interface Disagreement {
  game: number;
  ply: number;
  at: number;
  square: string;
  kind: string;
  side: Side;
  ratio: number;
  /** 棋譜は生駒と言っているが字が朱 */
  shouldBePromoted: boolean;
}

const found: Disagreement[] = [];
let checked = 0;
let cells = 0;
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
      const at = moves[i].time + Math.min(1.5, hold / 2);

      const toScreen = (row: number, col: number): [number, number] =>
        bottomIsSente ? [row, col] : [8 - row, 8 - col];
      const toScreenSide = (side: Side): Side =>
        bottomIsSente ? side : side === 'sente' ? 'gote' : 'sente';

      const rect = boardRect(geo);
      const gray = crop(grabFrame(video, at, geo.frameW, geo.frameH), rect);
      const wantOcc: boolean[][] = Array.from({ length: 9 }, () => new Array(9).fill(false));
      const pieces: { row: number; col: number; kind: string; side: Side }[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const p = state.board[r][c];
          if (!p) continue;
          const [sr, sc] = toScreen(r, c);
          wantOcc[sr][sc] = true;
          pieces.push({ row: sr, col: sc, kind: p.kind, side: toScreenSide(p.side) });
        }
      }
      checked++;
      // 🔒 安全網。1 マスでも食い違えば、その絵からは何も言えない。
      if (occupancyDistance(occupancy(gray), wantOcc) !== 0) {
        rejectedOcc++;
        continue;
      }
      const color = cropYuv(grabFrameYuv(video, at, geo.frameW, geo.frameH), rect);
      for (const p of pieces) {
        if (hasPointer(cellImage(gray, p.row, p.col))) {
          rejectedPointer++;
          continue;
        }
        const ratio = redness(color, p.row, p.col);
        if (!Number.isFinite(ratio)) continue;
        cells++;
        const promoted = p.kind.startsWith('+');
        // 🔒 決められるときだけ言う。間の帯（0.76〜1.04）では黙る。
        const saysPromoted = ratio >= PROMOTED_CERTAIN_REDNESS;
        const saysPlain = ratio < PROMOTED_MIN_REDNESS;
        if (promoted === saysPromoted || (promoted && !saysPlain)) continue;
        if (!promoted && !saysPromoted) continue;
        found.push({
          game,
          ply: i + 1,
          at,
          square: `${9 - p.col}${String.fromCharCode(97 + p.row)}`,
          kind: p.kind,
          side: p.side,
          ratio,
          shouldBePromoted: !promoted,
        });
      }
    }
  }
}

console.log(
  `# ${video}\n` +
    `  局面 ${checked} 個（有無が合わず捨てた ${rejectedOcc} / ポインタ ${rejectedPointer}）・` +
    `色を測ったマス ${cells}`,
);

if (found.length === 0) {
  console.log('  ✅ 棋譜の成/不成と字の色は、全マスで食い違わなかった');
} else {
  // 同じマスが何十フレームも続くので、マスと局でまとめる
  const byCell = new Map<string, Disagreement[]>();
  for (const d of found) {
    const key = `${d.game}:${d.square}:${d.side}:${d.kind}`;
    byCell.set(key, [...(byCell.get(key) ?? []), d]);
  }
  console.log(`  🔴 食い違い ${byCell.size} か所（延べ ${found.length} マス）`);
  for (const [key, ds] of [...byCell].sort((a, b) => b[1].length - a[1].length)) {
    const [game, square, side, kind] = key.split(':');
    const d = ds[0];
    const ratios = ds.map((x) => x.ratio).sort((a, b) => a - b);
    console.log(
      `    ${game} 局目 ${square} ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}` +
        `  ${ds.length} 枚  赤み ${ratios[0].toFixed(3)}〜${ratios[ratios.length - 1].toFixed(3)}` +
        `  ${d.shouldBePromoted ? '**棋譜は生駒だが字は朱**' : '棋譜は成駒だが字は黒'}` +
        `  ${ds[0].ply}〜${ds[ds.length - 1].ply} 手目 / ${Math.round(ds[0].at)}秒〜`,
    );
  }
  console.log('  🔒 まずフレームを見ること。棋譜と色のどちらが誤っているかは、絵でしか決まらない');
}
