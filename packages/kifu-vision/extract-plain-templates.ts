// 生駒 16 種を、演出の乗っていない動画フレームから起こして保存する。
//
//   pnpm --filter kifu-vision exec tsx extract-plain-templates.ts <動画> [開始秒] [終了秒]
//
// 既定は確認だけで保存しない。保存するには KIFU_VISION_SAVE=1 を付ける。
// 読み元は KIFU_VISION_TEMPLATES（既定は正典）、書き先は KIFU_VISION_TEMPLATES_OUT。
//
// ⭐ **なぜ動画から起こすのに「事前取得」なのか。**
// 起こす作業を走査のたびにやるのをやめる、という話である。走査のたびに起こすと
// **どのフレームを引くかで出来が変わる**。実測（2 本目）: 初期局面の 0:02 に
// 対局開始の演出（キャラクターの絵と光の帯）が乗っていて、その下にあった角と飛が
// 濁った。**同じ駒どうしで NCC 0.512** までしか合わず、盤上の本物の角はどこでも
// 0.44 前後になり、駒があると分かっているマスが未確定のまま残って、指した手が
// そのまま棋譜から落ちた（先手の `B*4g` ほか）。1 本目の 0:02 は演出が無いので
// この欠陥は一度も発火しなかった。**当たり外れのある工程を、資産に置き換える。**
//
// ⚠ **受け取った画像（`extract-handoff-templates.ts`）では生駒を賄えない。**
// あちらのマスは 48x53 で、照合に使う動画のマス 61x66 へ引き伸ばすと絵が甘くなる。
// 実測で、本物のマスに合う度合いが 0.87（動画から起こせば 0.99）まで落ち、
// 1 本目が 92+81 手・2 断片から 82+77 手・4 断片に退行した。**成駒は動画から
// 起こせないので引き伸ばしを受け入れるしかないが、生駒にその必要は無い。**
//
// 🔒 **切り出し寸法が同じなら、読み込み時の `resample` は素通りする**
// （`template.ts` が同寸法なら元の絵をそのまま返す）。つまりこの動画で採った
// 生駒をこの動画で使う限り、**テンプレートはビット一致**する。
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { extractTemplates, ncc } from './src/template.ts';
import { loadTemplates, saveTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { findSegments } from './src/segments.ts';
import { occupancy, occupancyDistance } from './src/occupancy.ts';
import { createInitialState, type PieceKind } from 'shared';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 1833);
const STORE_IN = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
const STORE_OUT = process.env.KIFU_VISION_TEMPLATES_OUT ?? STORE_IN;
const SAVE = process.env.KIFU_VISION_SAVE === '1';

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const label = (kind: PieceKind, side: string) => `${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}`;
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// 🔒 **本線（`extract-simple.ts`）と同じ手順で較正し、同じ区間を選ぶ。**
// ここがずれると、採ったテンプレートが本線の切り出しと合わなくなる。
// 合っていることは「1 本目の USI 列が 1 手も変わらない」ことで確かめる。
const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calSeconds = Array.from(
  { length: CAL_POINTS },
  (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1),
)
  .filter((s) => s > 0)
  .map((s) => Math.round(s));
const calibration = calibrateFromFrames(
  calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
  SHOGI_WARS_VERTICAL,
);
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
console.log(`# ${video}  ${fromSec}〜${toSec} 秒`);
if (calibration) {
  const { shift, resize, used, tried } = calibration;
  console.log(
    `  格子: ${used}/${tried} 枚から決めた  ずれ (${shift.x.toFixed(2)}, ${shift.y.toFixed(2)})` +
      `  マス寸法 (${resize.w.toFixed(2)}, ${resize.h.toFixed(2)})`,
  );
}
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const { board: initialBoard } = createInitialState();
const INITIAL_OCCUPANCY = initialBoard.map((r) => r.map((c) => c !== null));
const coarse = await findSegments(video, geo, 1, 4);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
console.log(`  初期局面: ${initials.map((s) => `${fmt(s.representativeTime)}(${s.length}f)`).join(', ') || 'なし'}`);
if (initials.length === 0) {
  console.error('初期局面が見つからない');
  process.exit(1);
}
const seg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const at = seg.representativeTime;
const plain = extractTemplates(grabBoard(at));
console.log(`  ${fmt(at)}（${at} 秒）から ${plain.length} 種  マス ${plain[0].img.width}x${plain[0].img.height}`);

// --- 🔒 演出が乗っていないことを、絵そのものから確かめる ---
//
// 演出の下の駒は輪郭が溶けて**互いに似る**。字が残っていれば、駒どうしは
// はっきり別物になる。実測（1 本目・演出なし）で生駒どうしの最大相関は 0.415。
// **この数字が上がっていたら、そのフレームは採取に使えない。**
console.log('\n# 🔒 検証: 駒どうしがはっきり別物か（演出が乗っていれば互いに似る）');
let worst = { s: -2, what: '' };
const maxima: number[] = [];
for (const t of plain) {
  const others = plain.filter((o) => o !== t);
  const top = others.map((o) => ({ o, s: ncc(o.img, t.img) })).sort((a, b) => b.s - a.s)[0];
  maxima.push(top.s);
  if (top.s > worst.s) worst = { s: top.s, what: `${label(t.kind, t.side)} と ${label(top.o.kind, top.o.side)}` };
}
const sorted = [...maxima].sort((a, b) => a - b);
console.log(`  最大相関: 中央 ${sorted[sorted.length >> 1].toFixed(3)} / 最大 ${worst.s.toFixed(3)}（${worst.what}）`);
const LIMIT = Number(process.env.KIFU_VISION_PLAIN_MAX_NCC ?? 0.55);
if (worst.s > LIMIT) {
  console.error(`\n🔴 駒どうしが似すぎている（${worst.s.toFixed(3)} > ${LIMIT}）。演出が乗ったフレームの疑いがあるので採取しない。`);
  process.exit(1);
}

// --- 保存 ---
const before = loadTemplates(STORE_IN) ?? [];
console.log(`\n# 読み元 ${STORE_IN}: ${before.length} 種`);
// ⭐ **新しく採った生駒を先に置く。** 同じ駒種があれば新しい方で置き換わり、
// 成駒（この動画からは採れない）は読み元のものがそのまま残る。
const merged = mergeTemplates(plain, before);
console.log(`  → ${merged.length} 種（生駒 ${plain.length} 種を差し替え・残りは読み元のまま）`);
if (!SAVE) {
  console.log('\n# 確認のみ（保存するには KIFU_VISION_SAVE=1）');
} else {
  saveTemplates(merged, STORE_OUT);
  console.log(`\n# 保存した: ${merged.length} 種 → ${STORE_OUT}`);
}
