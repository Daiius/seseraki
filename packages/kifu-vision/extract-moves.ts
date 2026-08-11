// 動画から指し手を復元する（Task 1 + Task 2 の実地検証）。
//
// 1. 全編を粗くスキャンし、駒の有無が変わらない「区間」に切り分ける
// 2. 区間を頭から順に読む。**読みながらテンプレートを育てる**
//    - 初期局面から作れるのは生駒 8 種 × 2 向きだけ。成駒はテンプレートが無い
//    - 読めなかったマスは、手の整合性から駒種を逆算する（solveUnknowns）
//    - 逆算で確定した駒種はテンプレートとして登録し、以降は照合で読める
// 3. 隣り合う配置の差分から手を導き、applyMove で検算する
//
// 区間は駒の有無で切っているが、エフェクトで有無がちらつくことがあるので、
// 読んだ配置が直前と同じ区間は読み飛ばす。
//
//   pnpm --filter kifu-vision exec tsx extract-moves.ts <動画パス> [開始秒] [終了秒] [fps]
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { findStableMoments } from './src/events.ts';
import { extractTemplates, cellImage, type Template } from './src/template.ts';
import { recognizeBoard, boardsEqual, boardDiff } from './src/recognize.ts';
import { inferMove, verifyMove, type InferFailure } from './src/moves.ts';
import { solveUnknowns, type UnknownCell } from './src/solve.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PieceKind, Square } from 'shared';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? Infinity);
const FPS = Number(process.argv[5] ?? 10);
/**
 * これより短い区間は局面として採らない。
 *
 * 駒はスライドして動くので、移動元が空いてから移動先が埋まるまでの間、
 * 「駒がどこにも無い」中間状態が数フレーム挟まる。実測では 30fps で見たとき
 * 1 手が「1 マス変化 × 2 回」に分解して見えた。この中間状態は短命なので、
 * 一定フレーム数続いた区間だけを局面と見なせば自然に除外できる。
 */
const MIN_SEGMENT = Number(process.argv[6] ?? 3);
const geo = SHOGI_WARS_VERTICAL;
const LEARN_DIR = process.env.KIFU_VISION_LEARN_DIR ?? 'data/learned';

const NAMES: Record<PieceKind, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
  '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍',
};
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const grabBoard = (sec: number) => crop(grabFrame(video, sec, geo.frameW, geo.frameH), boardRect(geo));

// --- 全編を粗く見て初期局面を探す（テンプレートの素） ---
console.log('# 全編を 1fps で走査して初期局面を探す');
const coarse = await findSegments(video, geo, 1);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);

// --- 対象範囲を細かく見る ---
const range = {
  startSec: fromSec > 0 ? fromSec : undefined,
  durationSec: Number.isFinite(toSec) ? toSec - fromSec : undefined,
};
console.log(`# ${fmt(fromSec)}〜${Number.isFinite(toSec) ? fmt(toSec) : '終端'} を ${FPS}fps で走査（マスの平均色の変化を追う）`);
const moments = await findStableMoments(video, geo, FPS, range);
console.log(`  盤面が動いて収まった時点: ${moments.length} 件`);
const mhist = new Map<number, number>();
for (const m of moments) mhist.set(Math.min(m.changed.length, 6), (mhist.get(Math.min(m.changed.length, 6)) ?? 0) + 1);
console.log('  色が変わったマス数の内訳:');
for (const [n, c] of [...mhist].sort((a, b) => a[0] - b[0])) {
  console.log(`    ${n === 6 ? '6+' : ` ${n}`} マス: ${c} 件`);
}
const segments = moments.map((m) => ({ representativeTime: m.time, length: 1, occupancy: [] as boolean[][] }));
console.log(`# 初期局面の区間: ${initials.map((s) => `${fmt(s.representativeTime)}(${s.length}f)`).join(', ') || 'なし'}`);
if (initials.length === 0) {
  console.error('初期局面が見つからないためテンプレートを作れません');
  process.exit(1);
}
const templateSeg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const templates: Template[] = extractTemplates(grabBoard(templateSeg.representativeTime));
console.log(`  ${fmt(templateSeg.representativeTime)} から ${templates.length} 種を抽出（生駒のみ）`);

const ALL_KINDS: PieceKind[] = [
  'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K', '+P', '+L', '+N', '+S', '+B', '+R',
];

const hasTemplate = (kind: PieceKind, side: string) =>
  templates.some((t) => t.kind === kind && t.side === side);

/**
 * まだテンプレートを持っていない駒種。
 *
 * 逆算の候補はこれに絞る。全駒種を候補にすると、敵陣に入る手が
 * 「成った」とも「成らなかった」とも読めてしまい、必ず曖昧になる。
 */
const missingKinds = (): PieceKind[] => ALL_KINDS.filter((k) => !templates.some((t) => t.kind === k));

/** 覚えた駒の絵を PGM で書き出す。誤って覚えていないか目で確かめるため。 */
function dumpPgm(img: GrayImage, path: string) {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

function learn(img: GrayImage, row: number, col: number, kind: PieceKind, side: 'sente' | 'gote', at: number) {
  if (hasTemplate(kind, side)) return;
  const cell = cellImage(img, row, col);
  templates.push({ kind, side, samples: 1, img: cell });
  const safe = kind.replace('+', 'p');
  dumpPgm(cell, `${LEARN_DIR}/${side}-${safe}-at${Math.round(at)}s.pgm`);
  console.log(`    ★ ${fmt(at)} 新しい駒を覚えた: ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}（手の整合性から確定）`);
}

// --- 頭から順に読む ---
console.log('\n# 区間を順に読みながら手を導く');
interface Step {
  time: number;
  usi?: string;
  side?: string;
  failure?: InferFailure | 'verify-failed';
  changedCells: number;
  solved?: boolean;
}

// ⚠ 範囲の途中から始めるときに初期局面を起点にしてはいけない。
// その時点の盤面は初期配置ではないので、以後の差分がすべてずれる。
// 最初に読めた区間をそのまま起点にする（fromSec が 0 なら初期局面が来る）。
let current: Square[][] | null = null;
const steps: Step[] = [];
let skippedSame = 0;
let solvedCount = 0;
let failureDetails = 0;
let vanished = 0;
const VERBOSE = process.env.KIFU_VISION_VERBOSE === '1';
const MAX_FAILURE_DETAILS = 12;
const started = Date.now();

for (const seg of segments) {
  const img = grabBoard(seg.representativeTime);
  const recognized = recognizeBoard(img, templates);

  // 起点。ここから差分を追い始める。
  if (!current) {
    current = recognized.board;
    console.log(`  起点: ${fmt(seg.representativeTime)}（盤上の駒 ${recognized.board.flat().filter(Boolean).length} 枚）`);
    continue;
  }

  // エフェクトで有無がちらついただけの区間は読み飛ばす
  if (boardsEqual(recognized.board, current)) {
    skippedSame++;
    continue;
  }

  let result = inferMove(current, recognized.board);
  let board = recognized.board;
  let solved = false;

  // 素直に読めなければ、読めなかったマスの駒種を手の整合性から逆算する
  if (!result.move && recognized.lowConfidence.length > 0 && recognized.lowConfidence.length <= 2) {
    const unknowns: UnknownCell[] = recognized.lowConfidence.map((c) => ({
      row: c.row,
      col: c.col,
      inAfter: true,
    }));
    const s = solveUnknowns(current, recognized.board, unknowns, missingKinds());
    if (s) {
      board = recognized.board.map((r) => r.slice());
      for (const r of s.resolved) {
        board[r.row][r.col] = r.piece;
        learn(img, r.row, r.col, r.piece.kind, r.piece.side, seg.representativeTime);
      }
      result = inferMove(current, board);
      solved = true;
      solvedCount++;
    }
  }

  // 駒がスライドしている途中の絵。局面として採らず、次の区間と比べ直す。
  if (result.failure === 'piece-vanished') {
    vanished++;
    continue;
  }

  const step: Step = { time: seg.representativeTime, changedCells: result.changedCells, solved };
  if (result.move && verifyMove(current, result.move.usi, result.move.side, board)) {
    step.usi = result.move.usi;
    step.side = result.move.side;
  } else {
    step.failure = result.move ? 'verify-failed' : result.failure;
    // 何が食い違ったのかを実際に見る。統計だけでは原因に辿り着けない。
    if (VERBOSE && failureDetails < MAX_FAILURE_DETAILS) {
      failureDetails++;
      const diff = boardDiff(current, board);
      console.log(`\n  --- ${fmt(seg.representativeTime)} ${step.failure}（${diff.length} マス食い違い）---`);
      for (const d of diff.slice(0, 8)) {
        const show = (p: Square) => (p ? `${p.side === 'sente' ? '▲' : '▽'}${NAMES[p.kind]}` : '空');
        const lc = recognized.lowConfidence.find((c) => c.row === d.row && c.col === d.col);
        console.log(
          `    ${9 - d.col}${String.fromCharCode(97 + d.row)}: ${show(d.before)} → ${show(d.after)}` +
            (lc ? `  ⚠ NCC=${lc.score.toFixed(3)}` : ''),
        );
      }
    }
  }
  steps.push(step);
  current = board;
}

console.log(`  ${segments.length} 区間を ${((Date.now() - started) / 1000).toFixed(1)} 秒で処理`);
console.log(`  配置が変わらず読み飛ばした区間: ${skippedSame}`);
console.log(`  スライド途中と判断して捨てた区間: ${vanished}`);
console.log(`  駒種を逆算で確定した回数: ${solvedCount}`);
console.log(`  最終的なテンプレート数: ${templates.length}`);

const ok = steps.filter((s) => s.usi);
console.log(`\n# 手として読めた: ${ok.length} / ${steps.length}`);
const failures = new Map<string, number>();
for (const s of steps) if (s.failure) failures.set(s.failure, (failures.get(s.failure) ?? 0) + 1);
for (const [f, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`    ${f}: ${n}`);

let bestRun: Step[] = [];
let run: Step[] = [];
for (const s of steps) {
  if (s.usi) {
    run.push(s);
    if (run.length > bestRun.length) bestRun = run;
  } else {
    run = [];
  }
}
console.log(`\n# 連続して読めた最長: ${bestRun.length} 手`);
if (bestRun.length) {
  console.log(`  ${fmt(bestRun[0].time)} 〜 ${fmt(bestRun.at(-1)!.time)}`);
  console.log(`  ${bestRun.map((s) => s.usi).join(' ')}`);
}

console.log('\n# 最初の 40 区間の詳細');
for (const s of steps.slice(0, 40)) {
  const mark = s.usi ? (s.solved ? '★ ' : '  ') : '⚠ ';
  const what = s.usi ? `${s.usi} (${s.side})` : `${s.failure} [${s.changedCells}マス]`;
  console.log(`${mark}${fmt(s.time).padStart(7)}  ${what}`);
}
