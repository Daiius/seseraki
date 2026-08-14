// 戦法エフェクトが盤の読みに何をしているかを、マス単位で測る（検証用）。
//
//   pnpm --filter kifu-vision exec tsx probe-effect.ts <動画パス> <秒> [秒...]
//
// 各マスについて次を出す:
//   駒 … 読めた（テンプレートが決まった）
//   ？ … 駒はあるが何か分からない（未確定）
//   ・ … 空と判定された（sd <= しきい値）
//
// 🔴 見たいのは「エフェクトに覆われたマスが**空と誤判定される**のか、
// それとも**未確定として残る**のか」。前者なら差分が壊れるが、後者なら
// carryUnknowns の領分なので、覆われている間も追跡を続けられる。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, grabFrameYuv, yuvGray, cropYuv, crop } from './src/frame.ts';
import { cellStats, OCCUPANCY_THRESHOLD } from './src/occupancy.ts';
import { recognizeBoard } from './src/recognize.ts';
import { extractTemplates } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';
import { isUnknown } from './src/uncertain.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import type { PieceKind } from 'shared';

const video = process.argv[2];
const times = process.argv.slice(3).map(Number);
const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

const calibration = calibrateFromFrames(
  [2, 60, 600].map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

// 初期局面（0:02）から生駒テンプレートを起こし、保存済みの成駒を足す
const base = extractTemplates(grabBoard(2));
const stored = loadTemplates('data/templates/shogi-wars-vertical.json', {
  width: base[0].img.width,
  height: base[0].img.height,
});
const templates = stored ? mergeTemplates(base, stored) : base;

for (const t of times) {
  // 本線と同じく色も渡す（成駒は朱・生駒は黒。`src/ink.ts`）。
  // 渡さないと `金`⇔`全` の誤読が診断側にだけ残り、実態とずれる。
  const colorFrame = grabFrameYuv(video, t, geo.frameW, geo.frameH);
  const img = crop(yuvGray(colorFrame), boardRect(geo));
  const r = recognizeBoard(img, templates, { colorBoard: cropYuv(colorFrame, boardRect(geo)) });
  const stats = cellStats(img);
  let empty = 0;
  let unknown = 0;
  let read = 0;
  console.log(`\n# ${t} 秒`);
  console.log('   ' + [...Array(9)].map((_, c) => `  ${9 - c} `).join(''));
  for (let row = 0; row < 9; row++) {
    const cells: string[] = [];
    for (let col = 0; col < 9; col++) {
      const p = r.board[row][col];
      if (isUnknown(p)) {
        unknown++;
        cells.push('  ？');
      } else if (!p) {
        empty++;
        cells.push('  ・');
      } else {
        read++;
        cells.push(`${p.side === 'sente' ? '▲' : '▽'}${NAMES[p.kind]}`.padStart(4, ' '));
      }
    }
    console.log(` ${String.fromCharCode(97 + row)} ${cells.join('')}`);
  }
  // 空と判定されたマスの sd を出す。しきい値ぎりぎりなら「覆われて平らになった」印。
  const lowSd: string[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      if (r.board[row][col] === null) {
        lowSd.push(`${9 - col}${String.fromCharCode(97 + row)}:${stats[row][col].sd.toFixed(0)}`);
      }
    }
  }
  console.log(`  読めた ${read} / 未確定 ${unknown} / 空 ${empty}（しきい値 sd>${OCCUPANCY_THRESHOLD} で駒あり）`);
  console.log(`  空と判定されたマスの sd: ${lowSd.join(' ')}`);
}
