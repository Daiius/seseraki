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
import { dirname, basename } from 'node:path';
import { SHOGI_WARS_VERTICAL, boardRect } from './src/geometry.ts';
import { grabFrame, crop, type GrayImage } from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY, occupancy, hasPointer } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { extractTemplates, cellImage, ncc, type Template } from './src/template.ts';
import { recognizeBoard, boardsEqual, boardDiff, carryUnknowns } from './src/recognize.ts';
import { settle, resolveWith, fillGuesses, unknownCells, markUnknown, isUnknown, type VisionSquare } from './src/uncertain.ts';
import { inferMove, verifyMove, opposite, type InferFailure } from './src/moves.ts';
import { pickCandidate } from './src/candidate.ts';
import { startState, startFromBoard, handsAreGuessed } from './src/tracking.ts';
import { solveUnknowns, type UnknownCell } from './src/solve.ts';
import { loadTemplates, saveTemplates, mergeTemplates } from './src/template-store.ts';
import { bridgeGap } from './src/bridge.ts';
import { calibrateFromFrames } from './src/calibrate.ts';
import { ReadingHistory } from './src/confirm.ts';
import { rescueVanished } from './src/vanished.ts';
import { checkBoard, pieceCount, overflowCells } from './src/sanity.ts';
import { applyMove, type BoardState, type PieceKind, type Side, type Square } from 'shared';

const video = process.argv[2];
const fromSec = Number(process.argv[3] ?? 0);
const toSec = Number(process.argv[4] ?? 300);
const stepSec = Number(process.argv[5] ?? 0.5);
const LEARN_DIR = process.env.KIFU_VISION_LEARN_DIR ?? 'data/learned';
const OUT_DIR = process.env.KIFU_VISION_OUT_DIR ?? 'data/kifu';
const TEMPLATE_STORE = process.env.KIFU_VISION_TEMPLATES ?? 'data/templates/shogi-wars-vertical.json';
const VERBOSE = process.env.KIFU_VISION_VERBOSE === '1';

// --- 盤の格子をこの動画に合わせて測り直す ---
// 定数は 1 本の動画から測ったもので、別の動画では数ピクセルずれうる。ずれると
// 全マスの切り出しが一様にずれ、いちばん読みにくいマスから順に読めなくなる。
// 何枚か測って中央値を採る（盤が写っていない絵は「はっきりしない」ので落ちる）。
console.log('# 盤の格子をこの動画に合わせて測る');
const calSeconds = [fromSec + 1, fromSec + 60, (fromSec + toSec) / 2, toSec - 60, toSec - 1]
  .filter((s) => s > 0)
  .map((s) => Math.round(s));
const calibration = process.env.KIFU_VISION_NO_CALIBRATE === '1'
  ? null
  : calibrateFromFrames(
      calSeconds.map((s) => grabFrame(video, s, SHOGI_WARS_VERTICAL.frameW, SHOGI_WARS_VERTICAL.frameH)),
      SHOGI_WARS_VERTICAL,
    );
const geo = calibration?.geo ?? SHOGI_WARS_VERTICAL;
if (calibration) {
  const { shift, resize, used, tried } = calibration;
  console.log(
    `  ${used}/${tried} 枚から決めた: ずれ (${shift.x.toFixed(2)}, ${shift.y.toFixed(2)})` +
      `  マス寸法 (${resize.w >= 0 ? '+' : ''}${resize.w.toFixed(2)}, ${resize.h >= 0 ? '+' : ''}${resize.h.toFixed(2)})`,
  );
  if (Math.abs(shift.x) < 0.5 && Math.abs(shift.y) < 0.5) console.log('  → 定数のままでよい動画だった');
} else {
  console.log(`  ⚠ 格子がはっきり出ているフレームが無かった。定数をそのまま使う`);
}

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
const fromInitial = extractTemplates(grabBoard(templateSeg.representativeTime));
console.log(`  ${fmt(templateSeg.representativeTime)} から ${fromInitial.length} 種を抽出（生駒のみ）`);

// 以前に作った成駒のテンプレートがあれば足す。成駒は初期局面に無いので
// ここで補わないと、別の駒として読まれたまま盤上に居座り続ける。
const cellSize = { width: fromInitial[0].img.width, height: fromInitial[0].img.height };
const stored = loadTemplates(TEMPLATE_STORE, cellSize);
const templates: Template[] = stored ? mergeTemplates(fromInitial, stored) : fromInitial;
if (stored) {
  const added = templates.length - fromInitial.length;
  console.log(`  保存済みのテンプレートから ${added} 種を追加: ${templates.slice(fromInitial.length).map((t) => `${t.side === 'sente' ? '▲' : '▽'}${t.kind}`).join(' ')}`);
} else {
  console.log(`  保存済みのテンプレートは無し（${TEMPLATE_STORE}）`);
}

const missingKinds = () => ALL_KINDS.filter((k) => !templates.some((t) => t.kind === k));

function dumpPgm(img: GrayImage, path: string) {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, Buffer.from(img.data)]));
}

/**
 * 覚えようとしている絵が、既にあるテンプレートと同じ絵ならこれを超える。
 *
 * 実測: 本物の成駒テンプレートが生駒と持つ相関は `▲と`⇔`▲金` 0.306、
 * `▽と`⇔`▽金` 0.306。一方、誤って `▽全` として覚えた絵は `▽銀` と **0.837** だった
 * （演出で白っぽくなった普通の銀を「成銀」と逆算していた）。**間が広く空いている。**
 *
 * ⚠ **誤ったテンプレートは以降の認識を壊し続ける。** `▽と` を `▽龍` のラベルで
 * 保存していたときは、盤上の本物の `▽と` が龍と読まれて枚数超過になり、
 * `sanity` の却下が 10 → 507 に跳ね上がった。1 枚の間違いが全体を止める。
 */
const LEARN_DUPLICATE_NCC = Number(process.env.KIFU_VISION_LEARN_DUP_NCC ?? 0.6);

function learn(img: GrayImage, row: number, col: number, kind: PieceKind, side: 'sente' | 'gote', at: number) {
  if (templates.some((t) => t.kind === kind && t.side === side)) return;
  const cell = cellImage(img, row, col);

  // 🔴 **ポインタが乗ったマスからテンプレートを起こしてはいけない。**
  // そこに何の駒があるかを絵から決めるのは、ほぼ不可能に近い。逆算が
  // 「1 手として説明が付く」と言っても、それは盤面の論理が通るというだけで、
  // 絵がその駒である保証は無い。実測でも、ポインタが乗った 4d（NCC 0.623）を
  // 「成銀」と逆算して覚えかけ、実際は成らずの銀だった。
  if (hasPointer(cell)) {
    console.log(
      `  ⚠ ${fmt(at)} ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]} として覚えかけたが、` +
        `ポインタが乗ったマスなので見送った`,
    );
    return;
  }

  // 既にある駒と同じ絵なら、それは新しい駒種ではなく読み違え。覚えない。
  const dup = templates
    .map((t) => ({ t, s: ncc(t.img, cell) }))
    .sort((a, b) => b.s - a.s)[0];
  if (dup && dup.s > LEARN_DUPLICATE_NCC) {
    console.log(
      `  ⚠ ${fmt(at)} ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]} として覚えかけたが、` +
        `${dup.t.side === 'sente' ? '▲' : '▽'}${NAMES[dup.t.kind]} と同じ絵（NCC=${dup.s.toFixed(3)}）なので見送った`,
    );
    return;
  }

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
/**
 * 追跡が切れたと見なすまでの連続失敗回数。
 *
 * 一度読み損ねると `current` が古いまま取り残され、以後すべての差分が
 * 「変わりすぎ」になって二度と戻れない。実測では 4:20 で切れたあと
 * 14 分間ずっと too-many-changes が続いた。
 *
 * 切れたら**その時点の読みを新しい起点にして仕切り直す**。棋譜は分断されるが、
 * 分断された各断片はそれぞれ有効なので、後でつなぐか長いものを採る。
 */
const RESET_AFTER = Number(process.env.KIFU_VISION_RESET_AFTER ?? 8);

/** 失敗の中身を何件まで表示するか。既定では冒頭の演出で埋まってしまう。 */
const MAX_DETAIL = Number(process.env.KIFU_VISION_MAX_DETAIL ?? 10);

/** 二分探索で間を埋めにいく上限の時間差（秒）。これより離れていたら諦める。 */
const BRIDGE_MAX_GAP_SEC = Number(process.env.KIFU_VISION_BRIDGE_MAX_GAP ?? 15);

// ⚠ かつては「次の 1 サンプルで NCC 0.85 以上なら成りを読み直す」という
// 一発勝負だった。**一度も発火しなかった。** 実測（6:22 の 4d）では 10 秒以上
// ずっと 0.58〜0.68 で同じ駒に読めていたのに、どの 1 枚も 0.85 に届かない。
// いまは `ReadingHistory` が「同じ読みが続いたこと」を根拠にする。

/** 追跡が続いている間の一続きの手列 */
interface Run {
  steps: Step[];
  startedAt: number;
}
const runs: Run[] = [];
let steps: Step[] = [];
let consecutiveFailures = 0;
let resets = 0;
const failures = new Map<string, number>();
let current: Square[][] | null = null;
/**
 * 盤面だけでなく持ち駒と手番も追う。
 *
 * 盤の 81 マスだけを見ていると、**「持っていない駒を打つ」偽の手を弾けない**。
 * マウスポインタや演出で駒が湧いて見えると差分は「空 → 駒」になり、
 * これはちょうど打ちの形なので、そのまま通ってしまう。
 *
 * ⚠ `state.board` は常に `current` と同じものを指す。片方だけ更新しないこと。
 */
let state: BoardState | null = null;
/** 候補手の second opinion で拾い直せた手 */
let byCandidate = 0;
/** 候補手を当てにいったが決められなかった回数 */
const candidateFailures = new Map<string, number>();

/**
 * 追跡している状態を進める。
 *
 * 手が `applyMove` に通れば持ち駒まで正確に進む。通らなければ盤だけを
 * 引き継ぎ、持ち駒は盤から測り直す（**分からないときは広い方へ倒す**ので、
 * 正しい手が候補から消えることはない）。
 */
function retrack(board: Square[][], move: { usi: string; side: Side } | null): Square[][] {
  if (state && move) {
    try {
      const next = applyMove(state, move.usi);
      state = { board, hand: next.hand, sideToMove: next.sideToMove };
      return board;
    } catch {
      // 持ち駒が足りない等で適用できない。測り直しに落とす。
    }
  }
  const fresh = move ? startFromBoard(board, opposite(move.side)) : startState(board, 'sente');
  // ⚠ `startState` / `startFromBoard` は盤を複製する。**同じ配列を指させ直す**こと。
  // 別物のままだと、後から成りを読み直して `current` を書き換えたときに
  // `state.board` だけ古いまま残り、候補手が過去の盤面から作られる。
  state = { ...fresh, board };
  return board;
}
let samples = 0;
let unchanged = 0;
let vanished = 0;
let insane = 0;
let detailShown = 0;
let carriedUsed = 0;
/**
 * 「移動先が読めなかったので、成ったかどうかを決めきれなかった手」の控え。
 *
 * 移動先の駒は**移動元の駒か、その成駒か**の 2 択しかない。そして盤面の論理では
 * どちらも 1 手として成立してしまうので決められない（`solveUnknowns` が曖昧として
 * 諦めるのはここ）。
 *
 * ただし**駒を動かした瞬間だけポインタがそのマスに乗っている**のであって、
 * 次に読むときには退いていることが多い。人間が「後から見ればポインタは
 * いなくなっているし、この駒は動いていないのだから見直せばよい」と考えるのと
 * 同じことを、次の時点で 1 度だけやる。
 *
 * 次の手が同じマスに来た場合（取り合いなど）は見直せないので諦める。
 */
interface Provisional {
  row: number;
  col: number;
  /** 直したい手が入っている配列とその位置 */
  steps: Step[];
  index: number;
}
/** 確定待ちのマス。読めるようになるまで**何度でも**試みる。 */
const provisional = new Map<string, Provisional>();
const history = new ReadingHistory();
let promotionsFixed = 0;
let overflowSeen = 0;
/** 「駒が消えただけ」に見えたが、行き先が未確定のマスに見つかった手 */
let rescuedVanished = 0;
/** 起点にしようとしたが、未確定のマスが残っていて採れなかった絵 */
let unreadableStart = 0;
let bridgedMoves = 0;
let bridgeTried = 0;
/**
 * 直前に**追跡が合っていた**時刻。二分探索の起点になる。
 *
 * 🔴 かつては「直前に手が繋がった時刻」を使っていた。**これが間違いだった。**
 * 手と手の間隔は 1 秒足らずから 5 分以上までばらつくので、手が指されない時間が
 * 長いだけで起点が古くなり、`BRIDGE_MAX_GAP_SEC` を超えて**二分探索そのものが
 * 呼ばれなくなる**。
 *
 * 実測（13:06〜14:38 の空白）: 最後の手は 13:06、繋がらなくなったのは 14:08。
 * その差 62 秒は上限 15 秒を大きく超えるので探索を諦めていたが、
 * **13:07〜14:07 はずっと「配置が変わらない」＝追跡は合っていた**。
 * 本当に探すべき区間は 14:07〜14:08 のわずか 1 秒だった。
 */
let lastSyncTime: number | null = null;
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
    // 起点は**全マスが読めている絵だけ**から採る。引き継ぐ相手がまだ無いので、
    // 未確定を当てずっぽうで埋めるしかなく、間違えるとその後がすべてずれる。
    const start = settle(recognized.board);
    if (!start) {
      unreadableStart++;
      continue;
    }
    const sane = checkBoard(start);
    if (!sane.ok) {
      insane++;
      if (VERBOSE && insane <= 3) console.log(`  ⚠ ${fmt(t)} 盤面が成立しない: ${sane.problems.slice(0, 3).join(' / ')}`);
      continue;
    }
    current = retrack(start, null);
    console.log(
      `  起点: ${fmt(t)}（盤上の駒 ${pieceCount(start)} 枚` +
        `${handsAreGuessed(state!) ? '・持ち駒は不明なので両者に持たせる' : '・持ち駒も手番も確定'}）`,
    );
    continue;
  }

  // 読みを履歴に積む。**同じマスが何度も続けて同じ駒に読めたら確定**とみなす。
  history.observe(recognized.board);

  // 覆われていて決めきれなかったマスを、読めるようになった時点で確定させる。
  // ⚠ 一発勝負ではなく**毎回試みる**。ポインタは動けば退くが、いつ退くかは
  // 分からないし、退いた 1 枚がたまたまきれいとも限らない。
  for (const [key, watch] of [...provisional]) {
    const c = history.confirmed(watch.row, watch.col);
    if (!c) continue;
    provisional.delete(key);
    const now = c.value;
    if (!now) continue; // 空に読めた＝取られた等。手の側では扱えないので触らない
    if (now.kind === current[watch.row][watch.col]?.kind) continue; // 逆算が当たっていた

    const step = watch.steps[watch.index];
    if (step) {
      const wantsPlus = now.kind.startsWith('+');
      const hasPlus = step.usi.endsWith('+');
      if (wantsPlus !== hasPlus) {
        step.usi = wantsPlus ? `${step.usi}+` : step.usi.slice(0, -1);
        promotionsFixed++;
      }
    }
    // 追跡している盤面も読めた方に合わせる。ここを直さないと、以後ずっと
    // 同じ 1 マスで食い違い続けて仕切り直しになる（実測でこれが最大の断片切れだった）。
    current[watch.row][watch.col] = now;
    if (VERBOSE) {
      console.log(
        `  ↺ ${fmt(t)} ${9 - watch.col}${String.fromCharCode(97 + watch.row)} を確定: ` +
          `${now.side === 'sente' ? '▲' : '▽'}${NAMES[now.kind]}（${c.streak} 回連続で同じ読み）` +
          `${step ? ` → ${fmt(step.time)} の手を ${step.usi} に直した` : ''}`,
      );
    }
  }

  // 読めなかったマス（マウスポインタや演出に覆われた）は、**変わっていないと
  // 仮定して直前の配置を引き継ぐ**。覆われただけなら駒はそこにあり続けている。
  // 誤った駒として読むと差分が壊れるが、引き継げば壊れない。
  //
  // 駒が取られて消えた場合は駒の有無が変わるので、引き継いでも 1 手差分に
  // ならず、下の経路に落ちる。覆われている間に相手の駒に置き換わった場合だけは
  // 見逃しうるが、次に読める時点で辻褄が合わなくなるので取りこぼしに気付ける。
  // 規定より多い駒種は、テンプレートの無い駒（成駒など）が別の駒として
  // 読まれている印。一時的なポインタと違って居座り続けるので、
  // 「読めなかったマス」に加えて引き継ぎの対象にする。
  const scores = recognized.cells.map((r) => r.map((c) => c.score));
  const overflow = overflowCells(recognized.board, scores);
  if (overflow.length > 0) overflowSeen++;
  const pending = [...unknownCells(recognized.board), ...overflow];

  // 未確定のマスを直前の配置で埋める。**覆われただけなら駒はそこにあり続ける。**
  const carried: Square[][] | null =
    pending.length > 0 ? carryUnknowns(recognized.board, overflow, current) : null;

  // 成立するかは引き継いだ版で見る。当てずっぽうの版は偽の駒で崩れていることがあり、
  // それを理由に絵ごと捨てると、実際には読めるはずの手まで落としてしまう。
  const primary: Square[][] = carried ?? settle(recognized.board)!;
  const sane = checkBoard(primary);
  if (!sane.ok) {
    insane++;
    if (VERBOSE && insane <= 3) console.log(`  ⚠ ${fmt(t)} 盤面が成立しない: ${sane.problems.slice(0, 3).join(' / ')}`);
    continue;
  }

  if (boardsEqual(primary, current)) {
    unchanged++;
    // ⭐ **ここが「追跡できていた最後の時刻」。** 手が指されていなくても、
    // 読みが追跡中の盤面と一致しているなら、その時点までは追えている。
    lastSyncTime = t;
    continue;
  }

  // まず引き継いだ版で読む。通らなければ素の読みで試す（成りはこちらでしか出ない）。
  let result = inferMove(current, primary);
  let board: Square[][] = primary;
  let solved = false;
  if (result.move && carried) carriedUsed++;

  // 引き継いだ版で説明が付かないなら、当てずっぽうの版でも試す。
  // 成りは引き継ぐと消えてしまうので、こちらでしか出ない。
  const guessed = fillGuesses(recognized.board, recognized.guesses);
  if (!result.move && carried && !boardsEqual(guessed, current)) {
    const alt = inferMove(current, guessed);
    if (alt.move) {
      result = alt;
      board = guessed;
    }
  }

  if (!result.move && recognized.lowConfidence.length > 0 && recognized.lowConfidence.length <= 2) {
    const unknowns: UnknownCell[] = recognized.lowConfidence.map((c) => ({ row: c.row, col: c.col, inAfter: true }));
    // まだ覚えていない駒種で試す（成駒の学習はこちら）。
    // 駄目なら全駒種で試す。**駒を動かす瞬間、マウスは必ず盤上にある**ので、
    // 移動先がポインタに覆われて読めないことがよくある。その駒は成駒とは限らず
    // 普通の生駒なので、候補を未学習の駒種に絞ったままでは見つからない。
    // 全駒種にすると成りと成らずが両方成立して曖昧になる場合があるが、
    // そのときは solveUnknowns が null を返すので誤って覚えることはない。
    const s =
      solveUnknowns(current, guessed, unknowns, missingKinds()) ??
      solveUnknowns(current, guessed, unknowns);
    if (s) {
      board = guessed.map((r) => r.slice());
      for (const r of s.resolved) {
        board[r.row][r.col] = r.piece;
        learn(img, r.row, r.col, r.piece.kind, r.piece.side, t);
      }
      result = inferMove(current, board);
      solved = true;
    }
  }

  // --- 読みで決まらなければ、ルールの側から当てにいく ---
  //
  // ここまでは「81 マス読む → 差分を 1 手として説明できるか」という向きで、
  // **開いた集合に問いを投げている**。マスごとに「20 種のどれか」を当てるので、
  // 読めないマスが 1 つあると手が決まらない。
  //
  // 合法手はルールで閉じた集合なので、向きを逆にすると詰まりが消える。
  // **未確定のマスは「情報が無い」として飛ばせばよい。**
  //
  // ⭐ 実際にこれで解ける形（16:32 で踏んだ）: 相手が金を打ったのに、
  // `▽全`（成銀）のテンプレートの方が一致してしまった——両者は本当に似ていて、
  // 実測でも 0.73 相関する。だが**打つ手に成駒はあり得ない**ので、候補には
  // `G*8f` しか無い。絵で割り切れないものが、ルールでは 1 つに決まる。
  //
  // ⚠ **`piece-vanished` はここへ回さない。** 駒が消えただけに見える絵は
  // `rescueVanished` の方が専門で、実測でもよく効いている（30 件）。
  // 一般の当てずっぽうを先に走らせて、そちらの領分を奪わないこと。
  if (!result.move && result.failure !== 'piece-vanished' && state) {
    // 引き継ぎに使ったマス（未確定・駒数超過）は「読めていない」として扱う。
    const read = markUnknown(recognized.board, overflow);
    const picked = pickCandidate(state, read, {
      maxConflicts: 1,
      // 仕切り直した直後は手番が分からない。狭めるより広く取る。
      anySide: handsAreGuessed(state),
    });
    if (picked.best) {
      const m = picked.best.move;
      if (steps.length === 0) runs.push({ steps, startedAt: t });
      steps.push({ time: t, usi: m.usi, side: m.side, solved: true });
      current = retrack(picked.best.board, { usi: m.usi, side: m.side });
      lastSyncTime = t;
      consecutiveFailures = 0;
      byCandidate++;
      history.reset(m.to.row, m.to.col);
      if (m.from) history.reset(m.from.row, m.from.col);
      if (VERBOSE) {
        console.log(
          `  ⚖ ${fmt(t)} 合法手から決めた: ${m.usi}` +
            `（食い違い ${picked.best.conflicts}・読みは ${result.failure}）`,
        );
      }
      continue;
    }
    if (picked.failure) {
      candidateFailures.set(picked.failure, (candidateFailures.get(picked.failure) ?? 0) + 1);
    }
  }

  // 駒が消えただけに見える絵。ふつうはスライドの途中なので捨てるが、
  // **移動先が読めていないせいでそう見えている**ことがある。行き先が
  // 未確定のマスの中に一意に決まるなら、それは本当の手。
  if (result.failure === 'piece-vanished') {
    const rescue = rescueVanished(current, primary, recognized.board);
    if (rescue) {
      if (steps.length === 0) runs.push({ steps, startedAt: t });
      steps.push({ time: t, usi: rescue.usi, side: rescue.side, solved: true });
      current = retrack(rescue.board, { usi: rescue.usi, side: rescue.side as Side });
      lastSyncTime = t;
      consecutiveFailures = 0;
      rescuedVanished++;
      history.reset(rescue.to.row, rescue.to.col);
      history.reset(rescue.from.row, rescue.from.col);
      // 移動先は読めていないので、駒種（成ったかどうか）は決まっていない。
      // 読めるようになった時点で確定させる。
      provisional.set(`${rescue.to.row},${rescue.to.col}`, {
        row: rescue.to.row,
        col: rescue.to.col,
        steps,
        index: steps.length - 1,
      });
      if (VERBOSE) {
        console.log(
          `  ✚ ${fmt(t)} 消えた駒の行き先を未確定のマスに見つけた: ${rescue.usi}` +
            `${rescue.promotionUncertain ? '（成りは未確定）' : ''}`,
        );
      }
      continue;
    }
    vanished++;
    continue;
  }

  if (result.move && verifyMove(current, result.move.usi, result.move.side, board)) {
    if (steps.length === 0) runs.push({ steps, startedAt: t });
    steps.push({ time: t, usi: result.move.usi, side: result.move.side, solved });
    current = retrack(board, { usi: result.move.usi, side: result.move.side as Side });
    lastSyncTime = t;
    consecutiveFailures = 0;

    // 手が指されたマスは中身が変わったので、古い読みの連続は捨てる。
    // 残すと「変わる前の駒」で確定してしまう。
    const to = result.move.to;
    const from = result.move.from;
    history.reset(to.row, to.col);
    if (from) history.reset(from.row, from.col);

    // 移動先が読めていなかったなら、**その手はまだ確かめられていない**。
    // 読めるようになるまで持ち越して、後の場面で確定させる。
    if (
      result.move.type === 'move' &&
      from &&
      pending.some((c) => c.row === to.row && c.col === to.col)
    ) {
      provisional.set(`${to.row},${to.col}`, { row: to.row, col: to.col, steps, index: steps.length - 1 });
    }
    continue;
  }

  // 1 手として説明が付かないのは、間に手が入っているから。諦めて仕切り直すと
  // 間の手を丸ごと失うので、二分して中間の局面を探しに行く。
  //
  // ⚠ 二分探索は**追跡が合っていた時刻から近いときに限る**（手が指された時刻ではない。
  // `lastSyncTime` の説明を見ること）。離れているときは数分ぶん追跡が切れており、
  // 間に何十手もあるので二分では届かない。
  //
  // 対象にする失敗は 1 つではない。**2 手を 1 手として読もうとした結果**は、
  // 形によって出方が変わる:
  //   - 3 マス以上動いた   → too-many-changes（例: 香が角を取り、銀が取り返す）
  //   - 2 マスだが動きが変 → illegal-shape（例: 金打ちと銀の移動が重なる）
  //   - 2 マスだが動けない → illegal-move
  if (
    (result.failure === 'too-many-changes' ||
      result.failure === 'illegal-shape' ||
      result.failure === 'illegal-move') &&
    lastSyncTime !== null &&
    t - lastSyncTime <= BRIDGE_MAX_GAP_SEC &&
    current
  ) {
    bridgeTried++;
    const base = current;
    const readAtTime = (tt: number): Square[][] | null => {
      const im = grabBoard(tt);
      const r = recognizeBoard(im, templates);
      const c = resolveWith(r.board, base);
      return checkBoard(c).ok ? c : null;
    };
    const bridged = bridgeGap(lastSyncTime, t, current, board, t, readAtTime, {
      minGapSec: Math.max(0.1, stepSec / 4),
    });
    if (bridged && bridged.length > 0) {
      if (steps.length === 0) runs.push({ steps, startedAt: bridged[0].time });
      for (const b of bridged) {
        steps.push({ time: b.time, usi: b.move.usi, side: b.move.side, solved: false });
      }
      bridgedMoves += bridged.length;
      const last = bridged.at(-1)!;
      current = retrack(last.board, { usi: last.move.usi, side: last.move.side as Side });
      lastSyncTime = t;
      consecutiveFailures = 0;
      continue;
    }
  }

  const why = result.move ? 'verify-failed' : result.failure!;
  failures.set(why, (failures.get(why) ?? 0) + 1);
  if (VERBOSE && detailShown < MAX_DETAIL) {
    detailShown++;
    const diff = boardDiff(current, board);
    console.log(`  ⚠ ${fmt(t)} ${why}（${diff.length} マス）`);
    for (const d of diff.slice(0, 6)) {
      const show = (p: VisionSquare) =>
        isUnknown(p) ? '未確定' : p ? `${p.side === 'sente' ? '▲' : '▽'}${NAMES[p.kind]}` : '空';
      console.log(`      ${9 - d.col}${String.fromCharCode(97 + d.row)}: ${show(d.before)} → ${show(d.after)}`);
    }
  }
  // 読めなかった絵は捨てる。current は据え置き、次の絵と比べ直す。
  // ただし何度も続くなら追跡が切れている。その時点の読みで仕切り直す。
  consecutiveFailures++;
  if (consecutiveFailures >= RESET_AFTER) {
    // 仕切り直し。**持ち駒は分からなくなる**（誰が何を取ったかは追跡の中にしかない）。
    current = retrack(board, null);
    lastSyncTime = t;
    consecutiveFailures = 0;
    resets++;
    steps = [];
  }
}

console.log(`\n# ${samples} 点を ${((Date.now() - started) / 1000).toFixed(1)} 秒で読んだ`);
console.log(`  配置が変わらなかった: ${unchanged}`);
console.log(`  スライド途中で捨てた: ${vanished}`);
if (rescuedVanished > 0) console.log(`  消えた駒の行き先を未確定のマスに見つけた: ${rescuedVanished}`);
console.log(`  読めないマスを引き継いで通った: ${carriedUsed}`);
console.log(`  二分探索を試した回数: ${bridgeTried}（拾い直せた手: ${bridgedMoves}）`);
console.log(`  合法手の候補から決めた手: ${byCandidate}`);
if (candidateFailures.size > 0) {
  console.log(
    `    候補でも決められなかった内訳: ` +
      [...candidateFailures].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '),
  );
}
console.log(`  成りを後から読み直して直した手: ${promotionsFixed}`);
console.log(`  駒数が規定を超えていた絵: ${overflowSeen}`);
console.log(`  盤面が成立せず捨てた: ${insane}`);
// ⚠ これが多いと「追跡を始められない」。起点は全マスが読めている絵しか採れないが、
// ポインタは常に盤上のどこかにいるので、思ったより候補が少ない。
if (unreadableStart > 0) console.log(`  起点にできなかった絵（未確定のマスが残る）: ${unreadableStart}`);
const allSteps = runs.flatMap((r) => r.steps);
console.log(`  読めた手: ${allSteps.length}（${runs.length} 本の断片に分かれた・仕切り直し ${resets} 回）`);
if (failures.size > 0) {
  console.log('  読めなかった変化:');
  for (const [f, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`    ${f}: ${n}`);
}

const sorted = [...runs].sort((a, b) => b.steps.length - a.steps.length);
console.log(`\n# 復元した断片（長い順に上位 5 本）`);
for (const r of sorted.slice(0, 5)) {
  let alt = 0;
  for (let i = 1; i < r.steps.length; i++) if (r.steps[i].side !== r.steps[i - 1].side) alt++;
  const ratio = r.steps.length > 1 ? (alt / (r.steps.length - 1)).toFixed(2) : '-';
  console.log(`\n  ${fmt(r.startedAt)}〜${fmt(r.steps.at(-1)!.time)}  ${r.steps.length} 手  手番の交互率 ${ratio}`);
  console.log(`    ${r.steps.map((s) => `${s.usi}${s.solved ? '*' : ''}`).join(' ')}`);
}

let alternations = 0;
let pairs = 0;
for (const r of runs) {
  for (let i = 1; i < r.steps.length; i++) {
    pairs++;
    if (r.steps[i].side !== r.steps[i - 1].side) alternations++;
  }
}
console.log(`\n# 手番が交互になった箇所: ${alternations} / ${pairs}`);
console.log('  （断片の中では交互になっているはず。低いなら手を飛ばしている）');

// 断片を書き出す。まだ 1 局を通せていないので、つながった単位で残しておく。
// 走査中に覚えた駒があれば残す。次回以降は最初から使える。
try {
  const learned = templates.filter((t) => t.samples === 1 && t.kind.startsWith('+'));
  if (learned.length > 0) {
    // 保存し直すときは**保存されたままの寸法で読む**。照合用に引き伸ばした絵を
    // 書き戻すと、走査のたびに補間が積み重なって元の絵が甘くなっていく。
    const before = loadTemplates(TEMPLATE_STORE) ?? [];
    const merged = mergeTemplates(before, learned);
    if (merged.length > before.length) {
      saveTemplates(merged, TEMPLATE_STORE);
      console.log(`\n# 覚えた駒を保存: ${merged.length - before.length} 種 → ${TEMPLATE_STORE}`);
    }
  }
} catch (e) {
  console.log(`\n# テンプレートの保存に失敗: ${(e as Error).message}`);
}

if (runs.length > 0) {
  const outPath = `${OUT_DIR}/${basename(video).replace(/\.[^.]+$/, '')}-${Math.round(fromSec)}-${Math.round(toSec)}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  const payload = {
    source: basename(video),
    range: { fromSec, toSec, stepSec },
    runs: runs
      .filter((r) => r.steps.length > 0)
      .map((r) => {
        let alt = 0;
        for (let i = 1; i < r.steps.length; i++) if (r.steps[i].side !== r.steps[i - 1].side) alt++;
        return {
          startedAt: r.startedAt,
          endedAt: r.steps.at(-1)!.time,
          moveCount: r.steps.length,
          // 手番が交互になっているか。1 でなければどこかで手を取りこぼしている。
          alternationRatio: r.steps.length > 1 ? alt / (r.steps.length - 1) : null,
          usi: r.steps.map((x) => x.usi),
          moves: r.steps.map((x) => ({ time: x.time, usi: x.usi, side: x.side, inferredKind: x.solved })),
        };
      }),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n# 書き出した: ${outPath}`);
}
