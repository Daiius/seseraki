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
import { settle, fillGuesses, unknownCells, markUnknown, isUnknown, asHoles, type VisionSquare } from './src/uncertain.ts';
import { inferMove, verifyMove, opposite, type InferFailure } from './src/moves.ts';
import { pickCandidate, pickCandidatePair } from './src/candidate.ts';
import { completeIfInitial, startFromBoard, handsAreGuessed, canPlay, handsMatchBoard } from './src/tracking.ts';
import { solveUnknowns, type UnknownCell } from './src/solve.ts';
import { findUndroppableDrop, readAsDroppable } from './src/droppable.ts';
import { loadTemplates, saveTemplates, mergeTemplates } from './src/template-store.ts';
import { calibrateFromFrames, calibrateGeometry, isCalibrationTrustworthy } from './src/calibrate.ts';
import { ReadingHistory } from './src/confirm.ts';
import { rescueVanished } from './src/vanished.ts';
import { checkBoard, pieceCount, overflowCells, sameSideKindCells } from './src/sanity.ts';
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
  const frame = grabFrame(video, t, geo.frameW, geo.frameH);
  if (!isCalibrationTrustworthy(calibrateGeometry(frame, geo))) {
    offBoard++;
    if (VERBOSE && offBoard <= MAX_DETAIL) console.log(`  ▢ ${fmt(t)} 対局中の盤が写っていないので読まない`);
    continue;
  }
  const img = crop(frame, boardRect(geo));
  const recognized = recognizeBoard(img, templates);

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

  if (result.move && verifyMove(current, result.move.usi, result.move.side, board)) {
    if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
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
    if (pair.moves && pair.board) {
      if (steps.length === 0) runs.push({ steps, startedAt: t, game: gameIndex });
      for (const m of pair.moves) {
        steps.push({ time: t, usi: m.usi, side: m.side, solved: true });
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

console.log(`\n# ${samples} 点を ${((Date.now() - started) / 1000).toFixed(1)} 秒で読んだ`);
console.log(`  配置が変わらなかった: ${unchanged}`);
console.log(`  スライド途中で捨てた: ${vanished}`);
if (rescuedVanished > 0) console.log(`  消えた駒の行き先を未確定のマスに見つけた: ${rescuedVanished}`);
console.log(`  読めないマスを引き継いで通った: ${carriedUsed}`);
console.log(`  演出に覆われたとみて捨てた絵: ${covered}`);
if (offBoard > 0) console.log(`  対局中の盤が写っていないので読まなかった絵: ${offBoard}`);
console.log(`  細かく読み直した区間: ${refinedWindows}（追加で読んだ絵: ${refinedSamples}）`);
if (undroppableReread > 0) console.log(`  打てる駒に限って読み直して通った: ${undroppableReread}`);
if (stuckKinds > 0) console.log(`  同じ側の別の駒に化けて見えた絵（引き継いだ）: ${stuckKinds}`);
console.log(`  合法手の候補から決めた手: ${byCandidate}`);
console.log(`  盤面の論理で 2 手に分解して拾えた手: ${pairedMoves}`);
console.log(`  持ち駒を信じられた区間で終わったか: ${handsTrusted ? 'はい' : 'いいえ（どこかで仕切り直した）'}`);
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

const gameCount = gameIndex + 1;
for (let g = 0; g < gameCount; g++) {
  const mine = runs.filter((r) => r.game === g && r.steps.length > 0).sort((a, b) => b.steps.length - a.steps.length);
  if (mine.length === 0) continue;
  const moves = mine.reduce((n, r) => n + r.steps.length, 0);
  console.log(`\n# ${g + 1} 局目: ${moves} 手 / ${mine.length} 本の断片`);
  for (const r of mine.slice(0, 5)) {
    let alt = 0;
    for (let i = 1; i < r.steps.length; i++) if (r.steps[i].side !== r.steps[i - 1].side) alt++;
    const ratio = r.steps.length > 1 ? (alt / (r.steps.length - 1)).toFixed(2) : '-';
    console.log(`\n  ${fmt(r.startedAt)}〜${fmt(r.steps.at(-1)!.time)}  ${r.steps.length} 手  手番の交互率 ${ratio}`);
    console.log(`    ${r.steps.map((s) => `${s.usi}${s.solved ? '*' : ''}`).join(' ')}`);
  }
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

// ⭐ **対局ごとに別のファイルへ書き出す。** 1 本の動画に 2 局入っているので、
// 混ぜると局をまたいだ「手」が生まれる。盤が初期局面に戻った時点で分けてある。
for (let g = 0; g <= gameIndex; g++) {
  const mine = runs.filter((r) => r.game === g && r.steps.length > 0);
  if (mine.length === 0) continue;
  const suffix = gameIndex > 0 ? `-game${g + 1}` : '';
  const outPath = `${OUT_DIR}/${basename(video).replace(/\.[^.]+$/, '')}-${Math.round(fromSec)}-${Math.round(toSec)}${suffix}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  const payload = {
    source: basename(video),
    range: { fromSec, toSec, stepSec },
    game: g + 1,
    runs: mine
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
