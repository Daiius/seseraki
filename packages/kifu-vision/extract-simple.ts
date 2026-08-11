// 一定間隔で盤面を読み、配置が変わったときだけ手を導く。
//
// 区間分割や色のイベント検出を挟まない、いちばん素朴なやり方。
// 遠回りして分かったのは、**変化の検出に凝る必要が無かった**ということ。
//   - 駒の有無（輝度の散らばり）はマウスポインタで揺れる
//   - マスの平均色はハイライトの明滅でも動く
//   - どちらも「盤面が変わった」以外の理由で立つ
// 読んだ配置そのものを比べれば、そうした揺れは最初から入り込まない。
// 認識は NCC 中央値 0.98 と十分に安定しているので、これで足りる。
//
// 落とし穴は駒のスライド中の絵だけで、それは「駒が消えただけ」という形
// （`piece-vanished`）で確実に見分けられる。
//
//   pnpm --filter kifu-vision exec tsx extract-simple.ts <動画パス> [開始秒] [終了秒] [間隔秒]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY, occupancy } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { extractTemplates, cellImage, type Template } from './src/template.ts';
import { recognizeBoard, boardsEqual, boardDiff, carryUnknowns } from './src/recognize.ts';
import { inferMove, verifyMove, type InferFailure } from './src/moves.ts';
import { solveUnknowns, type UnknownCell } from './src/solve.ts';
import { checkBoard, pieceCount } from './src/sanity.ts';
import type { PieceKind, Square } from 'shared';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 300);
const stepSec = Number(process.argv[5] ?? 0.5);
const geo = SHOGI_WARS_VERTICAL;
const LEARN_DIR = process.env.KIFU_VISION_LEARN_DIR ?? 'data/learned';
const VERBOSE = process.env.KIFU_VISION_VERBOSE === '1';

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const ALL_KINDS = Object.keys(NAMES) as PieceKind[];
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

// --- 初期局面からテンプレートを作る ---
console.log('# 全編を 1fps で走査して初期局面を探す');
const coarse = await findSegments(video, geo, 1);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
console.log(`  初期局面: ${initials.map((s) => `${fmt(s.representativeTime)}(${s.length}f)`).join(', ') || 'なし'}`);
if (initials.length === 0) {
  console.error('初期局面が見つからないためテンプレートを作れません');
  process.exit(1);
}
const templateSeg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const templates: Template[] = extractTemplates(grabBoard(templateSeg.representativeTime));
console.log(`  ${fmt(templateSeg.representativeTime)} から ${templates.length} 種を抽出（生駒のみ）`);

const missingKinds = () => ALL_KINDS.filter((k) => !templates.some((t) => t.kind === k));

function dumpPgm(img: GrayImage, path: string) {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

function learn(img: GrayImage, row: number, col: number, kind: PieceKind, side: 'sente' | 'gote', at: number) {
  if (templates.some((t) => t.kind === kind && t.side === side)) return;
  const cell = cellImage(img, row, col);
  templates.push({ kind, side, samples: 1, img: cell });
  dumpPgm(cell, `${LEARN_DIR}/${side}-${kind.replace('+', 'p')}-at${Math.round(at)}s.pgm`);
  console.log(`  ★ ${fmt(at)} 新しい駒を覚えた: ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}`);
}

// --- 一定間隔で読む ---
console.log(`\n# ${fmt(fromSec)}〜${fmt(toSec)} を ${stepSec} 秒間隔で読む`);
interface Step {
  time: number;
  usi: string;
  side: string;
  solved: boolean;
}
const steps: Step[] = [];
const failures = new Map<string, number>();
let current: Square[][] | null = null;
let samples = 0;
let unchanged = 0;
let vanished = 0;
let insane = 0;
let detailShown = 0;
let carriedUsed = 0;
const started = Date.now();

for (let t = fromSec; t <= toSec; t += stepSec) {
  samples++;
  const img = grabBoard(t);
  const recognized = recognizeBoard(img, templates);

  // ⚠ ここで `pruneOverflow` を使って偽の駒を削る手も試したが、**逆効果だった**。
  // 「盤面が成立せず捨てた」は 163 → 16 に減るものの、代わりに
  // too-many-changes が 145 件、illegal-shape が 111 件出た。
  // マウスポインタが**本物の駒**に重なるとその駒の一致度も下がるので、
  // 本物の方を削ってしまい、差分が壊れる。読めた手は 7 手で変わらなかった。
  // 中途半端に直すより、成立しない絵はまるごと捨てて次を見る方がよい。

  if (!current) {
    // 起点だけは素の読みで判断する（引き継ぐ相手がまだ無い）
    const sane = checkBoard(recognized.board);
    if (!sane.ok) {
      insane++;
      if (VERBOSE && insane <= 3) console.log(`  ⚠ ${fmt(t)} 盤面が成立しない: ${sane.problems.slice(0, 3).join(' / ')}`);
      continue;
    }
    current = recognized.board;
    console.log(`  起点: ${fmt(t)}（盤上の駒 ${pieceCount(current)} 枚）`);
    continue;
  }

  // 読めなかったマス（マウスポインタや演出に覆われた）は、**変わっていないと
  // 仮定して直前の配置を引き継ぐ**。覆われただけなら駒はそこにあり続けている。
  // 誤った駒として読むと差分が壊れるが、引き継げば壊れない。
  //
  // 駒が取られて消えた場合は駒の有無が変わるので、引き継いでも 1 手差分に
  // ならず、下の経路に落ちる。覆われている間に相手の駒に置き換わった場合だけは
  // 見逃しうるが、次に読める時点で辻褄が合わなくなるので取りこぼしに気付ける。
  const carried: Square[][] | null =
    recognized.lowConfidence.length > 0
      ? carryUnknowns(recognized.board, recognized.lowConfidence, current)
      : null;

  // 成立するかは引き継いだ版で見る。素の読みは偽の駒で崩れていることがあり、
  // それを理由に絵ごと捨てると、実際には読めるはずの手まで落としてしまう。
  const primary: Square[][] = carried ?? recognized.board;
  const sane = checkBoard(primary);
  if (!sane.ok) {
    insane++;
    if (VERBOSE && insane <= 3) console.log(`  ⚠ ${fmt(t)} 盤面が成立しない: ${sane.problems.slice(0, 3).join(' / ')}`);
    continue;
  }

  if (boardsEqual(primary, current)) {
    unchanged++;
    continue;
  }

  // まず引き継いだ版で読む。通らなければ素の読みで試す（成りはこちらでしか出ない）。
  let result = inferMove(current, primary);
  let board: Square[][] = primary;
  let solved = false;
  if (result.move && carried) carriedUsed++;

  if (!result.move && carried && !boardsEqual(recognized.board, current)) {
    const alt = inferMove(current, recognized.board);
    if (alt.move) {
      result = alt;
      board = recognized.board;
    }
  }

  if (!result.move && recognized.lowConfidence.length > 0 && recognized.lowConfidence.length <= 2) {
    const unknowns: UnknownCell[] = recognized.lowConfidence.map((c) => ({ row: c.row, col: c.col, inAfter: true }));
    const s = solveUnknowns(current, recognized.board, unknowns, missingKinds());
    if (s) {
      board = recognized.board.map((r) => r.slice());
      for (const r of s.resolved) {
        board[r.row][r.col] = r.piece;
        learn(img, r.row, r.col, r.piece.kind, r.piece.side, t);
      }
      result = inferMove(current, board);
      solved = true;
    }
  }

  // 駒がスライドしている途中。局面として採らず、current も更新しない。
  if (result.failure === 'piece-vanished') {
    vanished++;
    continue;
  }

  if (result.move && verifyMove(current, result.move.usi, result.move.side, board)) {
    steps.push({ time: t, usi: result.move.usi, side: result.move.side, solved });
    current = board;
    continue;
  }

  const why = result.move ? 'verify-failed' : result.failure!;
  failures.set(why, (failures.get(why) ?? 0) + 1);
  if (VERBOSE && detailShown < 10) {
    detailShown++;
    const diff = boardDiff(current, board);
    console.log(`  ⚠ ${fmt(t)} ${why}（${diff.length} マス）`);
    for (const d of diff.slice(0, 6)) {
      const show = (p: Square) => (p ? `${p.side === 'sente' ? '▲' : '▽'}${NAMES[p.kind]}` : '空');
      console.log(`      ${9 - d.col}${String.fromCharCode(97 + d.row)}: ${show(d.before)} → ${show(d.after)}`);
    }
  }
  // 読めなかった絵は捨てる。current は据え置き、次の絵と比べ直す。
}

console.log(`\n# ${samples} 点を ${((Date.now() - started) / 1000).toFixed(1)} 秒で読んだ`);
console.log(`  配置が変わらなかった: ${unchanged}`);
console.log(`  スライド途中で捨てた: ${vanished}`);
console.log(`  読めないマスを引き継いで通った: ${carriedUsed}`);
console.log(`  盤面が成立せず捨てた: ${insane}`);
console.log(`  読めた手: ${steps.length}`);
if (failures.size > 0) {
  console.log('  読めなかった変化:');
  for (const [f, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`    ${f}: ${n}`);
}

console.log(`\n# 復元した手順（${steps.length} 手）`);
let line = '';
for (const [i, s] of steps.entries()) {
  line += `${s.usi}${s.solved ? '*' : ''} `;
  if ((i + 1) % 10 === 0) { console.log(`  ${line}`); line = ''; }
}
if (line) console.log(`  ${line}`);

// 手番が交互になっているか。崩れていたらどこかで手を取りこぼしている。
let alternations = 0;
for (let i = 1; i < steps.length; i++) if (steps[i].side !== steps[i - 1].side) alternations++;
console.log(`\n# 手番が交互になった箇所: ${alternations} / ${Math.max(0, steps.length - 1)}`);
console.log('  （1.0 に近いほど取りこぼしが少ない。低いなら手を飛ばしている）');

console.log('\n# 時刻つき');
for (const s of steps) console.log(`  ${fmt(s.time).padStart(7)}  ${s.side === 'sente' ? '▲' : '▽'} ${s.usi}${s.solved ? '  (駒種を逆算)' : ''}`);
