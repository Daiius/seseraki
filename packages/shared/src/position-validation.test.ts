import { describe, expect, it } from 'vitest';
import { createInitialState } from './board';
import { parseSfen } from './sfen';
import {
  isAttackedBy,
  validateMoveOnPosition,
  validatePositionForEngine,
  type PositionViolationCode,
} from './position-validation';

/** SFEN から検証を回し、違反コードだけを取り出す */
function codesOf(sfen: string): PositionViolationCode[] {
  const state = parseSfen(sfen);
  expect(state, `parseSfen failed: ${sfen}`).not.toBeNull();
  const result = validatePositionForEngine(state!);
  return result.ok ? [] : result.violations.map((v) => v.code);
}

describe('validatePositionForEngine', () => {
  it('初期局面は通る', () => {
    expect(validatePositionForEngine(createInitialState())).toEqual({ ok: true });
  });

  it('玉だけの局面も通る（合法性は問わない）', () => {
    expect(codesOf('4k4/9/9/9/9/9/9/9/4K4 b -')).toEqual([]);
  });

  it('玉が無い側があれば弾く', () => {
    expect(codesOf('4k4/9/9/9/9/9/9/9/9 b -')).toContain('missing_king');
    expect(codesOf('9/9/9/9/9/9/9/9/4K4 b -')).toContain('missing_king');
  });

  it('玉が 2 枚ある側を弾く', () => {
    expect(codesOf('4k4/9/9/9/9/9/9/9/3KK4 b -')).toContain('too_many_kings');
  });

  it('二歩を弾く', () => {
    // 5 筋に先手の歩が 2 枚
    expect(codesOf('4k4/9/9/9/4P4/4P4/9/9/4K4 b -')).toContain('two_pawns');
  });

  it('成った歩は二歩に数えない', () => {
    expect(codesOf('4k4/9/9/9/4+P4/4P4/9/9/4K4 b -')).not.toContain('two_pawns');
  });

  it('行き所のない駒を弾く（先手の 1 段目の歩・香、1〜2 段目の桂）', () => {
    expect(codesOf('P3k4/9/9/9/9/9/9/9/4K4 b -')).toContain('stuck_piece');
    expect(codesOf('L3k4/9/9/9/9/9/9/9/4K4 b -')).toContain('stuck_piece');
    expect(codesOf('N3k4/9/9/9/9/9/9/9/4K4 b -')).toContain('stuck_piece');
    expect(codesOf('4k4/N8/9/9/9/9/9/9/4K4 b -')).toContain('stuck_piece');
    // 3 段目の桂は動ける
    expect(codesOf('4k4/9/N8/9/9/9/9/9/4K4 b -')).not.toContain('stuck_piece');
  });

  it('行き所のない駒は後手では上下が逆になる', () => {
    expect(codesOf('4k4/9/9/9/9/9/9/9/p3K4 b -')).toContain('stuck_piece');
    expect(codesOf('4k4/9/9/9/9/9/9/n8/4K4 b -')).toContain('stuck_piece');
    // 先手陣の 1 段目にある後手の歩は動ける（後手は下へ進む）
    expect(codesOf('p3k4/9/9/9/9/9/9/9/4K4 b -')).not.toContain('stuck_piece');
  });

  it('駒数の上限を超えたら弾く（成駒は生駒に戻して数える）', () => {
    // 角 3 枚（うち 1 枚は馬）
    expect(codesOf('4k4/9/9/9/B1B1+B4/9/9/9/4K4 b -')).toContain(
      'piece_count_exceeded',
    );
    // 持ち駒と合算して超える
    expect(codesOf('4k4/9/9/9/B1B6/9/9/9/4K4 b B')).toContain(
      'piece_count_exceeded',
    );
    // 上限ちょうどは通る（角 2 枚）
    expect(codesOf('4k4/9/9/9/B1B6/9/9/9/4K4 b -')).not.toContain(
      'piece_count_exceeded',
    );
  });

  it('手番側が相手玉を取れる局面を弾く', () => {
    // 先手の飛車が 5 筋で後手玉に当たっていて、手番は先手
    expect(codesOf('4k4/9/9/9/4R4/9/9/9/4K4 b -')).toContain('king_capturable');
    // 同じ形でも手番が後手なら「王手をかけられている側の手番」なので通る
    expect(codesOf('4k4/9/9/9/4R4/9/9/9/4K4 w -')).not.toContain(
      'king_capturable',
    );
  });

  it('駒に遮られていれば玉は取れない', () => {
    expect(codesOf('4k4/4p4/9/9/4R4/9/9/9/4K4 b -')).not.toContain(
      'king_capturable',
    );
  });

  it('後手番でも相手玉を取れる局面を弾く', () => {
    expect(codesOf('4k4/9/9/9/4r4/9/9/9/4K4 w -')).toContain('king_capturable');
  });

  it('桂の利きも見る（先手の桂は 2 段前・1 筋横）', () => {
    expect(codesOf('4k4/9/3N5/9/9/9/9/9/4K4 b -')).toContain('king_capturable');
    expect(codesOf('4k4/9/3n5/9/9/9/9/9/4K4 w -')).not.toContain(
      'king_capturable',
    );
  });

  it('違反は複数まとめて返す', () => {
    const codes = codesOf('9/9/9/9/9/9/9/9/9 b -');
    expect(codes.filter((c) => c === 'missing_king')).toHaveLength(2);
  });
});

describe('isAttackedBy', () => {
  it('香は縦に走る（駒に当たると止まる）', () => {
    const state = parseSfen('4k4/9/9/9/9/9/9/9/4L4 b -')!;
    // 9 段目の香が 1 段目（後手玉のマス）まで利いている
    expect(isAttackedBy(state, 'sente', 0, 4)).toBe(true);
  });

  it('と金は金の動きをする', () => {
    const state = parseSfen('4k4/4+P4/9/9/9/9/9/9/4K4 b -')!;
    expect(isAttackedBy(state, 'sente', 0, 4)).toBe(true);
  });

  it('馬は角の走りに加えて縦横 1 マスへ利く', () => {
    const state = parseSfen('4k4/4+B4/9/9/9/9/9/9/4K4 b -')!;
    expect(isAttackedBy(state, 'sente', 0, 4)).toBe(true);
  });
});

describe('validateMoveOnPosition', () => {
  const initial = createInitialState();

  it('盤上の自分の駒を動かす手は通る', () => {
    expect(validateMoveOnPosition(initial, '7g7f')).toEqual({ ok: true });
    expect(validateMoveOnPosition(initial, '2h7h')).toEqual({ ok: true });
  });

  it('合法でない手でも盤が壊れなければ通す', () => {
    // 歩が 2 マス進む手は非合法だが、駒は実在するので盤は壊れない（合法性は判定しない）
    expect(validateMoveOnPosition(initial, '7g7e')).toEqual({ ok: true });
  });

  it('書式が不正な手を弾く', () => {
    for (const move of ['', '7g', 'x7f', '7g7f++', 'K*5e', 'P*5j']) {
      const result = validateMoveOnPosition(initial, move);
      expect(result.ok, move).toBe(false);
      if (!result.ok) expect(result.violations[0].code).toBe('malformed_move');
    }
  });

  it('駒が無いマスからの移動を弾く', () => {
    const result = validateMoveOnPosition(initial, '5e5d');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0].code).toBe('no_such_piece');
  });

  it('相手の駒を動かす手を弾く', () => {
    const result = validateMoveOnPosition(initial, '3c3d');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0].code).toBe('no_such_piece');
  });

  it('自分の駒があるマスへの移動を弾く', () => {
    const result = validateMoveOnPosition(initial, '2h2g');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0].code).toBe('no_such_piece');
  });

  it('持っていない駒を打つ手を弾く', () => {
    const result = validateMoveOnPosition(initial, 'P*5e');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0].code).toBe('no_such_piece');
  });

  it('持ち駒があれば打てる。ただし駒のあるマスには打てない', () => {
    const state = parseSfen('4k4/9/9/9/9/9/9/9/4K4 b P')!;
    expect(validateMoveOnPosition(state, 'P*5e')).toEqual({ ok: true });
    const onPiece = validateMoveOnPosition(state, 'P*5i');
    expect(onPiece.ok).toBe(false);
  });
});
