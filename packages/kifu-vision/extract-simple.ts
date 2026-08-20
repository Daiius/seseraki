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
import {
  grabFrame, grabFrameYuv, yuvGray, cropYuv, crop, openFrameStream, probeFrameRate,
  type GrayImage, type YuvImage,
} from './src/frame.ts';
import { occupancyDistance, INITIAL_OCCUPANCY, occupancy, hasPointer, presence } from './src/occupancy.ts';
import { findSegments } from './src/segments.ts';
import { extractTemplates, cellImage, cellImageForSide, ncc, type Template } from './src/template.ts';
import { recognizeBoard, boardsEqual, boardDiff, carryUnknowns } from './src/recognize.ts';
import { settle, fillGuesses, unknownCells, markUnknown, isUnknown, asHoles, type VisionSquare } from './src/uncertain.ts';
import { inferMove, verifyMove, opposite, toUsiSquare, type InferFailure } from './src/moves.ts';
import { pickCandidate, pickCandidatePair, type PairPickResult } from './src/candidate.ts';
import { completeIfInitial, startFromBoard, handsAreGuessed, canPlay, handsMatchBoard } from './src/tracking.ts';
import { solveUnknowns, type UnknownCell } from './src/solve.ts';
import { findUndroppableDrop, readAsDroppable } from './src/droppable.ts';
import { loadTemplates, saveTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames, calibrateGeometry, isCalibrationTrustworthy } from './src/calibrate.ts';
import { ReadingHistory } from './src/confirm.ts';
import { ClockTimeline, brightSideYuv, screenSideOf, rereadTimes } from './src/clock.ts';
import { canPromote, canMove } from './src/legality.ts';
import { rescueVanished } from './src/vanished.ts';
import { checkBoard, pieceCount, overflowCells, sameSideKindCells } from './src/sanity.ts';
import { replayGame, describeProblem } from './src/replay.ts';
import { isFlipped, orient, flipSide } from './src/orientation.ts';
import { applyMove, createInitialState, type BoardState, type PieceKind, type Side, type Square } from 'shared';

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
// ⚠ **盤が写っていない絵は落ちるので、少なめに撒くと標本が足りなくなる。**
// 実測: 全編（0〜30:33）を 1 回で走査したとき、5 点のうち 2 点が感想戦に当たって
// 3 点しか使えず、ずれの中央値が (0.38, 0.88) から (0.50, 1.00) にぶれた。
// マスの切り出しが一様にずれると、いちばん読みにくいマスから順に読めなくなる
// （2 局目の手番の交互率 0.99 → 0.96）。**等間隔に広く撒く。**
const CAL_POINTS = Number(process.env.KIFU_VISION_CAL_POINTS ?? 9);
const calSeconds = Array.from(
  { length: CAL_POINTS },
  (_, i) => fromSec + 1 + ((toSec - fromSec - 2) * i) / (CAL_POINTS - 1),
)
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
//
// ⚠ 既定は**全編**を走査する（較正込みで約 42 秒。ここは支配的ではない）。
// `KIFU_VISION_SCAN_SEC` で頭から何秒だけ見るかを絞れる（調査用）。
// **絞ると初期局面を取り逃すことがある**ので、数値を測るときは既定のまま使う。
const scanSec = Number(process.env.KIFU_VISION_SCAN_SEC ?? 0);
console.log(
  scanSec > 0
    ? `# 先頭 ${scanSec} 秒を 1fps で走査して初期局面を探す（調査用に短縮）`
    : '# 全編を 1fps で走査して初期局面を探す',
);
const coarse = await findSegments(video, geo, 1, 4, scanSec > 0 ? { durationSec: scanSec } : undefined);
const initials = coarse.filter((s) => occupancyDistance(s.occupancy, INITIAL_OCCUPANCY) === 0);
console.log(`  初期局面: ${initials.map((s) => `${fmt(s.representativeTime)}(${s.length}f)`).join(', ') || 'なし'}`);
if (initials.length === 0) {
  console.error('初期局面が見つからないためテンプレートを作れません');
  process.exit(1);
}
const templateSeg = initials.reduce((a, b) => (b.length > a.length ? b : a));
const fromInitial = extractTemplates(grabBoard(templateSeg.representativeTime));
console.log(`  ${fmt(templateSeg.representativeTime)} から ${fromInitial.length} 種を抽出（生駒のみ）`);

// 🔒 **保存済みを正典にする。動画から起こしたものは、保存済みに無い駒種を補うだけ。**
//
// 初期局面のフレームには**対局開始の演出が乗っていることがある**（キャラクターの絵と
// 光の帯）。2 本目の 0:02 がまさにそれで、演出の下にあった角と飛が濁り、
// **同じ駒どうしで NCC 0.512** までしか合わなかった。その結果、盤上の本物の角は
// どこにあっても 0.44 前後になり、駒があると分かっているマスが未確定のまま残って、
// 指した手がそのまま棋譜から落ちた（先手の `B*4g` ほか 4 件）。
//
// ⚠ **「良いフレームを選ぶ」では閉じない。** どれが良いかは演出の出方次第で、
// 動画ごとに当たり外れが出る。**駒の絵は動画に依存しない資産**なので、
// 一度きれいに採って持っておけばよい（`extract-handoff-templates.ts`）。
// 駒のデザインが変わったら採り直す——そのときだけ人の手が要る。
const cellSize = { width: fromInitial[0].img.width, height: fromInitial[0].img.height };
const stored = loadTemplates(TEMPLATE_STORE, cellSize);
const templates: Template[] = stored ? mergeTemplates(stored, fromInitial) : fromInitial;
if (stored) {
  const filled = templates.slice(stored.length);
  console.log(`  保存済みのテンプレート ${stored.length} 種を使う: ${stored.map((t) => `${t.side === 'sente' ? '▲' : '▽'}${t.kind}`).join(' ')}`);
  console.log(
    filled.length === 0
      ? '  動画から起こした分は使わない（保存済みで足りている）'
      : `  保存済みに無い ${filled.length} 種だけ動画から補う: ${filled.map((t) => `${t.side === 'sente' ? '▲' : '▽'}${t.kind}`).join(' ')}`,
  );
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

/**
 * この走査で新しく覚えた駒だけを持つ。
 *
 * ⚠ **`templates` から拾い直してはいけない。** 保存済みのテンプレートは照合用に
 * 引き伸ばして読み込まれているので、そこから選んで書き戻すと、走査のたびに
 * 補間が積み重なって元の絵が甘くなる。`samples === 1` は「覚えたもの」の代用として
 * 不正確でもある（保存済みにも 1 マスからしか採れない駒がある）。
 */
const learnedThisRun: Template[] = [];

function learn(img: GrayImage, row: number, col: number, kind: PieceKind, side: 'sente' | 'gote', at: number) {
  if (templates.some((t) => t.kind === kind && t.side === side)) return;
  const cell = cellImageForSide(img, row, col, side);

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
  learnedThisRun.push({ kind, side, samples: 1, img: cell });
  dumpPgm(cell, `${LEARN_DIR}/${side}-${kind.replace('+', 'p')}-at${Math.round(at)}s.pgm`);
  console.log(`  ★ ${fmt(at)} 新しい駒を覚えた: ${side === 'sente' ? '▲' : '▽'}${NAMES[kind]}`);
}

// --- 一定間隔で読む ---
console.log(`\n# ${fmt(fromSec)}〜${fmt(toSec)} を ${stepSec} 秒間隔で読む`);
interface Step {
  time: number;
  usi: string;
  side: Side;
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

/**
 * 🔴 **数えるのは粗い刻みの失敗だけ。挿し込んだ絵の失敗は数えない。**
 *
 * 繋がらない区間を細かく読み直すようにしたら、同じ 1 秒間に読む絵が 5 倍に増え、
 * **失敗の回数だけが水増しされて**仕切り直しが早まった。実測: 16:32 の
 * `undroppable`（`▽全` と金の紛れ・追記 64）で、細かく読む前は候補手が間に合って
 * いたのに、読み直しを入れると 8 回に達して 16:09 で断片が切れた。
 *
 * ⚠ **時間で測る形（「合わないまま 4 秒経ったら仕切り直す」）は試して悪化した。**
 * 仕切り直しが遅れる分だけ追跡がずれたまま留まり、**その間ずっと毎サンプルが
 * 読み直しを起こして空回りする**（追加で読んだ絵 135 → 1236、2 局目の最長断片
 * 51 → 35 手）。**早く諦めて起点を取り直す方が結果が良い。**
 */
const fineTimes = new Set<number>();

/** 失敗の中身を何件まで表示するか。既定では冒頭の演出で埋まってしまう。 */
const MAX_DETAIL = Number(process.env.KIFU_VISION_MAX_DETAIL ?? 10);

/**
 * これだけのマスが**一斉に空になったら**、演出が盤を覆っている絵とみなす。
 *
 * 将棋の手は必ず移動先を埋めるので、2 マス以上が「空になっただけ」は手ではない。
 * 3 にしているのは、スライド途中で移動元と移動先の両方が一瞬読めなくなる形が
 * 2 マスまでありうるため（そちらは `piece-vanished` と候補手の側で拾う）。
 */
const COVERED_CELLS = Number(process.env.KIFU_VISION_COVERED_CELLS ?? 3);

/**
 * 繋がらなかった区間を読み直すときの細かい刻み（秒）。
 *
 * ⭐ 実測（追記 73）: 0:02〜0:40 を 0.5 秒で読むと 22 手、**0.1 秒なら 29 手**。
 * 序盤は 1 秒に 1 手以上進むので、0.5 秒では 1 サンプルに 2〜3 手が入る。
 * 拾えた 6 手（`4h4g` `4g5f` `5c5d` `2h4h` `4f4e` `5d5e`）は全部この区間にある。
 */
const FINE_STEP = Number(process.env.KIFU_VISION_FINE_STEP ?? 0.1);

/**
 * 細かく読み直しにいく上限の時間差（秒）。これより離れていたら諦める。
 *
 * 離れているときは数分ぶん追跡が切れていて間に何十手もあるので、刻みを細かく
 * しても届かない。上限まで詰めても挿入は `REFINE_MAX_GAP / FINE_STEP` 枚に収まる。
 */
const REFINE_MAX_GAP = Number(process.env.KIFU_VISION_REFINE_MAX_GAP ?? 3);

// ⚠ かつては「次の 1 サンプルで NCC 0.85 以上なら成りを読み直す」という
// 一発勝負だった。**一度も発火しなかった。** 実測（6:22 の 4d）では 10 秒以上
// ずっと 0.58〜0.68 で同じ駒に読めていたのに、どの 1 枚も 0.85 に届かない。
// いまは `ReadingHistory` が「同じ読みが続いたこと」を根拠にする。

/** 追跡が続いている間の一続きの手列 */
interface Run {
  steps: Step[];
  startedAt: number;
  /** 何局目か（0 始まり） */
  game: number;
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
/** 手番の交互が破れたので、間に相手の手を 1 手挿した回数 */
let insertedMoves = 0;
/** 手番の交互が破れたが、間の手を決められなかった回数（穴として残る） */
let unresolvedGaps = 0;
/** 盤面の論理で 2 手に分解して拾えた手 */
let pairedMoves = 0;
/**
 * 追跡している持ち駒を信じてよいか。
 *
 * 🔴 **「正確な持ち駒」は簡単に幻になる。** `shared` の `applyMove` は検証しないので、
 * 一度でも誤った手を通すと持ち駒は静かにずれ、以後も「正確」を騙り続ける。
 * 実測では、持ち駒を根拠に打ちを断る仕組みを入れたら **38 回**発火し、
 * 断片が 4 本から 7 本に増えて最長も 73 手から 39 手へ落ちた——
 * 本当に指された打ちまで落としていた。
 *
 * ⭐ **信じてよいのは、初期局面から一度も仕切り直さずに来た区間だけ。**
 * 仕切り直し・2 手分解・盤からの測り直しが挟まったら、そこで信用を捨てる。
 */
let handsTrusted = false;
/**
 * 同じ打ちを何回断ったら、持ち駒の側を疑うか。
 *
 * 0.5 秒刻みなので 3 回 ≒ 1.5 秒。ポインタや演出が作る偽の駒が、同じマスに
 * **同じ駒種で** 1.5 秒居座ることは考えにくい（ポインタは動くし、`verifyMove`
 * も通らないといけない）。逆に本当に指された打ちは、そこにあり続ける。
 */
const UNHELD_DROP_PATIENCE = Number(process.env.KIFU_VISION_UNHELD_PATIENCE ?? 3);
/**
 * 直前に断った打ちと、それを断った回数。
 *
 * ⚠ **`let ... | null` で持たない。** 代入が `null` ばかりだと TypeScript は
 * 型を `null` に絞り、`refusedDrop?.usi` が `never` へのアクセスになって
 * 通らなくなる（このファイルは `state` で同じ形を一度踏んでいる）。
 * 中身を書き換える `const` の器にしておけば絞り込みが起きない。
 */
const refusedDrop = { usi: '', count: 0 };

/**
 * 追跡している状態を進める。
 *
 * 手が `applyMove` に通れば持ち駒まで正確に進む。通らなければ盤だけを
 * 引き継ぎ、持ち駒は盤から測り直す（**分からないときは広い方へ倒す**ので、
 * 正しい手が候補から消えることはない）。
 */
/**
 * 追跡している状態を、新しい盤面へ進める。
 *
 * 手が `applyMove` に通れば持ち駒まで正確に進む。通らなければ盤だけを
 * 引き継ぎ、持ち駒は盤から測り直す（**分からないときは広い方へ倒す**ので、
 * 正しい手が候補から消えることはない）。
 *
 * ⚠ **副作用を持たせない。** かつてこの関数の中で `state` を書き換えていたが、
 * そうすると**モジュール側に直接の代入が 1 つも無くなり**、TypeScript は
 * 初期値の `null` のままと見なして以後の `state` を `never` に絞ってしまう。
 * 返り値を呼び出し側で代入する。
 */
function nextState(
  prev: BoardState | null,
  board: Square[][],
  move: { usi: string; side: Side } | null,
): BoardState {
  if (prev && move) {
    // 🔴 **`applyMove` は `state.sideToMove` を見て持ち駒を増やす**（動いた駒の色ではない）。
    // 追跡している手番は手を 1 つ取りこぼすだけで裏返るので、そのまま渡すと
    // **取った駒が逆の持ち主の手に入り続ける**。合計は合ったままなので
    // `handsMatchBoard` にも映らない。
    //
    // 実測（1 局目）: 断片の 1 手目が `3c3d`（後手）なのに手番は先手のまま始まり、
    // 以降ずっと持ち主が入れ替わっていた。10:38 の `B*4a` は**本当に指された手**
    // なのに「先手は角を持っていない」として断られ、そこで断片が切れていた。
    //
    // ⭐ **指した側は駒の色から分かっている。** 数え上げでずれる手番より、
    // そちらの方がはるかに信用できる。
    const next = applyMove({ ...prev, sideToMove: move.side }, move.usi);
    // ⚠ `applyMove` は検証しないので、持ち駒が壊れていないかは呼び出し側が見る。
    const advanced: BoardState = { board, hand: next.hand, sideToMove: next.sideToMove };
    // 🔴 **盤と持ち駒が食い違ったら、そこで信用を捨てる。** 覆われたマスの中で
    // 手を取りこぼしても仕切り直しは起きないので、「初期局面から仕切り直して
    // いない」だけでは持ち駒の正しさを保証できない。実測（1 局目 10:38 /
    // 2 局目 23:47）では、どちらも**本当に指された角打ち**を
    // 「持っていない駒」として断り、そこで断片が切れていた。
    if (handsTrusted && !handsMatchBoard(advanced)) {
      handsTrusted = false;
      if (VERBOSE) console.log(`  ⚠ 持ち駒の追跡が盤と食い違った。以後は持ち駒を信じない`);
    }
    return advanced;
  }
  handsTrusted = false;
  if (!move) {
    // ⭐ 起点なら、読めなかった穴を初期配置で埋められることがある。
    // 起点で 1 マス読めなかっただけで持ち駒が「不明」になり、偽の打ちが
    // 通っていた（1 局目の 1 手目が `P*1c` になっていた）。
    const completed = completeIfInitial(board);
    if (completed) {
      // ⭐ ここだけが持ち駒を**本当に**知っている場所。初期局面なら両者とも空。
      handsTrusted = true;
      return { ...createInitialState(), board: completed };
    }
  }
  // ⚠ `startFromBoard` は盤を複製する。**同じ配列を指させ直す**こと。
  // 別物のままだと、後から成りを読み直して `current` を書き換えたときに
  // `state.board` だけ古いまま残り、候補手が過去の盤面から作られる。
  return { ...startFromBoard(board, move ? opposite(move.side) : 'sente'), board };
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
  /**
   * その手を指す直前の状態。
   *
   * 🔒 **行き先が「空」と確定したら、その手は無かったことにする**ための巻き戻し先。
   * `nextState` は毎回新しい state を作り、盤の配列も差し替わるので、
   * ここに持っておいた state が後から書き換わることはない。
   */
  before: BoardState | null;
}
/**
 * その USI の手が「成り」になり得るか。打ちは成れず、移動は敵陣に掛かるときだけ成れる。
 * 座標は `toUsiSquare` の逆（col 0 が 9 筋、row 0 が一段目）。
 */
function promotionIsPossible(usi: string, side: Side): boolean {
  if (usi[1] === '*') return false; // 打ちは成れない
  const at = (i: number) => ({ col: 9 - Number(usi[i]), row: usi.charCodeAt(i + 1) - 97 });
  return canPromote(at(0), at(2), side);
}

/**
 * 「打ち」と読めた手について、**引き継いだマスの中に出発点になりうる駒**を探す。
 *
 * 🔴 実測（3 本目 11:47・追記 154）: 先手の駒が 4a → 4b へ 1 つ下がっただけの手を
 * **「4b への打ち」と読んだ**。移動元の 4a が未確定で `current` から引き継がれており、
 * 差分が「埋まったマスが 1 つ」＝打ちの形になったため。
 * その結果**追跡盤面に駒が取り残され**、後にカーソルを追う幻の駒を生んだ。
 *
 * ⭐ **絵を一切見ずに、盤の論理だけで疑える。** `rescueVanished` の鏡像で、
 * あちらは「消えた・行き先が未確定」、こちらは「増えた・出発点が未確定」。
 */
function carriedOriginsForDrop(
  board: Square[][],
  to: { row: number; col: number },
  kind: PieceKind,
  side: Side,
  pending: { row: number; col: number }[],
): { row: number; col: number }[] {
  const found: { row: number; col: number }[] = [];
  for (const p of pending) {
    const piece = board[p.row][p.col];
    if (!piece || piece.side !== side) continue;
    // 打った駒と同じ駒がそこから来られるか。成って着地した場合も同じ駒である。
    if (piece.kind !== kind && `+${piece.kind}` !== kind) continue;
    if (!canMove(board, p, to, piece.kind, piece.side)) continue;
    found.push({ row: p.row, col: p.col });
  }
  return found;
}

/**
 * 「打ち」と読めたが、引き継いだマスに出発点の候補が 1 つあった手。
 *
 * 🔒 **打った瞬間には決められない。** 引き継ぎマスは「駒があるが読めない」だけで、
 * **本物の打ち（駒が居座っている）と移動の読み違い（駒はもう無い）が区別できない**。
 * 実測（追記 156）でも 3 件中 2 件は本物の打ちだった。
 *
 * ⭐ **見分ける材料は後から来る。** 出発点のマスが読めるようになった時点で:
 *
 * - **駒のまま確定** → 本物の打ちだった。何もしない
 * - **空と確定** → 実は移動だった → 打ちを移動に書き換え、持ち駒を戻す
 *
 * ⚠ 打ちと移動は**同じ 1 手**なので、後ろに手が積まれていても書き換えられる
 * （手数も後続の手も変わらない）。取り消し（③）より安全に効く。
 */
interface WatchedDrop {
  /** 見張るマス（出発点の候補） */
  row: number;
  col: number;
  /** 打ったマス */
  to: { row: number; col: number };
  kind: PieceKind;
  side: Side;
  steps: Step[];
  index: number;
}
const watchedDrops = new Map<string, WatchedDrop>();

/**
 * 手番が飛んだので**推測で挿し込んだ**打ち。行き先が「空」と確定したら取り消す。
 *
 * ⚠ ②（`watchedDrops`）と違い、**断片の途中から 1 手を抜く**ことになる
 * （挿し込みは 2 手のうちの 1 手目で、2 手目は読めた本物の手）。
 * 抜いた後は、同じ `steps` を指している他の見張りの位置をずらす必要がある。
 */
interface InsertedDrop {
  row: number;
  col: number;
  kind: PieceKind;
  side: Side;
  steps: Step[];
  index: number;
}
const insertedDrops = new Map<string, InsertedDrop>();

/** 確定待ちのマス。読めるようになるまで**何度でも**試みる。 */
const provisional = new Map<string, Provisional>();
const history = new ReadingHistory();
let promotionsFixed = 0;
/** 後から成りに直そうとしたが、敵陣に掛かっていないので断った読み */
let promotionsRejected = 0;
let overflowSeen = 0;
/** 「駒が消えただけ」に見えたが、行き先が未確定のマスに見つかった手 */
let rescuedVanished = 0;
/** 行き先が「空」と確定したので取り消した手（幻の駒・追記 152〜154） */
let phantomsUndone = 0;
/** 📏 打ちと読めたが、引き継いだマスに出発点の候補があった手（測定のみ） */
let dropsWithCarriedOrigin = 0;
/** 📏 うち候補が 1 つだけ＝移動として一意に決まるもの（見張る対象） */
let dropsWithSingleCarriedOrigin = 0;
/** 出発点が空と確定したので、打ち → 移動に書き換えた手 */
let dropsRewritten = 0;
/** 推測で挿し込んだ打ちが誤りと分かって取り消した数 */
let insertionsUndone = 0;
/** 滑りの経由地を独立した 1 手と読んでいて、後から 1 手に併合した数 */
let transitsMerged = 0;
/** 📏 駒種まで読めたマスのうち、`presence` が `piece` と言ったもの（測定のみ） */
let piecesOnSolidCells = 0;
/** 📏 同じく、`presence` が `piece` と言わない薄いマスに駒種を出したもの（測定のみ） */
let piecesOnThinCells = 0;
/** 📏 薄いマスへの駒種出しのうち、追跡盤面が既に同じ駒と思っていた「確認」（測定のみ） */
let thinConfirms = 0;
/** 📏 同じく「新出」（追跡は空か別駒）。ここが分かれ目（追記 164） */
let thinNews = 0;
/** 📏 新出のうち、後のサンプルで `presence` が `piece` と言った＝居座った（本物の形） */
let thinNewPersisted = 0;
/** 📏 新出のうち、後のサンプルで `presence` が `empty` と言った＝消えた（スライド経由地の形） */
let thinNewVanished = 0;
/** 📏 新出のうち、薄いまま追い切れなかった（数サンプル待っても piece とも empty とも言わない） */
let thinNewUnresolved = 0;
/** 薄いマスに新出した駒の見張り。key は `${r},${c}` */
const watchedThinNews = new Map<string, { time: number; label: string; age: number }>();
/** 📏 追跡盤面が空と思うマスに駒が現れ、**次の絵で消えた**（測定のみ） */
let transientFills = 0;
/** 📏 同じく現れて、**次の絵でも居座った**（測定のみ） */
let persistentFills = 0;
let prevFilled = new Set<string>();
/** 起点にしようとしたが、未確定のマスが残っていて採れなかった絵 */
let unreadableStart = 0;
/** 演出に覆われたとみて読まずに捨てた絵 */
let covered = 0;
/** 細かく読み直しにいった区間の数 */
/**
 * 打てない駒として読めたのを、打てる駒に限って読み直せた回数。
 *
 * 実測（1 局目 16:32）: `▽全`（成銀）と読まれた 8f を `▽金` に読み直して
 * `G*8f` が通るようになった。ここが 27 秒ぶんの断片切れの原因だった。
 */
/** 何局目を読んでいるか（0 始まり）。盤が初期局面に戻ったら次の局へ移る。 */
let gameIndex = 0;
/** これだけ手が読めた後でなければ、初期局面に戻っても「新しい対局」と見なさない。 */
const MIN_MOVES_BEFORE_NEW_GAME = Number(process.env.KIFU_VISION_MIN_MOVES_NEW_GAME ?? 4);
/** 対局中の盤が写っていないので読まなかった絵 */
let offBoard = 0;

// ─────────────────────────────────────────────────────────────────────
// 時計の手番指標（盤と独立の拘束・追記 169〜170）
//
// 王手の演出は盤を覆うが、時計は画面の上下の帯にいて演出の外にある。
// 毎サンプル「どちらの時計が光っているか」を記録しておき、
//   ・追跡が切れた長い窓では、手番の**反転時刻**を狙って読み直す
//     （一様な細かい読み直しは REFINE_MAX_GAP を超える窓に届かない）
//   ・手番の交互が破れて手を**推測で挿し込む**前に、時計に「間に本当に
//     1 手あったか」を聞く（無ければ挿し込まない・あれば反転時刻を刻む）
//   ・2 手分解の説明が時計の手数と食い違えば退け、多ければ**正直な穴**として残す
//
// 🔒 時計が読めない素材ではタイムラインが何も主張しないので従来挙動と同じ。
// KIFU_VISION_CLOCK=0 で機構ごと無効化できる（A/B 用）。
// ─────────────────────────────────────────────────────────────────────
const CLOCK_ENABLED = process.env.KIFU_VISION_CLOCK !== '0';
const clock = new ClockTimeline();
/** 時計を見たサンプル数と、手番が割れたサンプル数 */
let clockSamples = 0;
let clockDecided = 0;
/** 反転時刻を狙った読み直し（窓の数と追加で読んだ絵） */
let clockRereadWindows = 0;
let clockRereadSamples = 0;
/** 時計が「間に手は無い」と言ったので見送った挿し込み */
let clockVetoedInsertions = 0;
/** 時計が裏付けた（反転 1 回・側も一致）挿し込み */
let clockConfirmedInsertions = 0;
/** 時計と手数が合わないので退けた 2 手分解 */
let clockVetoedPairs = 0;
/** 一度狙って読み直した反転時刻（同じ場所を何度も掘らない） */
const clockRefinedFlips = new Set<number>();
/** 時計は k 手と言うのに n 手しか説明できなかった窓（正直な穴の記録） */
const clockGaps: { game: number; from: number; to: number; clockMoves: number; recordedMoves: number }[] = [];
const flipKey = (t: number) => Math.round(t * 2) / 2;
let undroppableReread = 0;
/** 同じ側の別の駒に化けて見えた絵（起こりえないので読み違い） */
let stuckKinds = 0;
let refinedWindows = 0;
/** そのために追加で読んだ絵 */
let refinedSamples = 0;
/**
 * 直前に**追跡が合っていた**時刻。細かく読み直すときの起点になる。
 *
 * 🔴 かつては「直前に手が繋がった時刻」を使っていた。**これが間違いだった。**
 * 手と手の間隔は 1 秒足らずから 5 分以上までばらつくので、手が指されない時間が
 * 長いだけで起点が古くなり、`REFINE_MAX_GAP` を超えて**読み直しそのものが
 * 呼ばれなくなる**。
 *
 * 実測（13:06〜14:38 の空白）: 最後の手は 13:06、繋がらなくなったのは 14:08。
 * その差 62 秒は上限を大きく超えるので諦めていたが、
 * **13:07〜14:07 はずっと「配置が変わらない」＝追跡は合っていた**。
 * 本当に探すべき区間は 14:07〜14:08 のわずか 1 秒だった。
 */
let lastSyncTime: number | null = null;
const started = Date.now();

/**
 * 読む時刻の待ち行列。
 *
 * ⭐ **固定刻みの `for` ではなく待ち行列にしてあるのは、繋がらなかった区間に
 * 細かい時刻を挿し込めるようにするため。** 挿し込んだ時刻は同じループ本体で
 * 処理されるので、**本線が持つ救済（`carryUnknowns` / `rescueVanished` /
 * 候補手）がそのまま効く**。かつての二分探索（`bridgeGap`）はこれを持たず、
 * 「両端が完全に読めて `inferMove` で説明が付く」ことを求めていたので、
 * 2 局で 70 回試して 1 手も拾えなかった（追記 74）。
 */
const queue: number[] = [];
for (let t = fromSec; t <= toSec; t += stepSec) queue.push(Number(t.toFixed(3)));
/** 一度細かく読み直した時刻。同じ区間を何度も掘らない。 */
const refined = new Set<number>();

// --- 絵の取り方: 格子の時刻は 1 パスで流し、挿し込みだけ 1 枚ずつ取る ---
//
// 🔴 **1 枚ごとに ffmpeg を起動するのが走査時間の 62% だった**（実測 143.6ms × 3703 枚
// ＝ 534 秒）。デコード自体は全編 40 秒なので、**起動と探索の費用を何千回も
// 払っていた**ことになる。
//
// ⭐ **挿し込みの時刻は必ず格子から外れる。** 0.1 秒刻みのうち格子に載る時刻は
// 既に待ち行列にあり `queued` で除かれるので、**格子＝流れ / それ以外＝1 枚取り**と
// きれいに分けられる。流れは引き取り式（`next()`）なので、挿し込みの間は止まる。
//
// 🔒 **絵が 1 画素でも変われば読みが変わる。**（追記 125 で色を足したときに踏んだ）
// `fps=N` フィルタは `-ss` と**別のフレームを返す**ので使わない（`openFrameStream` の説明）。
// フレーム番号で選ぶ形にして、2 本 × 90 枚で画素単位の完全一致を確認済み。
const rate = probeFrameRate(video);
const framesPerStep = (stepSec * rate.num) / rate.den;
const stride = Math.round(framesPerStep);
/** 刻みがフレームの整数倍でないなら流せない（格子の時刻が実フレームに載らない）。 */
const canStream = stride >= 1 && Math.abs(framesPerStep - stride) < 1e-9;
let stream = canStream
  ? openFrameStream(video, geo.frameW, geo.frameH, stride, fromSec > 0 ? { startSec: fromSec } : undefined)
  : null;
console.log(
  canStream
    ? `# ${rate.num}/${rate.den} fps の ${stride} フレームおきを 1 パスで流す（挿し込みだけ 1 枚ずつ取る）`
    : `# 刻み ${stepSec} 秒がフレームの整数倍でないので、1 枚ずつ取る`,
);
/** 流れから何枚目まで受け取ったか。時刻は fromSec + streamIndex * stepSec。 */
let streamIndex = 0;
let streamedFrames = 0;
let seekedFrames = 0;

async function frameAt(t: number): Promise<YuvImage> {
  if (stream) {
    const expected = Number((fromSec + streamIndex * stepSec).toFixed(3));
    if (t === expected) {
      const f = await stream.next();
      if (f) {
        streamIndex++;
        streamedFrames++;
        return f;
      }
      // 流れが尽きた（動画の終端）。以後は 1 枚ずつ取る。
      stream = null;
    }
  }
  seekedFrames++;
  return grabFrameYuv(video, t, geo.frameW, geo.frameH);
}
/** 待ち行列に入れたことのある時刻。同じ絵を二度読まないための控え。 */
const queued = new Set<number>(queue);

for (let qi = 0; qi < queue.length; qi++) {
  const t = queue[qi];
  samples++;

  // --- 対局中の盤が写っていない絵は、そもそも読まない ---
  //
  // 終局後の感想戦（棋譜解析）画面・対局者紹介・広告は、**盤のレイアウトが違う**。
  // 固定座標のまま読むと「壊れた盤面から手が読めた」ことになりかねない。
  //
  // ⭐ 格子のくっきりさで分かれる（`isCalibrationTrustworthy` の実測を再確認した）:
  //
  // | 場面 | 縦, 横 |
  // |---|---|
  // | 対局中（5:00 / 15:00 / 29:40） | (29〜33, 36〜39) |
  // | 感想戦（29:55 以降） | **(3.6〜7.1, 5.4〜15.4)** |
  // | 終局ダイアログ（19:15） | **(15.7, 8.0)** |
  //
  // ⚠ **失敗に数えない。** これは「読めなかった」のではなく「読むべきでない絵」。
  // ⭐ 色付きで取る。**成駒は朱・生駒は黒**で書かれており、照合（グレースケール）が
  // 割り切れない `金`⇔`全` を色が決める（`src/ink.ts`）。ffmpeg の起動が支配的なので、
  // gray を別に取り直すより 1 回の rgb24 から落とす方が安い。
  // ⚠ 流れが返す絵は**次の 1 枚を取るまでの間だけ有効**（内部の buffer を指している）。
  // この反復の中で使い切ること（`crop` / `cropYuv` は複製を返すので持ち越してよい）。
  const colorFrame = await frameAt(t);
  const frame = yuvGray(colorFrame);
  if (!isCalibrationTrustworthy(calibrateGeometry(frame, geo))) {
    offBoard++;
    if (VERBOSE && offBoard <= MAX_DETAIL) console.log(`  ▢ ${fmt(t)} 対局中の盤が写っていないので読まない`);
    continue;
  }
  // 時計の手番指標を毎サンプル記録する（6 窓 ≈ 2.3 万画素の V 計算だけなので安い）。
  // ⚠ 盤が写っている絵に限る（上の較正の門を通った後）。感想戦や広告の帯を
  // 時計と読むと、反転でないものが反転に見える。
  if (CLOCK_ENABLED) {
    const side = brightSideYuv(colorFrame);
    clock.record(t, side);
    clockSamples++;
    if (side) clockDecided++;
  }

  const img = crop(frame, boardRect(geo));
  const recognized = recognizeBoard(img, templates, {
    colorBoard: cropYuv(colorFrame, boardRect(geo)),
  });

  // 📏 測定のみ（判定は変えない）。**「駒があるとすら言えない薄いマス」に駒種の答えを
  // 出していないか**を数える（追記 163）。
  //
  // 🔴 3 本目 26:16.5 でスライド中の飛車が 3f に写り、`presence` は `piece` と言わない
  // （sd が 12〜30 の「覆われていて分からない」帯）のに、認識側は `▽飛` を置いた。
  // それが移動元の誤読になり、1 手ぶんの穴になった。
  //
  // 🔒 **締めてよいかは件数で決まる。** 少なければ安全に締められる。多ければ
  // **その多くは本物の駒が薄く写ったもの**なので、締めると手が落ちる。
  {
    const where = presence(img);

    // 見張り中の「薄いマスに新出した駒」を、後から来た証拠で締める（追記 164）。
    // ⭐ 本物（20:58 の P*3e）は次のサンプルで駒として写り、スライド経由地
    // （26:16.5 の 3f ▽飛）は次のサンプルで空になる——はず。それを数える。
    for (const [key, w] of watchedThinNews) {
      const [r, c] = key.split(',').map(Number);
      const p = where[r][c];
      if (p === 'piece') {
        thinNewPersisted++;
        if (VERBOSE) console.log(`  📏 ${fmt(w.time)} 薄いマスに新出した ${toUsiSquare(r, c)} ${w.label} → 居座った（${fmt(t)}）`);
      } else if (p === 'empty') {
        thinNewVanished++;
        if (VERBOSE) console.log(`  📏 ${fmt(w.time)} 薄いマスに新出した ${toUsiSquare(r, c)} ${w.label} → 消えた（${fmt(t)}）`);
      } else {
        if (++w.age < 6) continue; // まだ薄い。もう少し待つ
        thinNewUnresolved++;
        if (VERBOSE) console.log(`  📏 ${fmt(w.time)} 薄いマスに新出した ${toUsiSquare(r, c)} ${w.label} → 追い切れず`);
      }
      watchedThinNews.delete(key);
    }

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const read = recognized.board[r][c];
        if (read === null || isUnknown(read)) continue;
        if (where[r][c] === 'piece') {
          piecesOnSolidCells++;
          continue;
        }
        piecesOnThinCells++;
        // 内訳（追記 164）: 追跡盤面が既に同じ駒と思っているなら「確認」で、締めても
        // `carryUnknowns` が引き継ぐので無害のはず。追跡が空か別駒なら「新出」で、
        // ここから差分＝手が生まれうる。見張って居座り/消えを数える。
        if (!current) continue; // 追跡が無い区間は分類できない
        const cur = current[r][c];
        if (cur && isUnknown(cur)) continue; // 追跡が未確定なら「確認」とも「新出」とも言えない
        if (cur && cur.kind === read.kind && cur.side === read.side) {
          thinConfirms++;
        } else if (!watchedThinNews.has(`${r},${c}`)) {
          thinNews++;
          const label = `${read.side === 'sente' ? '▲' : '▽'}${read.kind}`;
          watchedThinNews.set(`${r},${c}`, { time: t, label, age: 0 });
        }
      }
    }
  }

  // 📏 測定のみ（判定は変えない）。**追跡盤面が「空」と思っているマスに、絵の側で
  // 駒が現れた**ものを数え、次の絵で消えたか居座ったかを見る。
  //
  // 🔴 3 本目 26:17 の起点はこれだった（追記 160）: 3h が 1 サンプルだけ駒ありに見え、
  // 差分が 3 マスに膨れて、存在しない `P*3h` が発明された。
  // ⚠ 本物の手も最初の 1 サンプルはここに現れる。**消えたか居座ったかで割れるはず。**
  if (current) {
    const nowFilled = new Set<string>();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (!current[r][c] && recognized.board[r][c] !== null) nowFilled.add(`${r},${c}`);
      }
    }
    for (const k of prevFilled) {
      if (!nowFilled.has(k)) transientFills++; // 次の絵で消えた＝手にならなかった
    }
    for (const k of nowFilled) {
      if (prevFilled.has(k)) persistentFills++; // 居座った
    }
    prevFilled = nowFilled;
  } else {
    prevFilled = new Set();
  }

  // --- 盤が初期局面に戻ったら、そこからは別の対局 ---
  //
  // ⭐ 1 本の動画に 2 局入っている。混ぜて 1 つの棋譜にすると、局をまたいだ
  // 「手」が生まれてしまう。**盤が初期局面に戻ることが、対局の切れ目そのもの。**
  //
  // ⚠ **手数を条件に入れる。** `completeIfInitial` は 3 マスまでの穴を許すので、
  // 対局が始まった直後（1〜2 手）は「穴のせいで初期局面に見える」ことがありうる。
  // 実際の対局が 2 手で初期局面へ戻ることは無いので、そこで切る。
  const movesInGame = runs.reduce((n, r) => (r.game === gameIndex ? n + r.steps.length : n), 0);
  if (movesInGame >= MIN_MOVES_BEFORE_NEW_GAME && completeIfInitial(asHoles(recognized.board))) {
    gameIndex++;
    current = null;
    state = null;
    steps = [];
    handsTrusted = false;
    consecutiveFailures = 0;
    lastSyncTime = null;
    history.clear();
    provisional.clear();
    console.log(`\n# ${fmt(t)} 盤が初期局面に戻った → ${gameIndex + 1} 局目として読み直す`);
  }

  // ⚠ ここで `pruneOverflow` を使って偽の駒を削る手も試したが、**逆効果だった**。
  // 「盤面が成立せず捨てた」は 163 → 16 に減るものの、代わりに
  // too-many-changes が 145 件、illegal-shape が 111 件出た。
  // マウスポインタが**本物の駒**に重なるとその駒の一致度も下がるので、
  // 本物の方を削ってしまい、差分が壊れる。読めた手は 7 手で変わらなかった。
  // 中途半端に直すより、成立しない絵はまるごと捨てて次を見る方がよい。

  if (!current) {
    // 起点は**全マスが読めている絵だけ**から採る。引き継ぐ相手がまだ無いので、
    // 未確定を当てずっぽうで埋めるしかなく、間違えるとその後がすべてずれる。
    //
    // ⭐ **ただし初期局面だけは例外。** 穴を除いた残りが平手の初期配置と
    // 一致するなら、穴の中身はルールが知っている。ここを通さないと、
    // 「駒の有無」に未確定を入れたぶんだけ**起点が見つかりにくくなって
    // 逆に悪化する**（ポインタは常に盤上のどこかにいるうえ、覆われて平らに
    // なったマスも未確定になった）。
    const start = settle(recognized.board) ?? completeIfInitial(asHoles(recognized.board));
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
    state = nextState(state, start, null);
    current = state.board;
    console.log(
      `  起点: ${fmt(t)}（盤上の駒 ${pieceCount(start)} 枚` +
        `${handsAreGuessed(state) ? '・持ち駒は不明なので両者に持たせる' : '・持ち駒も手番も確定'}）`,
    );
    continue;
  }

  // 読みを履歴に積む。**同じマスが何度も続けて同じ駒に読めたら確定**とみなす。
  history.observe(recognized.board);

  // 推測で挿し込んだ打ちの行き先が読めたら、挿し込みが本物だったかを決める。
  for (const [key, watch] of [...insertedDrops]) {
    const held = current?.[watch.row][watch.col];
    if (!held || held.side !== watch.side || held.kind !== watch.kind) {
      insertedDrops.delete(key); // 別の手が触った。もう決められない
      continue;
    }
    const c = history.confirmed(watch.row, watch.col);
    if (!c) continue;
    insertedDrops.delete(key);
    if (c.value) continue; // 駒のまま確定＝挿し込みは当たっていた

    // 🔒 **空と確定した＝その駒は盤に無い。挿し込みは誤りだった。**
    const step = watch.steps[watch.index];
    if (!step || step.usi !== `${watch.kind}*${toUsiSquare(watch.row, watch.col)}`) continue;
    watch.steps.splice(watch.index, 1);
    // 同じ列を指している他の見張りの位置をずらす（抜いた位置より後ろだけ）
    for (const other of [...provisional.values(), ...watchedDrops.values(), ...insertedDrops.values()]) {
      if (other.steps === watch.steps && other.index > watch.index) other.index--;
    }
    if (current) current[watch.row][watch.col] = null;
    const hand = state?.hand[watch.side];
    if (hand) hand[watch.kind] = (hand[watch.kind] ?? 0) + 1;
    history.reset(watch.row, watch.col);
    insertionsUndone++;
    if (VERBOSE) {
      console.log(
        `  ⤻ ${fmt(t)} ${toUsiSquare(watch.row, watch.col)} が空と確定（${c.streak} 回連続）→ ` +
          `${fmt(step.time)} に挿し込んだ ${step.usi} を取り消した`,
      );
    }
  }

  // 見張っている「打ち」の出発点が読めたら、そこで打ちか移動かを決める。
  for (const [key, watch] of [...watchedDrops]) {
    const held = current[watch.row][watch.col];
    // 追跡盤面からその駒が消えている（別の手が触った）なら、もう決められない
    if (!held || held.side !== watch.side || held.kind !== watch.kind) {
      watchedDrops.delete(key);
      continue;
    }
    const c = history.confirmed(watch.row, watch.col);
    if (!c) continue;
    watchedDrops.delete(key);
    if (c.value) continue; // 駒のまま確定＝本物の打ちだった。触らない

    // 🔒 **空と確定した＝その駒はもう居ない。打ちではなく、そこからの移動だった。**
    const step = watch.steps[watch.index];
    if (!step) continue;
    const usi = `${toUsiSquare(watch.row, watch.col)}${toUsiSquare(watch.to.row, watch.to.col)}`;
    const wasDrop = step.usi;
    step.usi = usi;
    // 盤: 出発点を空にする（打った先は既に正しい）
    current[watch.row][watch.col] = null;
    // 持ち駒: 打ちで減らした 1 枚を戻す。移動なら手から出ていない。
    const hand = state?.hand[watch.side];
    if (hand) hand[watch.kind] = (hand[watch.kind] ?? 0) + 1;
    history.reset(watch.row, watch.col);
    dropsRewritten++;
    if (VERBOSE) {
      console.log(
        `  ⇄ ${fmt(t)} ${toUsiSquare(watch.row, watch.col)} が空と確定（${c.streak} 回連続）→ ` +
          `${fmt(step.time)} の ${wasDrop} は打ちではなく ${usi} だった`,
      );
    }
  }

  // 覆われていて決めきれなかったマスを、読めるようになった時点で確定させる。
  // ⚠ 一発勝負ではなく**毎回試みる**。ポインタは動けば退くが、いつ退くかは
  // 分からないし、退いた 1 枚がたまたまきれいとも限らない。
  for (const [key, watch] of [...provisional]) {
    const c = history.confirmed(watch.row, watch.col);
    if (!c) continue;
    provisional.delete(key);
    const now = c.value;
    if (!now) {
      // 🔒 **「居るはずなのに空」だけが、幻の手を見分ける材料である。**
      //
      // マスが空になること自体は普通に起きる（取られた・その駒がまた動いた）。
      // だから「空に読めた」は単独では誤りの証拠にならず、長らくここで捨てていた。
      // ⚠ **だが置いた駒がまだそこに居るはずの時点で空なら、その手は無かった。**
      //
      // 実測（3 本目 12:14〜12:38・追記 152〜154）: マウスカーソルが空きマスに
      // 乗ると sd が跳ねて「駒があるが読めない」になり、`rescueVanished` が
      // そこを行き先に選ぶ。カーソルが動くと幻がそれを追いかけて盤上を歩いた。
      // **その行き先は 2〜4 秒後に毎回「空」と確定していた。3 回とも。**
      //
      // 巻き戻すのは**その手が断片の最後のときだけ**。後ろに手が積まれていたら、
      // それらがこの手の上に建っているので、ここで抜くと辻褄が合わなくなる。
      const step = watch.steps[watch.index];
      const isLast = step && watch.steps === steps && watch.index === steps.length - 1;
      if (step && isLast && watch.before) {
        steps.pop();
        state = watch.before;
        current = state.board;
        history.reset(watch.row, watch.col);
        phantomsUndone++;
        if (VERBOSE) {
          console.log(
            `  ✂ ${fmt(t)} ${9 - watch.col}${String.fromCharCode(97 + watch.row)} が空と確定` +
              `（${c.streak} 回連続）→ ${fmt(step.time)} の ${step.usi} を取り消した`,
          );
        }
      } else if (step) {
        // ⭐ 併合: **直後の手が同じ側で、この手の行き先から一直線の先へ出て行く**なら、
        // この 2 手は「滑るアニメーションの経由地」を独立した 1 手と読んだもの
        // （追記 165: 3 本目 26:16。飛が 3b→3g へ滑る途中の絵が 3f に写り、
        // 本物の 1 手 `3b3g+` が `3b3f`＋`3f3g+` に割れた）。
        //
        // 同じ側の連続 2 手は将棋では起こりえないので、どちらかが誤り。
        // 累積効果（駒の位置・取った駒・成り）は併合後の 1 手と完全に同じなので、
        // 盤・持ち駒・状態には触らず**手の列だけ**を直せる。
        // ⚠ 本物の連続（駒が Y に止まり、相手が指し、また動く）は間に相手の手が
        // 挟まって交互になるので、この条件（隣接して同じ側）には掛からない。
        const next = watch.steps[watch.index + 1];
        const via = toUsiSquare(watch.row, watch.col);
        const straightThrough = (() => {
          if (!next || next.side !== step.side) return false;
          if (step.usi.includes('*') || next.usi.includes('*')) return false;
          if (step.usi.length !== 4) return false; // 経由地で成る形は対象外
          if (next.usi.slice(0, 2) !== via) return false;
          const sq = (s: string) => ({ col: 9 - Number(s[0]), row: s.charCodeAt(1) - 97 });
          const x = sq(step.usi.slice(0, 2));
          const y = { col: watch.col, row: watch.row };
          const z = sq(next.usi.slice(2, 4));
          const d1 = { c: Math.sign(y.col - x.col), r: Math.sign(y.row - x.row) };
          const d2 = { c: Math.sign(z.col - y.col), r: Math.sign(z.row - y.row) };
          if (d1.c !== d2.c || d1.r !== d2.r) return false; // 向きが揃わないなら滑りではない
          // 各区間自体も直線（縦・横・斜め）であること
          const line = (a: typeof x, b: typeof x) => {
            const dc = Math.abs(b.col - a.col);
            const dr = Math.abs(b.row - a.row);
            return dc === 0 || dr === 0 || dc === dr;
          };
          return line(x, y) && line(y, z);
        })();
        if (straightThrough && next) {
          const was = `${step.usi} + ${next.usi}`;
          step.usi = step.usi.slice(0, 2) + next.usi.slice(2);
          step.time = next.time;
          step.solved = step.solved && next.solved;
          watch.steps.splice(watch.index + 1, 1);
          // 同じ列を指している他の見張りの位置をずらす（抜いた位置より後ろだけ）
          for (const other of [...provisional.values(), ...watchedDrops.values(), ...insertedDrops.values()]) {
            if (other.steps === watch.steps && other.index > watch.index) other.index--;
          }
          transitsMerged++;
          if (VERBOSE) {
            console.log(
              `  ⛙ ${fmt(t)} ${via} が空と確定（${c.streak} 回連続）→ 滑りの経由地だった。` +
                `${was} を ${step.usi} に併合した`,
            );
          }
        } else if (VERBOSE) {
          console.log(
            `  🔍 ${fmt(t)} ${9 - watch.col}${String.fromCharCode(97 + watch.row)} が空と確定` +
              `（${c.streak} 回連続）— ${fmt(step.time)} の ${step.usi} の行き先だが、` +
              `後ろに手が積まれているので取り消さない`,
          );
        }
      }
      continue;
    }
    if (now.kind === current[watch.row][watch.col]?.kind) continue; // 逆算が当たっていた

    const step = watch.steps[watch.index];
    if (step) {
      const wantsPlus = now.kind.startsWith('+');
      const hasPlus = step.usi.endsWith('+');
      if (wantsPlus !== hasPlus) {
        // ⚠ 成りに直すのは、その手が本当に成れる位置のときだけ。
        // 金は「全」と 0.70〜0.81 相関するので（追記 62）、自陣で動いた金が
        // 「成った銀」に見えることがある。実測 4i3h+。読みだけでは割れないが、
        // 敵陣に掛かっているかはルールで決まる。
        // 🔒 規則があり得ないと言う答えは、読みが何と言おうと取らない。
        const rejected = wantsPlus && !promotionIsPossible(step.usi, now.side);
        if (rejected) {
          promotionsRejected++;
          if (VERBOSE) {
            console.log(
              `  ⚠ ${fmt(t)} ${9 - watch.col}${String.fromCharCode(97 + watch.row)} が` +
                `${now.side === 'sente' ? '▲' : '▽'}${NAMES[now.kind]} に読めたが、` +
                `${step.usi} は敵陣に掛からないので成りに直さない`,
            );
          }
          continue; // 追跡中の盤面も触らない（読みの方が誤っている）
        }
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

  // 🔒 **自分の駒が、同じ側の別の駒に化けることは起こりえない。** そのマスを
  // 変えるには誰かがそこへ動く必要があるが、自分の駒は取れない。つまりこれは
  // 必ず読み違いなので、駒数超過と同じく「読めなかったマス」として引き継ぐ。
  //
  // 🔴 実測（1 局目 16:33〜17:00）: 8f の `▽金` を毎フレーム `▽全` と読み、
  // `ambiguous` が出続けて 8 回で仕切り直しになり 27 秒ぶんが落ちていた。
  const stuck = sameSideKindCells(current, recognized.board);
  if (stuck.length > 0) stuckKinds++;

  const suspicious = [...overflow, ...stuck];
  const pending = [...unknownCells(recognized.board), ...suspicious];

  // 未確定のマスを直前の配置で埋める。**覆われただけなら駒はそこにあり続ける。**
  const carried: Square[][] | null =
    pending.length > 0 ? carryUnknowns(recognized.board, suspicious, current) : null;

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

  // --- 演出が盤を覆っている絵は、読まずに捨てる ---
  //
  // 🔴 実測（2 局・追記 75）: `too-many-changes` 60 件のうち 15 件は、
  // **半透明の大きな絵が盤の一角を覆っただけ**だった。0:21 に 14 マス、
  // 29:53〜29:56 に 14 マスずつ。フレームを目で見て確認している。
  //
  // ⭐ **符号で見分けられる。駒が一斉に消えて、どこにも現れない。**
  // 将棋の手は必ず移動先を埋めるので、「空になっただけのマスが 3 つ以上」は
  // 手ではありえない。半透明なので下地の盤の目が透けて「空」に読めてしまい、
  // 「未確定」としては拾えない——だから駒の有無の側から見る。
  //
  // ⚠ **失敗に数えない。** 数えると `RESET_AFTER` に達して仕切り直しになり、
  // 断片が切れる。これは「読めなかった」のではなく「読むべきでない絵」。
  // 1 マスだけ消えた絵はスライド途中（`piece-vanished`）の領分なので触らない。
  const emptied = boardDiff(current, primary);
  if (
    emptied.length >= COVERED_CELLS &&
    emptied.every((d) => d.after === null && d.before !== null && !isUnknown(d.before))
  ) {
    covered++;
    if (VERBOSE && covered <= MAX_DETAIL) {
      console.log(`  ▨ ${fmt(t)} 演出に覆われた絵として捨てた（${emptied.length} マスが一斉に空）`);
    }
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

  // --- 「打てない駒が打たれた」と読めたら、打てる駒に限って読み直す ---
  //
  // 🔴 実測（1 局目 16:32〜17:00・27 秒ぶん約 10 手）: 後手が 8f に**金を打った**のに
  // `▽全`（成銀）の方が一致し、成駒は打てないので手が丸ごと落ちていた。
  //
  // ⚠ **同点を絵で割るのとは別物**（追記 69 でそれをやって失敗している）。
  // ここは「読みが規則上あり得ない答えを出した」ので、**あり得ない答えを取り除いて
  // もう一度読む**。問いが変わっている。実測でも取り除いた後は 0.692 対 0.383 で
  // 決まっており、差が付かなければ `readAsDroppable` が諦める。
  if (!result.move && result.failure === 'undroppable') {
    const spot = findUndroppableDrop(current, board);
    const reread = spot && readAsDroppable(img, spot.row, spot.col, spot.side, templates);
    if (spot && reread) {
      const fixed = board.map((r) => r.slice());
      fixed[spot.row][spot.col] = { kind: reread.kind, side: spot.side };
      const retry = inferMove(current, fixed);
      if (retry.move) {
        result = retry;
        board = fixed;
        undroppableReread++;
        if (VERBOSE) {
          console.log(
            `  ⚗ ${fmt(t)} 打てない駒だったので打てる駒に限って読み直した: ` +
              `${NAMES[spot.kind]} → ${NAMES[reread.kind]}（NCC ${reread.score.toFixed(3)}・` +
              `2 位と ${reread.margin.toFixed(3)} 差） → ${retry.move.usi}`,
          );
        }
      }
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
    const read = markUnknown(recognized.board, suspicious);
    const picked = pickCandidate(state, read, {
      maxConflicts: 1,
      // 仕切り直した直後は手番が分からない。狭めるより広く取る。
      anySide: handsAreGuessed(state),
    });
    if (picked.best) {
      const m = picked.best.move;
      if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
      steps.push({ time: t, usi: m.usi, side: m.side, solved: true });
      state = nextState(state, picked.best.board, { usi: m.usi, side: m.side });
      current = state.board;
      lastSyncTime = t;
      consecutiveFailures = 0;
      refusedDrop.count = 0;
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
      if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
      const before = state;
      steps.push({ time: t, usi: rescue.usi, side: rescue.side, solved: true });
      state = nextState(state, rescue.board, { usi: rescue.usi, side: rescue.side as Side });
      current = state.board;
      lastSyncTime = t;
      consecutiveFailures = 0;
      refusedDrop.count = 0;
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
        before,
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

  // 🔒 **持っていない駒の打ちを通さない。** `shared` の `applyMove` は既知の棋譜を
  // 再生する道具なので検証しない（持ち駒が負になって消えるだけ）。復元の側で
  // 通してしまうと偽の打ちが棋譜に残る。実際に 1 手目が `P*1c` になっていた。
  //
  // ⚠ 持ち駒が「不明」（仕切り直し後は両者に全部持たせている）のときは断らない。
  // そこで断ると、本当に指された打ちまで落ちる。
  //
  // ⭐ **ただし、断り続けたら疑うのは持ち駒の方。** 映像は「そのマスに駒が現れた」
  // ことについて嘘をつかない。同じ打ちが何度読んでも現れるなら、間違っているのは
  // 追跡している持ち駒である。実測（3 回の走査）で、`unheld-drop` がまとまって
  // 出た 3 か所（1 局目 10:38 `B*4a`、2 局目 23:47 `B*7g` / 21:32 `P*4b`）は
  // **すべて本当に指された手**で、断ったせいで断片が切れていた。
  if (result.move && state && handsTrusted && !canPlay(state, result.move.usi, result.move.side as Side)) {
    refusedDrop.count = refusedDrop.usi === result.move.usi ? refusedDrop.count + 1 : 1;
    refusedDrop.usi = result.move.usi;
    if (refusedDrop.count >= UNHELD_DROP_PATIENCE) {
      // 何度読んでも同じ打ちが見えている。持ち駒の追跡がどこかでずれている。
      handsTrusted = false;
      refusedDrop.count = 0;
      if (VERBOSE) {
        console.log(
          `  ⚠ ${fmt(t)} ${result.move.usi} を ${UNHELD_DROP_PATIENCE} 回断ってもまだ見えている。` +
            `持ち駒の追跡の方を疑い、以後は信じない`,
        );
      }
    } else {
      failures.set('unheld-drop', (failures.get('unheld-drop') ?? 0) + 1);
      if (VERBOSE && detailShown < MAX_DETAIL) {
        detailShown++;
        console.log(`  ⚠ ${fmt(t)} 持っていない駒を打つ手なので断った: ${result.move.usi}`);
      }
      result = { move: null, failure: 'unheld-drop', changedCells: result.changedCells };
    }
  }

  // --- 同じ側が 2 回続けて指したなら、間の 1 手を取りこぼしている ---
  //
  // 🔴 実測（2 局目 20:56〜20:58）: 飛が 3f の歩を取り、後手が `P*3e` と打ち、
  // 飛がすぐ取り返した。**打った駒がその場で取られると、盤の差分には何も残らない。**
  // 差分は「飛が 3f から 3e へ動いた」だけで、1 手として過不足なく説明できてしまう。
  // だから 2 手分解（`!result.move` のとき）にも入らない。
  //
  // ⭐ **手番の交互が破れたことが、唯一の手がかり。** 破れたら、間に相手の手が
  // あったものとして 2 手で説明し直す。読んだ手はそのままに、**前に 1 手挿す**
  // だけなので、当たっていなければ何も変わらない。
  const prevStep = steps.at(-1);
  if (result.move && prevStep && prevStep.side === result.move.side && state) {
    // ⭐⏱ **挿し込む前に、時計に聞く。** 挿し込みは「間に相手の手が 1 手あった」
    // という仮説であり、時計の反転はその仮説を盤と独立に検められる:
    //   ・窓の中のサンプルが全部同じ側（短い紛れも無い・隙間なく見ていた）
    //     → 間に手は無い。挿し込まない（交互の破れの原因は挿し込みでは直らない
    //     別の場所にある。正直な穴として残す）。⚠ 1 秒未満の速い手は反転として
    //     見えないので、「反転 0 回」ではなく「全サンプル同側」まで求める（judgeGap）
    //   ・反転がちょうど 1 回で、指した側も一致 → まず**反転時刻の周辺を読み直す**。
    //     本物の手が絵から拾えれば、推測の挿し込み自体が要らなくなる
    //     （🔴 幻の B*2d はここで生まれた——盤は静止していたのに、110 秒前の
    //     取りこぼしの帳尻として実在しない打ちが挿し込まれた。反転時刻を読めば
    //     「その時刻に指された本物の手」を先に探せる）。
    //     読み直しても拾えなければ従来どおり挿し込む（時刻は反転時刻を刻む）
    //   ・それ以外（被覆が足りない・反転が多い）→ 従来どおり
    let clockFlipTime: number | null = null;
    let clockVetoed = false;
    if (CLOCK_ENABLED) {
      const judged = clock.judgeGap(
        prevStep.time,
        t,
        screenSideOf(flipSide(result.move.side as Side)),
      );
      if (judged.verdict === 'veto') {
        clockVetoedInsertions++;
        clockVetoed = true;
        if (VERBOSE) {
          console.log(`  ⤺⏱ ${fmt(t)} 手番が飛んだが、時計は間に手が無いと言うので挿し込まない`);
        }
      } else if (judged.verdict === 'confirm' && judged.flipTime !== undefined) {
        clockFlipTime = judged.flipTime;
        if (!clockRefinedFlips.has(flipKey(judged.flipTime))) {
          clockRefinedFlips.add(flipKey(judged.flipTime));
          const times = rereadTimes(
            [{ t: judged.flipTime }],
            { from: prevStep.time, to: t },
          ).filter((s) => !queued.has(s));
          if (times.length > 0) {
            clockRereadWindows++;
            clockRereadSamples += times.length;
            queue.splice(qi, 0, ...times);
            for (const s of times) {
              fineTimes.add(s);
              queued.add(s);
            }
            qi--; // 直後の qi++ で挿し込んだ先頭に進む
            samples--; // この絵はまだ数えない。読み直したときに数える
            if (VERBOSE) {
              console.log(
                `  🔍⏱ ${fmt(t)} 時計の反転 ${fmt(judged.flipTime)} の周辺を先に読み直す（${times.length} 枚）`,
              );
            }
            continue;
          }
        }
      }
    }
    const read = markUnknown(recognized.board, suspicious);
    // `state.sideToMove` は相手の手番になっているので、1 手目は相手の手が並ぶ。
    // ⏱ 時計が「間に手は無い」と言った（veto）ときは挿し込みを試みない。
    // 交互の破れは正直な穴として残り、読めた手そのものは下で普通に通る。
    const pair: PairPickResult = clockVetoed
      ? { moves: null, board: null, failure: null, tiedCount: 0, promotionUncertain: false }
      : pickCandidatePair(state, read, { maxConflicts: 1 });
    // ⚠ 読めた手を置き換えはしない。**同じ手の前に相手の手が入る**ときだけ受ける。
    if (pair.moves && pair.board && pair.moves[1].usi === result.move.usi) {
      if (clockFlipTime !== null) clockConfirmedInsertions++;
      for (const [mi, m] of pair.moves.entries()) {
        // ⏱ 挿し込む 1 手目の時刻は、時計が反転を見た時刻を刻む（分かるとき）。
        // 「同時刻に 2 手」は追いつきの跡そのものなので、残さずに済むなら残さない。
        const at = mi === 0 && clockFlipTime !== null ? Number(clockFlipTime.toFixed(3)) : t;
        steps.push({ time: at, usi: m.usi, side: m.side, solved: true });
        history.reset(m.to.row, m.to.col);
        if (m.from) history.reset(m.from.row, m.from.col);
      }
      // ⚠ 2 手ぶんの持ち駒は `nextState` では進められない（盤から測り直しになる）。
      // 打った駒がその場で取られる形なので、**盤は 1 手で説明したときと同じ**でも
      // 持ち駒は違う。信用を落として盤に合わせる。
      const second = pair.moves[1];
      handsTrusted = false;
      state = {
        ...nextState(state, pair.board, { usi: second.usi, side: second.side }),
        sideToMove: second.side === 'sente' ? 'gote' : 'sente',
      };
      current = state.board;
      lastSyncTime = t;
      consecutiveFailures = 0;
      refusedDrop.count = 0;
      insertedMoves++;
      // 🔒 **挿し込んだ手は「推測」なので、後から証拠で確かめる。**
      //
      // 🔴 実測（3 本目 26:17・追記 160）: 本物の手は `2f3g+` の 1 手だけだったのに、
      // 隣の 3h が駒ありに見えたため **存在しない `P*3h` を挿し込んだ**。
      // 架空の歩は盤に残り続け、28:19 以降の 4 マスのずれになった。
      //
      // ⭐ 打ちなら見張れる。**行き先が「空」と確定し、盤がまだその駒を持っているなら、
      // 挿し込みは誤りだった。** ②（打ちの書き換え）と同じ形。
      const first = pair.moves[0];
      if (first.usi[1] === '*') {
        insertedDrops.set(`${first.to.row},${first.to.col}`, {
          row: first.to.row,
          col: first.to.col,
          kind: first.usi[0] as PieceKind,
          side: first.side as Side,
          steps,
          index: steps.length - 2, // 挿し込んだ 1 手目（2 手目は読めた手）
        });
        history.reset(first.to.row, first.to.col);
      }
      if (VERBOSE) {
        console.log(`  ⤺ ${fmt(t)} 手番が飛んだので間に 1 手挿した: ${pair.moves[0].usi} → ${second.usi}`);
      }
      continue;
    }
    // 🔴 **決められないことがある。決められないと分かることには価値がある。**
    // 実測（20:58）: 後手が 3e に何かを打ち、飛がすぐ取り返した。打った駒は
    // **盤に一度も現れない**ので、`P*3e` と `B*3e` が同点で並ぶ（どちらも持っていた）。
    // 🔒 当てずっぽうで決めない。**穴があることだけを残す。**
    // → 決めるには画面の持ち駒欄が要る（GOAL Phase F）。
    // ⏱ 時計が退けた場合は「決められない」ではなく「間に手が無い」なので数えない
    // （clockVetoedInsertions に別で数えてある）。
    if (!clockVetoed) unresolvedGaps++;
    if (VERBOSE && !clockVetoed) {
      console.log(
        `  ⤺? ${fmt(t)} 手番が飛んだ。${result.move.usi} の前に 1 手あるが決められない` +
          `（${pair.failure ?? '2 手目が読めた手と違う'}・同点 ${pair.tiedCount}）`,
      );
    }
  }

  // 打ちと読めた手のうち、引き継いだマスに出発点の候補が**ちょうど 1 つ**あるものは
  // 保留にする（🔒 ここでは決めない・追記 156）。候補が複数なら移動として一意に
  // 決まらないので、見張っても書き換えられない。
  const dropWatch =
    result.move && result.move.type === 'drop'
      ? carriedOriginsForDrop(
          current,
          result.move.to,
          result.move.usi[0] as PieceKind,
          result.move.side as Side,
          pending,
        )
      : [];
  if (dropWatch.length > 0) {
    dropsWithCarriedOrigin++;
    if (dropWatch.length === 1) dropsWithSingleCarriedOrigin++;
  }

  if (result.move && verifyMove(current, result.move.usi, result.move.side, board)) {
    if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
    const before = state;
    steps.push({ time: t, usi: result.move.usi, side: result.move.side, solved });
    state = nextState(state, board, { usi: result.move.usi, side: result.move.side as Side });
    current = state.board;
    lastSyncTime = t;
    consecutiveFailures = 0;
    refusedDrop.count = 0;

    // 手が指されたマスは中身が変わったので、古い読みの連続は捨てる。
    // 残すと「変わる前の駒」で確定してしまう。
    const to = result.move.to;
    const from = result.move.from;
    history.reset(to.row, to.col);
    if (from) history.reset(from.row, from.col);

    // 打ちだが、引き継いだマスから来られる駒がちょうど 1 つあるなら、
    // **その出発点を見張る**（🔒 いまは決めない・追記 156）。
    if (result.move.type === 'drop' && dropWatch.length === 1) {
      const origin = dropWatch[0];
      history.reset(origin.row, origin.col);
      watchedDrops.set(`${origin.row},${origin.col}`, {
        row: origin.row,
        col: origin.col,
        to: { row: to.row, col: to.col },
        kind: result.move.usi[0] as PieceKind,
        side: result.move.side as Side,
        steps,
        index: steps.length - 1,
      });
      if (VERBOSE) {
        console.log(
          `  👁 ${fmt(t)} ${result.move.usi} は打ちと読めたが、引き継いだ ` +
            `${toUsiSquare(origin.row, origin.col)} から来られる。出発点を見張る`,
        );
      }
    }

    // 移動先が読めていなかったなら、**その手はまだ確かめられていない**。
    // 読めるようになるまで持ち越して、後の場面で確定させる。
    if (
      result.move.type === 'move' &&
      from &&
      pending.some((c) => c.row === to.row && c.col === to.col)
    ) {
      provisional.set(`${to.row},${to.col}`, {
        row: to.row,
        col: to.col,
        steps,
        index: steps.length - 1,
        before,
      });
    }
    continue;
  }

  // --- 1 手として説明が付かないなら、その区間だけ細かく読み直す ---
  //
  // 1 手で説明が付かないのは、間に手が入っているから。諦めて仕切り直すと間の手を
  // 丸ごと失うので、**追跡が合っていた時刻から今までを `FINE_STEP` 刻みで
  // 読み直す**。挿し込んだ時刻は待ち行列に入るだけなので、このループ本体が
  // そのまま処理する——`carryUnknowns` も `rescueVanished` も候補手も効く。
  //
  // 🔴 **かつての二分探索（`bridgeGap`）はここを別の手続きでやっていて、
  // 2 局で 70 回試して 1 手も拾えなかった。** 中間の絵を「`inferMove` が通るか」で
  // 判定していたが、手が指された直後の絵はまさに移動先が未確定なので、その条件は
  // 原理的にほぼ通らない。0.1 秒刻みで実際に拾えた 6 手も全部 `rescueVanished`
  // 経由だった。**「読めるか」を「`inferMove` が通るか」で代用していた**（追記 74）。
  //
  // ⚠ **追跡が合っていた時刻から近いときに限る**（手が指された時刻ではない。
  // `lastSyncTime` の説明を見ること）。離れているときは数分ぶん追跡が切れており、
  // 間に何十手もあるので刻みを細かくしても届かない。
  if (
    lastSyncTime !== null &&
    !refined.has(t) &&
    t - lastSyncTime > FINE_STEP * 1.5 &&
    t - lastSyncTime <= REFINE_MAX_GAP
  ) {
    // 🔴 **一度読んだ時刻を二度読まない。** これが無かったときは、追跡がずれたまま
    // 次々に来る粗い時刻がそれぞれ同じ窓を挿し直し、**同じ絵を何度も読んでいた**
    // （0:21 付近で 6 → 7 → 8 → 9 枚と挿し直しが続き、追加で読んだ絵が 1018 枚に
    // 膨らんだ）。読み直して駄目だった絵は、もう一度読んでも駄目である。
    const inserted: number[] = [];
    for (let s = lastSyncTime + FINE_STEP; s < t - FINE_STEP / 2; s += FINE_STEP) {
      const at = Number(s.toFixed(3));
      if (!queued.has(at)) inserted.push(at);
    }
    if (inserted.length > 0) {
      refined.add(t);
      refinedWindows++;
      refinedSamples += inserted.length;
      // 挿し込んだ時刻を先に処理し、**この時刻もそのあとで読み直す**
      // （間の手が通っていれば、今度は 1 手として説明が付く）。
      queue.splice(qi, 0, ...inserted);
      for (const s of inserted) {
        fineTimes.add(s);
        queued.add(s);
      }
      qi--; // 直後の qi++ で挿し込んだ先頭に進む
      samples--; // この絵はまだ数えない。読み直したときに数える
      if (VERBOSE) {
        console.log(
          `  🔍 ${fmt(t)} 繋がらないので ${fmt(lastSyncTime)}〜${fmt(t)} を ` +
            `${FINE_STEP} 秒刻みで読み直す（${inserted.length} 枚）`,
        );
      }
      continue;
    }
  }

  // --- ⏱ 窓が REFINE_MAX_GAP を超えて長いなら、時計の反転時刻だけを狙って読み直す ---
  //
  // 一様な読み直しは「追跡が合っていた時刻から近いとき」しか効かない（上の ⚠）。
  // 🔴 実測（3 本目 2 局目 1699.5〜1777）: 王手の演出で 156 サンプル連続
  // 「盤面が成立せず捨てた」になり、78 秒の窓が空いた。窓が長すぎて一様な
  // 読み直しは届かず、2 手分解が実際は 4〜6 手の応酬を 3 手に圧縮した——
  // これが 110 秒後の幻の挿し込み（B*2d）の根になった。
  //
  // ⭐ **時計は演出に覆われない。** 窓の中の手番の反転は「このあたりで 1 手
  // 指された」という盤と独立の証拠なので、その時刻の周辺だけを読みに行けば、
  // 78 秒の窓でも挿し込む絵は反転あたり数枚で済む。手が指された直後は演出に
  // 覆われやすいから、狙うのは**指す直前**と**演出が引いたあと**
  // （CLOCK_REREAD_OFFSETS）。読めた絵はこのループ本体がそのまま処理する——
  // 一様な読み直しと同じで、本線の救済（carryUnknowns / rescueVanished /
  // 候補手・2 手分解）が全部効く。
  if (
    CLOCK_ENABLED &&
    lastSyncTime !== null &&
    t - lastSyncTime > REFINE_MAX_GAP
  ) {
    const flips = clock.flipsIn(lastSyncTime + 0.75, t - 0.75);
    const fresh = flips.filter((f) => !clockRefinedFlips.has(flipKey(f.t)));
    if (fresh.length > 0) {
      for (const f of fresh) clockRefinedFlips.add(flipKey(f.t));
      const times = rereadTimes(fresh, { from: lastSyncTime, to: t }).filter((s) => !queued.has(s));
      if (times.length > 0) {
        clockRereadWindows++;
        clockRereadSamples += times.length;
        queue.splice(qi, 0, ...times);
        for (const s of times) {
          fineTimes.add(s);
          queued.add(s);
        }
        qi--; // 直後の qi++ で挿し込んだ先頭に進む
        samples--; // この絵はまだ数えない。読み直したときに数える
        if (VERBOSE) {
          console.log(
            `  🔍⏱ ${fmt(t)} ${fmt(lastSyncTime)}〜${fmt(t)} の時計の反転 ${fresh.length} 箇所を` +
              `狙って読み直す（${times.length} 枚: ${fresh.map((f) => fmt(f.t)).join(' ')}）`,
          );
        }
        continue;
      }
    }
  }

  // --- 細かく読み直しても届かないなら、盤面の論理で 2 手に分解する ---
  //
  // 🔴 **映像を細かく探しても届かない場合がある。** 実測（13:06〜14:08）: 香が角を
  // 取り、数秒後に銀が取り返した。0.1 秒刻みで読み直しても「香が取ったが銀が
  // まだ取り返していない」中間の局面は**どのフレームにも読める形で現れない**。
  // その間ずっと移動先が未確定だったからで、フレームをいくら細かくしても無い。
  //
  // ⭐ **中間の絵は要らない。** 差分は 2 手で一意に説明できる。
  if (!result.move && result.failure !== 'piece-vanished' && state) {
    const read = markUnknown(recognized.board, suspicious);
    const pair = pickCandidatePair(state, read, {
      maxConflicts: 1,
      anySide: handsAreGuessed(state),
    });
    // ⏱ 2 手分解は「窓の中に 2 手あった」という説明。時計の反転回数と突き合わせる:
    //   ・窓の中のサンプルが**全部同じ側**（短い紛れも無い・隙間なく見ていた）
    //     → その窓で手は 1 手も指されていない。2 手の説明は**退ける**
    //     （盤の差分は読み違いかもしれない。当てずっぽうの 2 手より正直な穴）。
    //     ⚠「反転 0〜1 回」で退けてはいけない——1 秒未満の速い手（打った駒が
    //     その場で取られる形）は CLOCK_MIN_RUN 未満の連続にしかならず、
    //     反転として数えられない。全サンプル同側だけが「無かった」の証拠になる
    //   ・反転が 2 回 → 説明と一致。**手の時刻を反転時刻で刻む**
    //     （同時刻の塊は追いつきの跡。残さずに済むなら残さない）
    //   ・反転が 3 回以上 → 2 手では足りない。分解は受けるが（盤とは整合する）、
    //     **時計が言う手数との差を正直な穴として記録する**（発明はしない——
    //     何を指したかは盤にしか無く、盤は正味の差分しか見せていない）
    let pairTimes: [number, number] = [t, t];
    let pairVetoed = false;
    if (pair.moves && pair.board && CLOCK_ENABLED && lastSyncTime !== null && t - lastSyncTime > 2) {
      const flips = clock.flipsIn(lastSyncTime + 0.25, t + 0.25);
      const inner = { from: lastSyncTime + 0.6, to: t - 0.6 };
      if (
        flips.length === 0 &&
        clock.hasCoverage(inner.from, inner.to) &&
        clock.constantSideIn(inner.from, inner.to) !== null
      ) {
        pairVetoed = true;
        clockVetoedPairs++;
        if (VERBOSE) {
          console.log(
            `  ⚖⚖⏱ ${fmt(t)} 2 手分解を退けた: 時計はこの窓で誰も指していないと言う` +
              `（${pair.moves.map((m) => m.usi).join(' ')} は入れない）`,
          );
        }
      } else if (flips.length === 2) {
        pairTimes = [Number(flips[0].t.toFixed(3)), Number(flips[1].t.toFixed(3))];
      } else if (flips.length > 2) {
        clockGaps.push({
          game: gameIndex,
          from: lastSyncTime,
          to: t,
          clockMoves: flips.length,
          recordedMoves: 2,
        });
        if (VERBOSE) {
          console.log(
            `  ⏱⚠ ${fmt(t)} 時計は ${fmt(lastSyncTime)}〜${fmt(t)} に ${flips.length} 手と言うが ` +
              `2 手しか説明できない（正直な穴として記録）`,
          );
        }
      }
    }
    if (pair.moves && pair.board && !pairVetoed) {
      if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
      for (const [mi, m] of pair.moves.entries()) {
        steps.push({ time: pairTimes[mi], usi: m.usi, side: m.side, solved: true });
        history.reset(m.to.row, m.to.col);
        if (m.from) history.reset(m.from.row, m.from.col);
      }
      // 2 手目まで進んだ盤面へ移る。
      // ⚠ `nextState` は 1 手ぶんしか持ち駒を進められないので、2 手ぶんは
      // 盤から測り直しになる。**手番だけは分かっている**ので明示して合わせる。
      const second = pair.moves[1];
      handsTrusted = false;
      state = {
        ...nextState(state, pair.board, { usi: second.usi, side: second.side }),
        sideToMove: second.side === 'sente' ? 'gote' : 'sente',
      };
      current = state.board;
      lastSyncTime = t;
      consecutiveFailures = 0;
      refusedDrop.count = 0;
      pairedMoves += 2;
      if (VERBOSE) {
        console.log(
          `  ⚖⚖ ${fmt(t)} 2 手に分解した: ${pair.moves.map((m) => m.usi).join(' ')}` +
            `${pair.promotionUncertain ? '（成りは原理的に決められない）' : ''}`,
        );
      }
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
  //
  // ⚠ **挿し込んだ絵の失敗は数えない**（`fineTimes` の説明を見ること）。
  // 数えると読み直すほど仕切り直しが早まり、読み直した意味が消える。
  if (!fineTimes.has(t)) consecutiveFailures++;
  if (consecutiveFailures >= RESET_AFTER) {
    // 仕切り直し。**持ち駒は分からなくなる**（誰が何を取ったかは追跡の中にしかない）。
    state = nextState(state, board, null);
    current = state.board;
    lastSyncTime = t;
    consecutiveFailures = 0;
    refusedDrop.count = 0;
    resets++;
    steps = [];
  }
}

stream?.close();

console.log(`\n# ${samples} 点を ${((Date.now() - started) / 1000).toFixed(1)} 秒で読んだ`);
console.log(`  絵の取り方: 流れから ${streamedFrames} 枚 / 1 枚ずつ ${seekedFrames} 枚`);
console.log(`  配置が変わらなかった: ${unchanged}`);
console.log(`  スライド途中で捨てた: ${vanished}`);
if (rescuedVanished > 0) console.log(`  消えた駒の行き先を未確定のマスに見つけた: ${rescuedVanished}`);
if (phantomsUndone > 0) console.log(`  行き先が空と確定したので取り消した手: ${phantomsUndone}`);
if (dropsWithCarriedOrigin > 0) {
  console.log(
    `  📏 打ちと読めたが引き継ぎマスから来られた手: ${dropsWithCarriedOrigin}` +
      `（うち候補が 1 つ: ${dropsWithSingleCarriedOrigin}）`,
  );
}
if (dropsRewritten > 0) console.log(`  出発点が空と確定したので打ち → 移動に直した手: ${dropsRewritten}`);
if (insertionsUndone > 0) console.log(`  行き先が空と確定したので取り消した挿し込み: ${insertionsUndone}`);
if (transitsMerged > 0) console.log(`  滑りの経由地と分かって 1 手に併合した: ${transitsMerged}`);
console.log(`  読めないマスを引き継いで通った: ${carriedUsed}`);
console.log(
  `  📏 空のはずのマスに駒が現れた: 次の絵で消えた ${transientFills} / 居座った ${persistentFills}`,
);
console.log(
  `  📏 駒種を出したマス: presence=piece ${piecesOnSolidCells} / 薄いマス ${piecesOnThinCells}` +
    `（${((piecesOnThinCells / (piecesOnSolidCells + piecesOnThinCells)) * 100).toFixed(2)}%）`,
);
console.log(
  `  📏 薄いマスの内訳: 確認 ${thinConfirms} / 新出 ${thinNews}` +
    `（居座った ${thinNewPersisted} / 消えた ${thinNewVanished} / 追い切れず ${thinNewUnresolved}）`,
);
console.log(`  演出に覆われたとみて捨てた絵: ${covered}`);
if (offBoard > 0) console.log(`  対局中の盤が写っていないので読まなかった絵: ${offBoard}`);
console.log(`  細かく読み直した区間: ${refinedWindows}（追加で読んだ絵: ${refinedSamples}）`);
if (undroppableReread > 0) console.log(`  打てる駒に限って読み直して通った: ${undroppableReread}`);
if (stuckKinds > 0) console.log(`  同じ側の別の駒に化けて見えた絵（引き継いだ）: ${stuckKinds}`);
console.log(`  合法手の候補から決めた手: ${byCandidate}`);
console.log(`  盤面の論理で 2 手に分解して拾えた手: ${pairedMoves}`);
if (insertedMoves > 0) console.log(`  手番が飛んだので間に挿した手: ${insertedMoves}`);
if (unresolvedGaps > 0) console.log(`  手番が飛んだが決められなかった穴: ${unresolvedGaps}`);
if (CLOCK_ENABLED) {
  console.log(
    `  ⏱ 時計の手番指標: ${clockSamples} サンプル中 ${clockDecided} で手番が割れた` +
      `（${clockSamples > 0 ? Math.round((clockDecided / clockSamples) * 100) : 0}%）`,
  );
  if (clockRereadWindows > 0)
    console.log(`  ⏱ 時計の反転を狙った読み直し: ${clockRereadWindows} 窓（追加で読んだ絵: ${clockRereadSamples}）`);
  if (clockConfirmedInsertions > 0) console.log(`  ⏱ 時計が裏付けた挿し込み: ${clockConfirmedInsertions}`);
  if (clockVetoedInsertions > 0) console.log(`  ⏱ 時計が退けた挿し込み: ${clockVetoedInsertions}`);
  if (clockVetoedPairs > 0) console.log(`  ⏱ 時計が退けた 2 手分解: ${clockVetoedPairs}`);
  if (clockGaps.length > 0)
    console.log(
      `  ⏱🕳 時計が言う手数より説明が少なかった窓（正直な穴）: ${clockGaps.length} — ` +
        clockGaps.map((g) => `${fmt(g.from)}〜${fmt(g.to)} 時計 ${g.clockMoves} 手/記録 ${g.recordedMoves} 手`).join(' / '),
    );
}
console.log(`  持ち駒を信じられた区間で終わったか: ${handsTrusted ? 'はい' : 'いいえ（どこかで仕切り直した）'}`);
if (candidateFailures.size > 0) {
  console.log(
    `    候補でも決められなかった内訳: ` +
      [...candidateFailures].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '),
  );
}
console.log(`  成りを後から読み直して直した手: ${promotionsFixed}`);
if (promotionsRejected) console.log(`  成れない位置なので読みの方を断った: ${promotionsRejected}`);
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

// --- 画面の下が先手とは限らない ---
//
// 🔴 このアプリは**対局者の視点で盤を描く**ので、録画した人が後手の対局では
// 画面の下が後手になる。読みは一貫して「画面の下＝先手」で組んであるから、
// そのままでは**盤を 180° 回して先後を入れ替えた別の棋譜**が出来上がる。
// 初期局面はその変換で自分自身に移るので、**出来上がりは合法なまま**——
// 通しで再生しても何も起きない（実測: 1 局目は変換後も 92 手すべて合法）。
//
// ⭐ **1 手目を指した側が先手。** 初期局面から最初に動いたのが「後手」として
// 読めていたら、その対局は反転している。⚠ 対局ごとに向きは変わる
// （実測: 1 局目は画面の下が後手、2 局目は先手）。
const flippedGame = new Map<number, boolean>();
for (let g = 0; g <= gameIndex; g++) {
  const firstRun = runs
    .filter((r) => r.game === g && r.steps.length > 0)
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  if (firstRun) flippedGame.set(g, isFlipped(firstRun.steps[0].side));
}

const gameCount = gameIndex + 1;
for (let g = 0; g < gameCount; g++) {
  const mine = runs.filter((r) => r.game === g && r.steps.length > 0).sort((a, b) => b.steps.length - a.steps.length);
  if (mine.length === 0) continue;
  const flipped = flippedGame.get(g) ?? false;
  const moves = mine.reduce((n, r) => n + r.steps.length, 0);
  console.log(`\n# ${g + 1} 局目: ${moves} 手 / ${mine.length} 本の断片`);
  console.log(
    flipped
      ? '  画面の下は後手だった（1 手目を指したのが上の側）→ 180° 回して書き出す'
      : '  画面の下が先手（1 手目を指したのが下の側）',
  );
  for (const r of mine.slice(0, 5)) {
    let alt = 0;
    for (let i = 1; i < r.steps.length; i++) if (r.steps[i].side !== r.steps[i - 1].side) alt++;
    const ratio = r.steps.length > 1 ? (alt / (r.steps.length - 1)).toFixed(2) : '-';
    console.log(`\n  ${fmt(r.startedAt)}〜${fmt(r.steps.at(-1)!.time)}  ${r.steps.length} 手  手番の交互率 ${ratio}`);
    console.log(`    ${r.steps.map((s) => `${orient(s, flipped).usi}${s.solved ? '*' : ''}`).join(' ')}`);
  }

  // ⭐ **初期局面から通しで再生してみる。** 1 手ごとの合法性は走査中にも見ているが、
  // それは追跡中の盤面に対する検査で、その盤面は映像から再同期される。
  // **手の列が初期局面から繋がることは、ここでしか確かめられない。**
  // 手番の交互率では見つからない誤り（持っていない駒の打ちなど）がここに出る。
  //
  // ⚠ 向きを決めてから掛ける。反転したままでも合法に流れてしまうが、
  // **1 手目が後手になる**ので、向きの取り違えはここに現れる。
  const first = [...mine].sort((a, b) => a.startedAt - b.startedAt)[0];
  const result = replayGame(first.steps.map((s) => orient({ usi: s.usi, side: s.side, time: s.time }, flipped)));
  console.log(`\n  # 初期局面から通しで再生: 合法 ${result.legal} / ${result.total}`);
  for (const p of result.problems) console.log(`    ${describeProblem(p)}`);
  if (result.problems.length === 0) console.log('    ✅ 問題なし');
  // ⚠ 途中から始まる断片は起点の局面が分からないので掛けられない。
  if (mine.length > 1) console.log(`    （${mine.length - 1} 本の断片は初期局面から繋がらないので再生していない）`);
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
  const learned = learnedThisRun.filter((t) => t.kind.startsWith('+'));
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

// ⭐ **対局ごとに別のファイルへ書き出す。** 1 本の動画に 2 局入っているので、
// 混ぜると局をまたいだ「手」が生まれる。盤が初期局面に戻った時点で分けてある。
for (let g = 0; g <= gameIndex; g++) {
  const mine = runs.filter((r) => r.game === g && r.steps.length > 0);
  if (mine.length === 0) continue;
  const suffix = gameIndex > 0 ? `-game${g + 1}` : '';
  const outPath = `${OUT_DIR}/${basename(video).replace(/\.[^.]+$/, '')}-${Math.round(fromSec)}-${Math.round(toSec)}${suffix}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  // ⚠ **書き出すのは実際の先後に直したもの。** 画面の下が後手だった対局は
  // 180° 回して先後を入れ替える（読みの座標のままでは別の棋譜になる）。
  const flipped = flippedGame.get(g) ?? false;
  const payload = {
    source: basename(video),
    range: { fromSec, toSec, stepSec },
    game: g + 1,
    /** 画面の下の対局者が先手だったか。1 手目を指した側から決めた。 */
    bottomIsSente: !flipped,
    /**
     * ⏱ 時計は k 手と言うのに n 手しか説明できなかった窓（正直な穴）。
     * 空でなければ、その区間の手は**数が足りていない**——通し再生が満点でも信じない。
     * KIFU_VISION_CLOCK=0 のときはキー自体を出さない（従来の出力と一致させる）。
     */
    ...(CLOCK_ENABLED
      ? {
          clockGaps: clockGaps
            .filter((x) => x.game === g)
            .map(({ from, to, clockMoves, recordedMoves }) => ({ from, to, clockMoves, recordedMoves })),
        }
      : {}),
    runs: mine
      .map((r) => {
        let alt = 0;
        for (let i = 1; i < r.steps.length; i++) if (r.steps[i].side !== r.steps[i - 1].side) alt++;
        const oriented = r.steps.map((s) => orient({ usi: s.usi, side: s.side, time: s.time }, flipped));
        // 初期局面から通しで再生した結果。手番の交互率では見つからない誤りが出る。
        // ⚠ 途中から始まる断片は起点の局面が分からないので掛けられない。
        const replay = r === [...mine].sort((a, b) => a.startedAt - b.startedAt)[0]
          ? replayGame(oriented)
          : null;
        return {
          startedAt: r.startedAt,
          endedAt: r.steps.at(-1)!.time,
          moveCount: r.steps.length,
          // 手番が交互になっているか。1 でなければどこかで手を取りこぼしている。
          alternationRatio: r.steps.length > 1 ? alt / (r.steps.length - 1) : null,
          replay: replay && { legal: replay.legal, total: replay.total, problems: replay.problems },
          usi: oriented.map((x) => x.usi),
          moves: oriented.map((x, i) => ({ time: x.time, usi: x.usi, side: x.side, inferredKind: r.steps[i].solved })),
        };
      }),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n# 書き出した: ${outPath}`);
}
