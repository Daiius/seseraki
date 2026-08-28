import { describe, it, expect } from 'vitest';
import { createInitialState } from 'shared';
import {
  EvalRequestTracker,
  evalStateAfterPositionChange,
  gradeLastMove,
  headlineCandidate,
  scoreLoss,
  type EvalCandidateView,
  type EvalState,
} from './positionEval';

/**
 * 評価要求の採否（レビュー指摘 `OCL-AED22F46` の回帰テスト）。
 *
 * 🔴 **踏んだ不具合**: 評価は long-poll で数秒〜十数秒かかる。その間に駒を動かしても
 * 走っている要求が捨てられていなかったため、**旧局面の応答が編集後の盤の評価として
 * 表示された**。検討ツールとしては値の意味が壊れる。
 */
describe('EvalRequestTracker', () => {
  it('捨てていなければ結果を受け入れる', () => {
    const tracker = new EvalRequestTracker();
    const { token, signal } = tracker.begin();
    expect(tracker.accepts(token)).toBe(true);
    expect(signal.aborted).toBe(false);
  });

  it('cancel すると abort し、その要求の結果を受け付けなくなる', () => {
    const tracker = new EvalRequestTracker();
    const { token, signal } = tracker.begin();
    tracker.cancel();
    expect(signal.aborted).toBe(true);
    expect(tracker.accepts(token)).toBe(false);
  });

  it('押し直すと前の要求だけが無効になる（二重送信の抑止）', () => {
    const tracker = new EvalRequestTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(first.signal.aborted).toBe(true);
    expect(tracker.accepts(first.token)).toBe(false);
    expect(tracker.accepts(second.token)).toBe(true);
  });

  it('走っていなくても cancel でき、以後の要求には影響しない', () => {
    const tracker = new EvalRequestTracker();
    tracker.cancel();
    const { token } = tracker.begin();
    expect(tracker.accepts(token)).toBe(true);
  });

  /**
   * 🔴 これが本命。**abort だけに頼らない**ことを固定する——応答の受信と abort が
   * 競れば結果は手元まで届くので、「届いたが反映しない」を世代で決める。
   */
  it('要求中に局面を編集したら、遅れて届いた旧局面の応答は反映されない', async () => {
    const tracker = new EvalRequestTracker();
    let shown: string | null = null;

    // 旧局面の評価を要求する（long-poll: まだ返らない）
    const { token } = tracker.begin();
    let settle: (value: string) => void = () => {};
    const inFlight = new Promise<string>((resolve) => {
      settle = resolve;
    }).then((result) => {
      // 画面へ反映してよいかは、必ずここで判定する
      if (tracker.accepts(token)) shown = result;
    });

    // 待っている間に駒を動かした（= 局面が変わった）
    tracker.cancel();

    // その後で旧局面の応答が届く
    settle('旧局面の評価');
    await inFlight;

    expect(shown).toBeNull();
  });

  it('クライアント検証で弾いたときも、旧要求の結果に上書きされない', async () => {
    const tracker = new EvalRequestTracker();
    let shown = '';

    const { token } = tracker.begin();
    let settle: (value: string) => void = () => {};
    const inFlight = new Promise<string>((resolve) => {
      settle = resolve;
    }).then((result) => {
      if (tracker.accepts(token)) shown = result;
    });

    // 編集した新局面が検証で弾かれた → 警告を出しつつ、走っている要求も捨てる
    tracker.cancel();
    shown = 'この局面はエンジンに渡せない';

    settle('旧局面の評価');
    await inFlight;

    expect(shown).toBe('この局面はエンジンに渡せない');
  });
});

/**
 * 評価後に局面が変わったときの見え方。
 *
 * 🔴 **実機で踏んだ分かりにくさ**: 評価結果が出ている盤で駒を動かすと、結果ブロックが
 * 黙って消えるだけだった。機能としては押し直せるのに、**次に何ができるのかの手がかりが
 * 無く**「もう評価できないのか」と読めてしまった。
 *
 * 🔒 値そのものは残さない（別の局面の値を画面に置くのは prd/12 §2.6 に反する）。
 * 残すのは「もう一度評価できる」という手がかりだけなので、状態としては
 * `idle`（まだ何もしていない）と `stale`（評価したが盤が変わった）を分ける。
 */
describe('evalStateAfterPositionChange', () => {
  it('評価結果が出ていたら stale になる（値は消える・手がかりは残る）', () => {
    const done: EvalState = {
      kind: 'done',
      base: createInitialState(),
      candidates: [
        { rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 42, pv: ['7g7f'], depth: 20 },
      ],
      source: 'engine',
      grade: null,
    };
    const next = evalStateAfterPositionChange(done);
    expect(next).toEqual({ kind: 'stale' });
    // 🔒 スコア・候補手・読み筋は一切引き継がない
    expect(next).not.toHaveProperty('candidates');
  });

  it('まだ一度も評価していなければ何も出さないまま（idle のまま）', () => {
    const idle: EvalState = { kind: 'idle' };
    // 同じオブジェクトを返す（無駄な再描画を作らない）
    expect(evalStateAfterPositionChange(idle)).toBe(idle);
  });

  it('stale のまま局面を変え続けても stale（同じオブジェクトを返す）', () => {
    const stale: EvalState = { kind: 'stale' };
    expect(evalStateAfterPositionChange(stale)).toBe(stale);
  });

  it.each<[string, EvalState]>([
    ['loading', { kind: 'loading' }],
    ['invalid', { kind: 'invalid', violations: [] }],
    ['busy', { kind: 'busy' }],
    ['error', { kind: 'error', message: 'サーバーに接続できません' }],
  ])('%s も「評価しようとした」状態なので stale になる', (_label, state) => {
    expect(evalStateAfterPositionChange(state)).toEqual({ kind: 'stale' });
  });
});

/**
 * 「この局面の評価値」として単独で出す 1 本（実機の指摘が起点）。
 *
 * 🔴 局面評価は候補手 3 本を返すが、**その局面自体の評価値が単独では出ていなかった**。
 * 最善手のスコアがそのまま局面の評価値なのに候補手リストの 1 行目に埋もれていて、
 * 「評価値が 1 つ決まるはずなのに、どこにも無い」と読めた。
 */
describe('headlineCandidate', () => {
  const candidate = (
    rank: number,
    scoreValue: number,
    move: string,
  ): EvalCandidateView => ({
    rank,
    move,
    scoreType: 'cp',
    scoreValue,
    pv: [move],
    depth: 20,
  });

  it('局面評価: rank 1 のスコアがその局面の評価値になる', () => {
    const headline = headlineCandidate([
      candidate(1, 42, '7g7f'),
      candidate(2, 18, '2g2f'),
      candidate(3, -35, '6i7h'),
    ]);
    expect(headline?.rank).toBe(1);
    expect(headline?.scoreValue).toBe(42);
  });

  it('並び順に頼らず rank の一番小さいものを選ぶ', () => {
    const headline = headlineCandidate([
      candidate(3, -35, '6i7h'),
      candidate(1, 42, '7g7f'),
      candidate(2, 18, '2g2f'),
    ]);
    expect(headline?.move).toBe('7g7f');
  });

  it('候補手が 1 本しか返らなくても、それがその局面の評価値になる', () => {
    const only = candidate(1, -60, '2g2f');
    expect(headlineCandidate([only])).toBe(only);
  });

  it('候補手が無ければ null（詰みなど）', () => {
    expect(headlineCandidate([])).toBeNull();
  });
});

/**
 * 直前の手の採点（prd/12 §3.2・決定 2026-08-29）。
 *
 * 🔴 **web の評価ボタンを 1 つにまとめた**。押すと現在の検討局面を評価し、直前が盤上の
 * 指し手なら 1 手前の局面も評価して、最善との差（損失）を出す。かつての「この手を読む」
 * （名指し評価）は返る数字が局面評価と同じで**符号だけ反転**していたため web から外した。
 *
 * 🔒 **視点をすべて「指した側」に揃えること**がこの関数の肝。現局面の評価は相手番視点なので
 * 符号を反転する——ここを間違えると、良い手が悪い手に見える。
 */
describe('gradeLastMove', () => {
  const from = createInitialState(); // 先手番（＝ 指した側は先手）
  const candidate = (
    rank: number,
    move: string,
    scoreValue: number,
    scoreType = 'cp',
  ): EvalCandidateView => ({ rank, move, scoreType, scoreValue, pv: [move], depth: 20 });

  it('指した手の評価値は現局面（相手番視点）の符号反転', () => {
    const grade = gradeLastMove({
      from,
      move: '7g7f',
      // 現局面は後手番なので −42 = 先手から見て +42
      current: candidate(1, '3c3d', -42),
      previousCandidates: [candidate(1, '7g7f', 42)],
      previousSource: 'engine',
    });
    expect(grade?.playedScoreValue).toBe(42);
    expect(grade?.playedScoreType).toBe('cp');
  });

  it('指した手が 1 手前の rank 1 なら最善手（損失 0）', () => {
    const grade = gradeLastMove({
      from,
      move: '7g7f',
      current: candidate(1, '3c3d', -42),
      previousCandidates: [candidate(1, '7g7f', 42), candidate(2, '2g2f', 30)],
      previousSource: 'engine',
    });
    expect(grade?.isBest).toBe(true);
    expect(grade?.loss).toBe(0);
    expect(grade?.best.move).toBe('7g7f');
  });

  it('損失 = 最善のスコア − 指した手のスコア（同じ視点で引く）', () => {
    const grade = gradeLastMove({
      from,
      move: '2g2f',
      current: candidate(1, '3c3d', -12), // 指した後: 先手から見て +12
      previousCandidates: [candidate(1, '7g7f', 45), candidate(2, '2g2f', 30)],
      previousSource: 'engine',
    });
    expect(grade?.isBest).toBe(false);
    expect(grade?.loss).toBe(33);
  });

  it('最善は rank の一番小さいものを選ぶ（配列の並びに頼らない）', () => {
    const grade = gradeLastMove({
      from,
      move: '2g2f',
      current: candidate(1, '3c3d', -12),
      previousCandidates: [candidate(2, '2g2f', 30), candidate(1, '7g7f', 45)],
      previousSource: 'kifu',
    });
    expect(grade?.best.move).toBe('7g7f');
    expect(grade?.source).toBe('kifu');
  });

  /**
   * 🔒 **`mate` が絡んだら損失の数値は出さない。** `mate` の値は詰みまでの手数で、
   * `cp` とは単位が違い、`mate` 同士でも引き算に意味が無い。
   */
  it('mate が絡むと損失は null（値そのものは両方残す）', () => {
    const mateBest = gradeLastMove({
      from,
      move: '2g2f',
      current: candidate(1, '3c3d', -12),
      previousCandidates: [candidate(1, '5e5d', 5, 'mate')],
      previousSource: 'engine',
    });
    expect(mateBest?.loss).toBeNull();
    expect(mateBest?.best.scoreType).toBe('mate');
    expect(mateBest?.playedScoreValue).toBe(12);

    const matePlayed = gradeLastMove({
      from,
      move: '2g2f',
      // 現局面が「後手の 3 手詰」＝ 先手から見れば mate −3
      current: candidate(1, '3c3d', 3, 'mate'),
      previousCandidates: [candidate(1, '7g7f', 45)],
      previousSource: 'engine',
    });
    expect(matePlayed?.loss).toBeNull();
    expect(matePlayed?.playedScoreType).toBe('mate');
    expect(matePlayed?.playedScoreValue).toBe(-3);
  });

  it('材料が欠けたら採点しない（現局面の評価値が無い / 1 手前の候補手が空）', () => {
    expect(
      gradeLastMove({
        from,
        move: '7g7f',
        current: null,
        previousCandidates: [candidate(1, '7g7f', 42)],
        previousSource: 'engine',
      }),
    ).toBeNull();
    expect(
      gradeLastMove({
        from,
        move: '7g7f',
        current: candidate(1, '3c3d', -42),
        previousCandidates: [],
        previousSource: 'engine',
      }),
    ).toBeNull();
  });
});

describe('scoreLoss', () => {
  it('両方 cp なら差を返す', () => {
    expect(scoreLoss({ scoreType: 'cp', scoreValue: 45 }, { scoreType: 'cp', scoreValue: 12 }))
      .toBe(33);
  });

  it('どちらかが mate なら null', () => {
    expect(scoreLoss({ scoreType: 'mate', scoreValue: 5 }, { scoreType: 'cp', scoreValue: 12 }))
      .toBeNull();
    expect(scoreLoss({ scoreType: 'cp', scoreValue: 45 }, { scoreType: 'mate', scoreValue: -3 }))
      .toBeNull();
    expect(scoreLoss({ scoreType: 'mate', scoreValue: 5 }, { scoreType: 'mate', scoreValue: 3 }))
      .toBeNull();
  });

  it('別々の探索なので負にもなりうる（丸めずそのまま返す）', () => {
    expect(scoreLoss({ scoreType: 'cp', scoreValue: 40 }, { scoreType: 'cp', scoreValue: 46 }))
      .toBe(-6);
  });
});
