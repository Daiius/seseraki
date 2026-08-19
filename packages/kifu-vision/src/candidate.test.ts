import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, type BoardState, type Square } from 'shared';
import { pickCandidate, pickCandidatePair, scoreCandidates } from './candidate.ts';
import { generateMoves } from './movegen.ts';
import { UNKNOWN, type VisionSquare } from './uncertain.ts';

const at = (usi: string) => ({ row: usi.charCodeAt(1) - 97, col: 9 - Number(usi[0]) });

/** 盤面をそのまま「完璧に読めた」読みとして使う */
const asRead = (board: Square[][]): VisionSquare[][] => board.map((r) => r.slice());

/** 読みの一部を「読めなかった」ことにする */
function blank(read: VisionSquare[][], squares: string[]): VisionSquare[][] {
  const out = read.map((r) => r.slice());
  for (const sq of squares) {
    const { row, col } = at(sq);
    out[row][col] = UNKNOWN;
  }
  return out;
}

function after(state: BoardState, usi: string): BoardState {
  return applyMove(state, usi);
}

describe('pickCandidate', () => {
  it('全部読めていれば手が 1 つに決まる', () => {
    const before = createInitialState();
    const read = asRead(after(before, '7g7f').board);
    const picked = pickCandidate(before, read);
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('7g7f');
    expect(picked.best!.conflicts).toBe(0);
  });

  it('⭐ 移動先が読めなくても、移動元が読めていれば手が決まる', () => {
    // ここが `inferMove` の詰まりどころ。移動先が未確定だと「何が来たか」が
    // 決められない。候補側から見れば、移動元が空いたことだけで絞れる。
    const before = createInitialState();
    const read = blank(asRead(after(before, '7g7f').board), ['7f']);
    const picked = pickCandidate(before, read);
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('7g7f');
  });

  it('⭐⭐ 成/不成は、移動先が読めれば成駒テンプレート無しでも決まる', () => {
    // 角が 2b へ入る。候補は 8h2b と 8h2b+ の 2 つしかない。
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);

    const promoted = pickCandidate(s, asRead(after(s, '8h2b+').board));
    expect(promoted.best!.move.usi).toBe('8h2b+');

    const plain = pickCandidate(s, asRead(after(s, '8h2b').board));
    expect(plain.best!.move.usi).toBe('8h2b');
  });

  it('移動先が読めないと成/不成は決まらない（曖昧として返す）', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const read = blank(asRead(after(s, '8h2b+').board), ['2b']);
    const picked = pickCandidate(s, read);
    expect(picked.failure).toBe('ambiguous');
    expect(picked.tied.map((t) => t.move.usi).sort()).toEqual(['8h2b', '8h2b+']);
  });

  it('決め手を渡せば、曖昧なまま返さず 1 つに絞れる', () => {
    // 実際には移動先のマスの絵と、生駒／成駒それぞれのテンプレートを
    // 突き合わせて決める。ここではその代わりに「成る方を選ぶ」決め手を渡す。
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const read = blank(asRead(after(s, '8h2b+').board), ['2b']);
    const picked = pickCandidate(s, read, {
      tieBreak: (a, b) => Number(b.move.promotes) - Number(a.move.promotes),
    });
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('8h2b+');
  });

  it('決め手が差を付けられなければ、無理に選ばない', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const read = blank(asRead(after(s, '8h2b+').board), ['2b']);
    const picked = pickCandidate(s, read, { tieBreak: () => 0 });
    expect(picked.failure).toBe('ambiguous');
  });

  it('2 手ぶん進んだ読みは「食い違いが多すぎる」として断る', () => {
    // 1 手では説明が付かない。ここで無理に 1 手を選ぶと棋譜が壊れる。
    let s = createInitialState();
    const two = after(after(s, '7g7f'), '3c3d');
    const picked = pickCandidate(s, asRead(two.board), { maxConflicts: 1 });
    expect(picked.failure).toBe('too-many-conflicts');
  });

  it('⭐ 追跡中の盤面に古い読み違えが 1 つ残っていても手は決まる', () => {
    // 全候補に等しく食い違いが乗るので、順位は変わらない。
    const before = createInitialState();
    const stale: BoardState = {
      ...before,
      board: before.board.map((r) => r.slice()),
    };
    // 9g の歩を金と読み違えたまま追跡している、という状況
    stale.board[at('9g').row][at('9g').col] = { kind: 'G', side: 'sente' };
    const read = asRead(after(before, '7g7f').board);
    const picked = pickCandidate(stale, read, { maxConflicts: 1 });
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('7g7f');
    expect(picked.best!.conflicts).toBe(1);
  });

  it('⭐ 持っていない駒を打つ偽手は候補に無い', () => {
    // マウスポインタで駒が湧いて見えると「打ち」に化ける。持ち駒を追えば消える。
    const before = createInitialState();
    const fake = before.board.map((r) => r.slice());
    fake[at('5e').row][at('5e').col] = { kind: 'G', side: 'sente' };
    const picked = pickCandidate(before, asRead(fake));
    // 金は持っていないので G*5e は候補に無い。1 手で説明が付かないと断る。
    expect(generateMoves(before).some((m) => m.usi === 'G*5e')).toBe(false);
    expect(picked.failure).toBe('too-many-conflicts');
  });

  it('持ち駒があれば打ちも候補になる', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = after(s, usi);
    const picked = pickCandidate(s, asRead(after(s, 'B*4e').board));
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('B*4e');
  });
});

describe('scoreCandidates', () => {
  it('未確定のマスは一致にも食い違いにも数えない', () => {
    const before = createInitialState();
    const full = scoreCandidates(before, asRead(before.board), generateMoves(before));
    const holed = scoreCandidates(before, blank(asRead(before.board), ['7g', '7f']), generateMoves(before));
    for (const s of full) expect(s.agrees + s.conflicts).toBe(81);
    for (const s of holed) expect(s.agrees + s.conflicts).toBe(79);
  });
});

describe('駒の有無を先に、駒種は後で見る', () => {
  it('⭐⭐ 似た字に読み違えても、駒の有無が合っていれば手が決まる', () => {
    // 実際に踏んだ形（16:32）: 相手が 8f へ金を打ったのに `▽全`（成銀）と読まれた。
    // 両者は本当に似ていて 0.8 相関する。だが**打つ手に成駒はあり得ない**ので、
    // 8f への打ちの候補は金だけ。
    //
    // ⚠ 有無と駒種を同列に数えると決められない。**8f を空のままにする候補も
    // 食い違いは同じ 1** なので、何十手もが同点に並ぶ。
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = after(s, usi);
    // 後手の手番。後手は角を持っている……ので金打ちの例に直す
    s = { ...s, hand: { ...s.hand, gote: { G: 1 } }, sideToMove: 'gote' };

    const truth = after(s, 'G*8f');
    const misread = asRead(truth.board);
    // 8f を「成銀」と読み違えた状態にする
    misread[at('8f').row][at('8f').col] = { kind: '+S', side: 'gote' };

    const picked = pickCandidate(s, misread);
    expect(picked.failure).toBeNull();
    expect(picked.best!.move.usi).toBe('G*8f');
    expect(picked.best!.occupancyConflicts).toBe(0);
    expect(picked.best!.identityConflicts).toBe(1);
  });

  it('駒の有無が食い違う候補は、駒種だけ違う候補に負ける', () => {
    let s = createInitialState();
    s = { ...s, hand: { ...s.hand, gote: { G: 1 } }, sideToMove: 'gote' };
    const truth = after(s, 'G*5e');
    const misread = asRead(truth.board);
    misread[at('5e').row][at('5e').col] = { kind: '+S', side: 'gote' };

    const scores = scoreCandidates(s, misread, generateMoves(s));
    const right = scores.find((x) => x.move.usi === 'G*5e')!;
    const elsewhere = scores.find((x) => x.move.usi === '3c3d')!;
    // どちらも食い違いの合計は同じでも、中身が違う
    expect(right.occupancyConflicts).toBe(0);
    expect(elsewhere.occupancyConflicts).toBeGreaterThan(0);
  });
});

describe('pickCandidatePair（1 手で説明が付かないとき）', () => {
  it('⭐⭐⭐ 中間の絵が無くても、2 手の組み合わせで説明できる', () => {
    // 🔴 実測（13:06〜14:08）: 香が角を取り、数秒後に銀が取り返した。
    // 0.1 秒刻みで読み直しても、「香が取ったが銀がまだ取り返していない」中間の
    // 局面は**どのフレームにも読める形で現れなかった**（その間ずっと移動先が
    // 未確定だったため）。**必要なのは映像の探索ではなく、盤面の論理での分解。**
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const two = after(after(s, '8h2b+'), '3a2b');

    // 1 手では説明が付かない
    expect(pickCandidate(s, asRead(two.board)).failure).toBe('too-many-conflicts');

    const pair = pickCandidatePair(s, asRead(two.board));
    expect(pair.failure).toBeNull();
    // ⚠ 角は 2b で取られるので、成ったかどうかは盤に残らない（下のテスト）。
    expect(pair.moves!.map((m) => m.usi.replace(/\+$/, ''))).toEqual(['8h2b', '3a2b']);
  });

  it('手番は必ず交互になる（同じ側が 2 手続けては指せない）', () => {
    let s = createInitialState();
    const two = after(after(s, '7g7f'), '3c3d');
    const pair = pickCandidatePair(s, asRead(two.board));
    expect(pair.moves![0].side).toBe('sente');
    expect(pair.moves![1].side).toBe('gote');
  });

  it('⭐ 成った駒がその場で取られると、成/不成は原理的に決まらない', () => {
    // 盤も持ち駒も完全に同じになる（成駒は取られると生駒として持ち駒に入る）。
    // どれだけ映像を細かく見ても決まらない。**手そのものは正しいので捨てない。**
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d']) s = after(s, usi);
    const two = after(after(s, '8h2b+'), '3a2b');
    const pair = pickCandidatePair(s, asRead(two.board));
    expect(pair.failure).toBeNull();
    expect(pair.promotionUncertain).toBe(true);
    // 当てずっぽうで `+` は付けない。棋譜が静かに嘘になるより、印を残す方がよい。
    expect(pair.moves!.map((m) => m.usi)).toEqual(['8h2b', '3a2b']);
  });

  it('取った駒は持ち駒に入るので、2 手目でそれを打てる', () => {
    let s = createInitialState();
    for (const usi of ['7g7f', '3c3d', '8h2b+', '3a2b']) s = after(s, usi);
    // 先手は角を持っている。「角を打つ → 後手が歩を突く」の 2 手。
    const two = after(after(s, 'B*4e'), '8c8d');
    const pair = pickCandidatePair(s, asRead(two.board));
    expect(pair.failure).toBeNull();
    expect(pair.moves!.map((m) => m.usi)).toEqual(['B*4e', '8c8d']);
  });

  it('3 手ぶん進んでいれば断る', () => {
    let s = createInitialState();
    let three = s;
    for (const usi of ['7g7f', '3c3d', '2g2f']) three = after(three, usi);
    expect(pickCandidatePair(s, asRead(three.board)).failure).toBe('too-many-conflicts');
  });
});
