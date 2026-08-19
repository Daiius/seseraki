import { describe, expect, it } from 'vitest';
import type { Side } from 'shared';
import { replayGame, type ReplayMove } from './replay.ts';

/** 先手から交互に指したものとして棋譜を組む */
function score(usi: string[], sides?: Side[]): ReplayMove[] {
  return usi.map((u, i) => ({
    usi: u,
    side: sides?.[i] ?? (i % 2 === 0 ? 'sente' : 'gote'),
    time: i,
  }));
}

describe('replayGame', () => {
  it('正しい棋譜は問題なく最後まで再生できる', () => {
    const r = replayGame(score(['7g7f', '3c3d', '2g2f', '4c4d', '2f2e', '2b3c']));
    expect(r.problems).toEqual([]);
    expect(r.legal).toBe(6);
  });

  it('手を 1 つ取りこぼした棋譜は、その手番の食い違いで分かる', () => {
    // 先手の 2 手目（2g2f）が抜けている。後手の手が 2 つ続く。
    const r = replayGame(score(['7g7f', '3c3d', '4c4d'], ['sente', 'gote', 'gote']));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ kind: 'missing-move', index: 3, usi: '4c4d' });
    // 抜けを許して続ければ、手自体は指せる
    expect(r.legal).toBe(3);
  });

  it('持っていない駒を打つ手を見つける', () => {
    // 交互には指しているので、手番の交互率では検出できない形。
    const r = replayGame(score(['7g7f', '3c3d', 'P*5e']));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ kind: 'impossible', index: 3, usi: 'P*5e' });
    expect(r.legal).toBe(2);
  });

  it('駒の動きとして成立しない手を見つける', () => {
    // 飛車が斜めに動く（実際に読み違いで出た形）
    const r = replayGame(score(['7g7f', '3c3d', '2h3g']));
    expect(r.problems[0]).toMatchObject({ kind: 'impossible', index: 3 });
  });

  it('王手放置は「動きとして成立しない」とは区別する', () => {
    // 先手の角が 3c へ成って王手（4b が空いているので玉に利いている）
    // → 後手が王手を放置して端歩を突く
    const r = replayGame(score(['7g7f', '3c3d', '8h3c+', '9c9d']));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ kind: 'left-in-check', index: 4, usi: '9c9d' });
  });

  it('非合法な手も盤に反映して続ける（誤りが局所的かを見分けるため）', () => {
    // 3 手目が非合法でも、そこから先が素直に繋がるなら誤りは 1 か所と分かる。
    const r = replayGame(score(['7g7f', '3c3d', '2h3g', '8c8d', '3g3f']));
    expect(r.problems).toHaveLength(1);
    expect(r.legal).toBe(4);
    // 無理やり動かした飛車が 3g にいて、そこから 3f へ動けている
    expect(r.final.board[5][6]).toEqual({ kind: 'R', side: 'sente' });
  });

  it('盤に反映できない手は unapplicable として記録する', () => {
    // 誰もいないマスから動かす
    const r = replayGame(score(['7g7f', '3c3d', '5e5d']));
    expect(r.problems[0]).toMatchObject({ kind: 'unapplicable', index: 3 });
  });

  it('取った駒は持ち駒に入るので、その後の打ちは合法になる', () => {
    const r = replayGame(
      score(['7g7f', '3c3d', '8h2b+', '3a2b', 'B*5e']),
    );
    expect(r.problems).toEqual([]);
    expect(r.legal).toBe(5);
  });
});

describe('玉を取る手', () => {
  it('🔒 相手玉を取る手は合法として数えない', () => {
    // 玉が取られる局面は正しい棋譜には現れない（取られる前に王手放置として現れる）。
    // ここでは**認識がずれたときに起きる形**を作る——後手が王手を放置し、
    // 次に先手が玉のマスへ動く。この最後の手を「合法」と数えてはいけない。
    const usi = [
      '5g5f', '5a5b', // 後手玉が 5b へ出る
      '5f5e', '4a4b',
      '5e5d', '4b4a',
      '5d5c+',        // と金ができて 5b の玉に王手
      '4a4b',         // 🔴 後手が王手を放置（認識ずれで起きる形）
      '5c5b',         // 🔴 と金が玉を取る
    ];
    const r = replayGame(score(usi));
    expect(r.legal).toBe(7);
    const last = r.problems.find((p) => p.index === 9);
    expect(last).toMatchObject({ usi: '5c5b' });
    expect(last?.kind).not.toBe('left-in-check'); // 「王手放置」ではなく、手として成立しない
  });
});
