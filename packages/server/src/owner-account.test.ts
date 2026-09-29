import { describe, expect, it } from 'vitest';
import {
  decideOwnerLink,
  describeLink,
  type LinkCandidate,
} from './owner-account.js';

const x: LinkCandidate = {
  userId: 'uuid-x',
  email: 'owner@example.invalid',
  name: 'Owner',
};
const y: LinkCandidate = {
  userId: 'uuid-y',
  email: 'other@example.invalid',
  name: 'Other',
};

describe('decideOwnerLink（prd/07 §4 手順 0 をコードで強制する）', () => {
  it('対象がちょうど 1 行で、"1" にその provider の account が無ければ付け替えてよい', () => {
    expect(decideOwnerLink([x], false)).toEqual({
      kind: 'ready',
      candidate: x,
    });
  });

  it('対象が無ければ止める（まだログインしていない）', () => {
    expect(decideOwnerLink([], false)).toEqual({ kind: 'none' });
  });

  it('🔒 対象が 2 行以上なら止める（どれが所有者か機械的に決めない）', () => {
    expect(decideOwnerLink([x, y], false)).toEqual({
      kind: 'ambiguous',
      candidates: [x, y],
    });
  });

  it('"1" に既にその provider の account があれば、対象があっても止める', () => {
    expect(decideOwnerLink([x], true)).toEqual({
      kind: 'already-linked',
      candidates: [x],
    });
    expect(decideOwnerLink([], true)).toEqual({
      kind: 'already-linked',
      candidates: [],
    });
  });
});

describe('describeLink（エントリの出力）', () => {
  it('dry-run は対象のメールを出し、実行の仕方を添える', () => {
    const text = describeLink('google', {
      decision: { kind: 'ready', candidate: x },
      applied: false,
    });
    expect(text).toContain('owner@example.invalid');
    expect(text).toContain('LINK_OWNER_APPLY=1');
  });

  it('実行後は付け替えたことを出す', () => {
    const text = describeLink('google', {
      decision: { kind: 'ready', candidate: x },
      applied: true,
    });
    expect(text).toContain('付け替えた');
    expect(text).not.toContain('dry-run');
  });

  it('複数あるときは全員のメールを出す（目で見分けるため）', () => {
    const text = describeLink('google', {
      decision: { kind: 'ambiguous', candidates: [x, y] },
      applied: false,
    });
    expect(text).toContain('owner@example.invalid');
    expect(text).toContain('other@example.invalid');
    expect(text).toContain('--email');
  });
});
