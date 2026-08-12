// テンプレートどうしがどれだけ紛らわしいかを、対照込みで並べる（検証用）。
//
// 「A と B の相関が 0.8 ある」だけでは何も言えない。**同じ出所の別の駒どうしが
// 普段どれくらい相関するか**を並べて初めて、その 0.8 が高いのか普通なのかが分かる。
//
//   pnpm --filter kifu-vision exec tsx probe-confusion.ts [動画] [初期局面の秒]
import type { PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { extractTemplates, ncc } from './src/template.ts';
import { loadTemplates } from './src/template-store.ts';

const video = process.argv[2] ?? 'data/videos/fQR9Fx7DOvk.mp4';
const initialAt = Number(process.argv[3] ?? 2.5);
const STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const geo = SHOGI_WARS_VERTICAL;
const raw = extractTemplates(crop(grabFrame(video, initialAt, geo.frameW, geo.frameH), boardRect(geo)));
const size = { width: raw[0].img.width, height: raw[0].img.height };
const stored = loadTemplates(STORE, size) ?? [];

const sente = raw.filter((t) => t.side === 'sente');
console.log('# 対照: 動画から採った生駒どうし（同じ出所・同じ寸法）');
const pairs: { a: string; b: string; s: number }[] = [];
for (let i = 0; i < sente.length; i++) {
  for (let j = i + 1; j < sente.length; j++) {
    pairs.push({ a: NAMES[sente[i].kind], b: NAMES[sente[j].kind], s: ncc(sente[i].img, sente[j].img) });
  }
}
pairs.sort((x, y) => y.s - x.s);
console.log(`  最大 ${pairs[0].s.toFixed(3)}（${pairs[0].a}⇔${pairs[0].b}）`);
console.log(`  上位 5: ${pairs.slice(0, 5).map((p) => `${p.a}⇔${p.b} ${p.s.toFixed(3)}`).join(' / ')}`);
const ss = pairs.map((p) => p.s).sort((a, b) => a - b);
console.log(`  中央 ${ss[ss.length >> 1].toFixed(3)}  最小 ${ss[0].toFixed(3)}`);

console.log('\n# 保存済み（受け取った絵から起こした成駒）が生駒とどれだけ相関するか');
for (const t of stored.filter((x) => x.side === 'sente')) {
  const scored = sente.map((r) => ({ r, s: ncc(r.img, t.img) })).sort((a, b) => b.s - a.s);
  console.log(
    `  ${NAMES[t.kind]}: ${scored.slice(0, 3).map((x) => `${NAMES[x.r.kind]} ${x.s.toFixed(3)}`).join(' / ')}`,
  );
}
