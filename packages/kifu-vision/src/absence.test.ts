import { describe, expect, it } from 'vitest';
import type { Presence } from './occupancy.ts';
import { ABSENT_AFTER, AbsenceEvidence, CORROBORATE_AFTER, shouldQuarantine } from './absence.ts';

function feed(e: AbsenceEvidence, samples: Presence[]): void {
  for (const p of samples) e.observe(p);
}
function times(p: Presence, n: number): Presence[] {
  return Array.from({ length: n }, () => p);
}

describe('消極的証拠（presence が piece と言わない連続）', () => {
  it('幻: unclear が ABSENT_AFTER 連続したら starved になる', () => {
    const e = new AbsenceEvidence();
    feed(e, times('unclear', ABSENT_AFTER - 1));
    expect(e.starved()).toBe(false); // 境界の 1 つ手前では発火しない
    e.observe('unclear');
    expect(e.starved()).toBe(true);
    expect(e.corroborated()).toBe(false);
  });

  it('幻の実測形: 挿し込み直後に 2 サンプルだけ piece が来ても、そのあとの飢えで starved になる', () => {
    // 3 本目 31:32 の B*2d の行き先 8f の実測: piece ×2（スライド/演出の横切り）→ unclear ×35
    const e = new AbsenceEvidence();
    feed(e, times('piece', 2));
    feed(e, times('unclear', ABSENT_AFTER));
    expect(e.starved()).toBe(true);
    // ⚠ 2 サンプルの piece は裏が取れたことにならない（CORROBORATE_AFTER = 3）
    expect(e.corroborated()).toBe(false);
  });

  it('本物: piece が CORROBORATE_AFTER 連続したら corroborated。居座る限り starved にならない', () => {
    const e = new AbsenceEvidence();
    feed(e, times('piece', CORROBORATE_AFTER));
    expect(e.corroborated()).toBe(true);
    feed(e, times('piece', 30));
    expect(e.starved()).toBe(false);
  });

  it('ポインタの覆い: 本物の駒に 1〜2 サンプルの unclear が挟まっても誤爆しない', () => {
    const e = new AbsenceEvidence();
    feed(e, times('piece', 4));
    feed(e, times('unclear', 2)); // ポインタは 1〜2 サンプルで退く（confirm.ts の実測）
    feed(e, times('piece', 4));
    feed(e, times('unclear', 2));
    feed(e, times('piece', 4));
    expect(e.starved()).toBe(false);
    expect(e.corroborated()).toBe(true);
  });

  it('演出の閃光: 2〜4 サンプルの非 piece では starved にならない', () => {
    const e = new AbsenceEvidence();
    feed(e, times('piece', 3));
    feed(e, times('unclear', 4)); // 閃光は 1〜2 秒 = 2〜4 サンプル
    expect(e.starved()).toBe(false);
    feed(e, times('piece', 1)); // 閃光が明けて駒が戻る
    expect(e.starved()).toBe(false);
  });

  it('empty も non-piece として数える（unclear と混ざっても連続が切れない）', () => {
    const e = new AbsenceEvidence();
    const mixed: Presence[] = ['unclear', 'empty', 'unclear', 'empty', 'unclear', 'empty', 'unclear', 'empty'];
    feed(e, mixed);
    expect(e.starved()).toBe(true);
  });

  it('検疫の門: 裏の取れていない挿し込み駒を動かす手は、打ちへの読み替えが勝つ', () => {
    // 1911.5 型のレース: 挿し込み直後に本物の手が来て「幻の駒の移動」として
    // 説明可能な形。絶食（starved）の熟成を待たずに検疫で止める。
    const phantom = new AbsenceEvidence();
    feed(phantom, times('piece', 2)); // 横切りの 2 サンプルでは裏にならない
    feed(phantom, times('unclear', 4)); // まだ絶食（8）には届いていない
    expect(phantom.starved()).toBe(false);
    const move = { side: 'sente', promoted: false, captured: undefined };
    expect(shouldQuarantine(phantom, move, { side: 'sente' })).toBe(true);
  });

  it('検疫の門: 裏の取れた挿し込み・成る手・取る手・別の側は読み替えない', () => {
    const real = new AbsenceEvidence();
    feed(real, times('piece', CORROBORATE_AFTER)); // 駒が本当に居た
    const move = { side: 'sente', promoted: false, captured: undefined };
    expect(shouldQuarantine(real, move, { side: 'sente' })).toBe(false);

    const phantom = new AbsenceEvidence();
    feed(phantom, times('unclear', 4));
    // 成る手は打ちでは表せない
    expect(shouldQuarantine(phantom, { ...move, promoted: true }, { side: 'sente' })).toBe(false);
    // 取る手は打ちでは表せない（打ちは空マスにしか打てない）
    expect(shouldQuarantine(phantom, { ...move, captured: { kind: 'P', side: 'gote' } }, { side: 'sente' })).toBe(false);
    // 動かす側が違うなら同じ駒の話ではない
    expect(shouldQuarantine(phantom, { ...move, side: 'gote' }, { side: 'sente' })).toBe(false);
  });

  it('レース（1911.5 型）: 移動として説明が来る時点で、幻は corroborated ではない', () => {
    // 挿し込み（1892.5）から本物の手（1911.5）まで 38 サンプル。
    // 先頭 2 サンプルが piece（横切り）でも裏は取れず、検疫の対象になる。
    const e = new AbsenceEvidence();
    feed(e, times('piece', 2));
    feed(e, times('unclear', 35));
    expect(e.corroborated()).toBe(false);
    // しかも starved は移動の遥か前（8 サンプル目）に立っている
    const early = new AbsenceEvidence();
    feed(early, times('piece', 2));
    feed(early, times('unclear', ABSENT_AFTER));
    expect(early.starved()).toBe(true);
  });
});
