import { describe, it, expect } from 'vitest';
import { createInitialState } from 'shared';
import {
  EvalRequestTracker,
  evalStateAfterPositionChange,
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
      mode: 'position',
      base: createInitialState(),
      candidates: [
        { rank: 1, move: '7g7f', scoreType: 'cp', scoreValue: 42, pv: ['7g7f'], depth: 20 },
      ],
      source: 'engine',
      fallback: false,
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
    ['loading', { kind: 'loading', mode: 'move' }],
    ['invalid', { kind: 'invalid', violations: [] }],
    ['busy', { kind: 'busy' }],
    ['error', { kind: 'error', message: 'サーバーに接続できません' }],
  ])('%s も「評価しようとした」状態なので stale になる', (_label, state) => {
    expect(evalStateAfterPositionChange(state)).toEqual({ kind: 'stale' });
  });
});
