import { describe, expect, it } from 'vitest';
import {
  activeAliases,
  overlaps,
  subjectSideFromNames,
  subjectSideFromVideo,
  type Alias,
} from './users';

const alias = (name: string, from?: string, to?: string): Alias => ({
  name,
  validFrom: from ?? null,
  validTo: to ?? null,
});

describe('subjectSideFromNames', () => {
  it('片方だけ一致すればその側', () => {
    expect(subjectSideFromNames('me', 'other', ['me'])).toBe('sente');
    expect(subjectSideFromNames('other', 'me', ['me'])).toBe('gote');
  });

  it('両方一致したら null（ambiguous）', () => {
    // 🔒 「後手」として数えない。側を確定できない対局は実在する
    expect(subjectSideFromNames('me', 'me2', ['me', 'me2'])).toBeNull();
  });

  it('どちらも一致しなければ null', () => {
    expect(subjectSideFromNames('a', 'b', ['me'])).toBeNull();
  });

  it('名前候補が空なら null', () => {
    expect(subjectSideFromNames('me', 'other', [])).toBeNull();
  });

  it('対局者名が null でも落ちない', () => {
    expect(subjectSideFromNames(null, 'me', ['me'])).toBe('gote');
    expect(subjectSideFromNames(null, null, ['me'])).toBeNull();
  });

  it('大文字小文字は区別する（別アカウントとして登録する運用）', () => {
    expect(subjectSideFromNames('Daiius', 'x', ['daiius'])).toBeNull();
  });
});

describe('subjectSideFromVideo', () => {
  it('画面の下が先手なら主体は先手', () => {
    expect(subjectSideFromVideo(true)).toBe('sente');
    expect(subjectSideFromVideo(false)).toBe('gote');
  });
});

describe('activeAliases（名前の有効期間）', () => {
  const aliases = [
    alias('old', undefined, '2026-06-30'), // 2026-06-30 まで
    alias('new', '2026-07-01'), // 2026-07-01 から
    alias('always'), // 無期限
  ];

  it('既定（無期限）は常に有効', () => {
    expect(activeAliases([alias('always')], new Date('2020-01-01'))).toEqual(['always']);
  });

  it('期間内の候補だけを返す', () => {
    expect(activeAliases(aliases, new Date('2026-05-01T00:00:00Z'))).toEqual([
      'old',
      'always',
    ]);
    expect(activeAliases(aliases, new Date('2026-08-01T00:00:00Z'))).toEqual([
      'new',
      'always',
    ]);
  });

  it('境界の日を含む（両端とも）', () => {
    expect(activeAliases(aliases, new Date('2026-06-30T00:00:00Z'))).toContain('old');
    expect(activeAliases(aliases, new Date('2026-07-01T00:00:00Z'))).toContain('new');
  });

  it('🔒 playedAt が null なら期間を見ない（prd/11 §5.3）', () => {
    // 日時の分からない棋譜で主体側が決まらない方が実害が大きい、という判断。
    // 期間で衝突を解こうとした意図は裏切るが、それは §5.3 に明記した妥協
    expect(activeAliases(aliases, null)).toEqual(['old', 'new', 'always']);
  });

  it('改名の衝突が期間で解ける', () => {
    // "A" → "B" に改名。その後 "A" を他人が使い、2026-08 に対局した
    const mine = [alias('A', undefined, '2026-06-30'), alias('B', '2026-07-01')];
    const names = activeAliases(mine, new Date('2026-08-01T00:00:00Z'));
    // 相手の "A" はもう候補ではないので ambiguous にならない
    expect(subjectSideFromNames('B', 'A', names)).toBe('sente');
  });

  it('⚠ 同時期に同名の別人は期間では解けない', () => {
    const mine = [alias('B'), alias('X')];
    const names = activeAliases(mine, new Date('2026-08-01T00:00:00Z'));
    // 相手がたまたま候補と同じ名前 → 確定できない（1 局ごとの上書きは将来の拡張）
    expect(subjectSideFromNames('B', 'X', names)).toBeNull();
  });
});

describe('overlaps', () => {
  it('無期限どうしは重なる', () => {
    expect(overlaps(alias('a'), alias('b'))).toBe(true);
  });

  it('離れた期間は重ならない', () => {
    expect(
      overlaps(alias('a', undefined, '2026-06-30'), alias('b', '2026-07-01')),
    ).toBe(false);
  });

  it('端が接していれば重なる', () => {
    expect(
      overlaps(alias('a', undefined, '2026-07-01'), alias('b', '2026-07-01')),
    ).toBe(true);
  });
});
