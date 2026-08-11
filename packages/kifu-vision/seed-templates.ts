// 目で見て駒種を確かめたマスから、成駒のテンプレートを作って保存する。
//
// 成駒は平手初期局面に無いので、初期局面からは作れない。手の整合性から逆算する
// 経路（solveUnknowns）もあるが、成りが起きる瞬間は駒が動いていてポインタも近く、
// いちばん読みにくい。実際この動画では 1 種しか取れなかった。
//
// テンプレートが無い駒は**別の駒として読まれ、しかも盤上に居座り続ける**ので、
// その区間はまるごと読めなくなる。実測では龍が「桂」と読まれ続け、
// 4:20〜12:43 の 8 分間が丸ごと落ちていた。
//
// ここでは「この時刻のこのマスはこの駒」という対応を人が与えて切り出す。
// **画面レイアウトが変わらない限り、一度作れば他の動画にも使い回せる。**
//
//   pnpm --filter kifu-vision exec tsx seed-templates.ts <動画パス> [出力先]
import type { PieceKind, Side } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { cellImage, ncc, type Template } from './src/template.ts';
import { saveTemplates, loadTemplates, mergeTemplates } from './src/template-store.ts';
import { collectPointerSamples, similarityToPointers } from './src/pointer-samples.ts';

const video = process.argv[2];
const outPath = process.argv[3] ?? 'data/templates/shogi-wars-vertical.json';
const geo = SHOGI_WARS_VERTICAL;

/**
 * ポインタとの相関がこれを超えたら採用しない。
 *
 * 生駒どうしの相関は実測で最大 0.415、中央 0.103。駒でないものとの相関が
 * それに近いなら、駒として使い物にならない。
 */
const POINTER_SIMILARITY_LIMIT = Number(process.env.KIFU_VISION_POINTER_LIMIT ?? 0.3);

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};

/**
 * 目で確かめた対応。
 *
 * 駒の向きは五角形の尖った方で分かる（相手を向く）。後手の駒は尖った方が下。
 * 龍の草書体は「ス」に見え、と金は「と」。
 */
interface Seed {
  seconds: number;
  square: string;
  kind: PieceKind;
  side: Side;
  note: string;
}

const SEEDS: Seed[] = [
  { seconds: 336, square: '2b', kind: '+P', side: 'sente', note: '「と」の字・尖りが上' },

  // ⚠ 4:32 の 8g にある ▽龍（「ス」の字）も同じ手順で起こせるが、**入れると悪化した**
  // （61 手 → 52 手）。切り出した絵はきれいでハイライトの汚染も無かったのに、
  // 実際に流すと読める手が減る。理由は未解明。**絵が良さそうに見えても、
  // 抽出できた手で確かめてからでないと採用してはいけない。**
  // { seconds: 272, square: '8g', kind: '+R', side: 'gote', note: '「ス」の字・尖りが下' },
];

function at(usi: string): { row: number; col: number } {
  return { row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) };
}

const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const made: Template[] = [];
for (const seed of SEEDS) {
  const { row, col } = at(seed.square);
  const img = cellImage(grabBoard(seed.seconds), row, col);
  made.push({ kind: seed.kind, side: seed.side, samples: 1, img });
  console.log(
    `  ${Math.floor(seed.seconds / 60)}:${String(seed.seconds % 60).padStart(2, '0')} ${seed.square}` +
      ` → ${seed.side === 'sente' ? '▲' : '▽'}${seed.kind}  ${img.width}x${img.height}  （${seed.note}）`,
  );
}

// ⚠ **駒でないものと似ていないかを必ず見る。** 龍のテンプレートを足したとき、
// 駒どうしでは十分に区別できていたのに、マウスポインタを引き寄せて読める手が
// 減った（61 → 52）。白い矢印の濃淡が「ス」の字と相関していた。
console.log('\n# マウスポインタの絵と照合する');
const pointers = collectPointerSamples(video, geo, { fromSec: 60, toSec: 900, stepSec: 15, max: 24 });
console.log(`  ポインタだけが乗った空マスを ${pointers.length} 枚集めた`);
let rejected = 0;
const safe = made.filter((t) => {
  const sim = similarityToPointers(t.img, pointers);
  const verdict = sim > POINTER_SIMILARITY_LIMIT ? '⚠ 却下' : 'OK';
  console.log(`  ${t.side === 'sente' ? '▲' : '▽'}${NAMES[t.kind]}  ポインタとの最大相関 ${sim.toFixed(3)}  ${verdict}`);
  if (sim > POINTER_SIMILARITY_LIMIT) rejected++;
  return sim <= POINTER_SIMILARITY_LIMIT;
});
if (rejected > 0) {
  console.log(`  → ${rejected} 種を却下した（ポインタと紛らわしい）`);
}
made.length = 0;
made.push(...safe);
if (made.length === 0) {
  console.error('\n採用できるテンプレートがありません');
  process.exit(1);
}

// 取り違えていないかの目安: 作ったもの同士が似すぎていたら、同じ駒を 2 回
// 拾っている疑いがある
for (let i = 0; i < made.length; i++) {
  for (let j = i + 1; j < made.length; j++) {
    const sim = ncc(made[i].img, made[j].img);
    if (sim > 0.9) {
      console.log(`  ⚠ ${made[i].kind}(${made[i].side}) と ${made[j].kind}(${made[j].side}) が似すぎています（NCC=${sim.toFixed(3)}）`);
    }
  }
}

const existing = loadTemplates(outPath, { width: made[0].img.width, height: made[0].img.height }) ?? [];
const merged = mergeTemplates(existing, made);
saveTemplates(merged, outPath);
console.log(`\n# ${merged.length} 種を ${outPath} に保存（既存 ${existing.length} + 新規 ${merged.length - existing.length}）`);
for (const t of merged) console.log(`    ${t.side === 'sente' ? '▲' : '▽'}${t.kind}`);
