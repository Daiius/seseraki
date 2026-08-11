// テンプレートどうしがどれだけ似ているかを測る。
//
// 成駒のテンプレートを足したら読める手が減った（61 → 52）。絵はきれいだったので、
// **他の駒と紛らわしいのではないか**という疑い。照合は「いちばん似ているものを選ぶ」
// だけなので、新しく足したテンプレートが他の駒を引き寄せると、正しく読めていた
// マスまで壊れる。
//
//   pnpm --filter kifu-vision exec tsx probe-template-similarity.ts <動画パス> [追加テンプレート]
import type { PieceKind } from 'shared';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop } from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { extractTemplates, ncc, type Template } from './src/template.ts';
import { loadTemplates, mergeTemplates } from './src/template-store.ts';

const video = process.argv[2];
const storePath = process.argv[3] ?? 'data/templates/shogi-wars-vertical.json';
const geo = SHOGI_WARS_VERTICAL;

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const label = (t: Template) => `${t.side === 'sente' ? '▲' : '▽'}${NAMES[t.kind]}`;

const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

const coarse = await findSegments(video, geo, 1);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
if (initials.length === 0) {
  console.error('初期局面が見つかりません');
  process.exit(1);
}
const seg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const base = extractTemplates(grabBoard(seg.representativeTime));
const extra = loadTemplates(storePath, { width: base[0].img.width, height: base[0].img.height }) ?? [];
const all = mergeTemplates(base, extra);

console.log(`# ${all.length} 種（初期局面から ${base.length} + 保存済み ${all.length - base.length}）`);

// 総当たりで相関を測る
interface Pair { a: Template; b: Template; score: number }
const pairs: Pair[] = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    pairs.push({ a: all[i], b: all[j], score: ncc(all[i].img, all[j].img) });
  }
}
pairs.sort((x, y) => y.score - x.score);

console.log('\n# 紛らわしい組み合わせ（上位 12）');
for (const p of pairs.slice(0, 12)) {
  console.log(`  ${label(p.a)} ⇔ ${label(p.b)}  ${p.score.toFixed(3)}`);
}

// 保存済みのテンプレートが、他とどれだけ紛らわしいか
for (const t of all.slice(base.length)) {
  const related = pairs.filter((p) => p.a === t || p.b === t).slice(0, 5);
  console.log(`\n# ${label(t)} と紛らわしいもの`);
  for (const p of related) {
    const other = p.a === t ? p.b : p.a;
    console.log(`    ${label(other)}  ${p.score.toFixed(3)}`);
  }
}

// 生駒どうしの相関の水準（比較の基準）
const baseOnly = pairs.filter((p) => base.includes(p.a) && base.includes(p.b)).map((p) => p.score);
baseOnly.sort((a, b) => b - a);
console.log(`\n# 生駒どうしの相関  最大 ${baseOnly[0].toFixed(3)} / 中央 ${baseOnly[Math.floor(baseOnly.length / 2)].toFixed(3)}`);
console.log('  （足したテンプレートがこの水準を超えて似ていれば、誤って引き寄せる）');
