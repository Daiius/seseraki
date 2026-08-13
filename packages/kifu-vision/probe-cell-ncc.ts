// 1 つのマスについて、全テンプレートとの NCC を順位付きで出す（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-cell-ncc.ts <動画パス> <秒> <マス> [マス...]
//   例: probe-cell-ncc.ts data/videos/x.mp4 993.5 8f
//
// 🔴 見たいのは「その絵で駒種を割り切れるのか」。既存の probe は 1 位しか出さない
// ので、**2 位以下との差**が分からない。候補が同点で並んだとき絵で割ってよいかは、
// ここを見ないと決められない（追記 69 で、割ろうとして誤った銀を選んでいる）。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { cellStats, presenceOf } from './src/occupancy.ts';
import { cellImage, ncc } from './src/template.ts';
import { extractTemplates } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import type { PieceKind } from 'shared';

const video = process.argv[2];
const at = Number(process.argv[3]);
const squares = process.argv.slice(4);

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
/** 打てる駒（成駒と玉は打てない） */
const DROPPABLE = new Set<PieceKind>(['P', 'L', 'N', 'S', 'G', 'B', 'R']);

const calibration = calibrateFromFrames(
  [2, 60, 600].map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const base = extractTemplates(grabBoard(2));
const stored = loadTemplates('data/templates/shogi-wars-vertical.json', {
  width: base[0].img.width,
  height: base[0].img.height,
});
const templates = stored ? mergeTemplates(base, stored) : base;

const img = grabBoard(at);
const stats = cellStats(img);

for (const sq of squares) {
  const col = 9 - Number(sq[0]);
  const row = sq.charCodeAt(1) - 97;
  const cell = cellImage(img, row, col);
  const sd = stats[row][col].sd;
  console.log(`\n# ${at} 秒 ${sq}  sd=${sd.toFixed(1)}（${presenceOf(sd)}）`);
  const ranked = templates
    .map((t) => ({ t, s: ncc(t.img, cell) }))
    .sort((a, b) => b.s - a.s);
  for (const [i, r] of ranked.slice(0, 8).entries()) {
    const mark = DROPPABLE.has(r.t.kind) ? '打てる' : '　　　';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.t.side === 'sente' ? '▲' : '▽'}${NAMES[r.t.kind]}` +
        `  ${r.s.toFixed(3)}  ${mark}`,
    );
  }
  const bestDroppable = ranked.find((r) => DROPPABLE.has(r.t.kind));
  if (bestDroppable) {
    console.log(
      `  → 打てる駒に限った 1 位: ${bestDroppable.t.side === 'sente' ? '▲' : '▽'}` +
        `${NAMES[bestDroppable.t.kind]}（${bestDroppable.s.toFixed(3)}）`,
    );
  }
}
