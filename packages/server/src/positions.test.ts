import { describe, expect, it } from 'vitest';
import {
  buildPositions,
  createInitialState,
  positionHash,
  positionKey,
  positionSfen,
  sideSfen,
} from 'shared';
import { db } from './db/index.js';
import { kifuPositions } from './db/schema.js';
import {
  hashOf,
  parsePositionKey,
  samePosition,
  samePositionAsSfen,
  sameSideLayout,
  sfenOfRow,
} from './positions.js';

const INITIAL = positionSfen(createInitialState());

/** 局面索引 1 行ぶん（DB から読んだ形に寄せて Buffer にする） */
function rowOf(moves: string[]) {
  const states = buildPositions(moves);
  const key = positionKey(states[states.length - 1]);
  return {
    board: Buffer.from(key.board),
    hands: Buffer.from(key.hands),
    sideToMove: key.sideToMove,
  };
}

function render(where: ReturnType<typeof samePosition>) {
  const { sql, params } = db
    .select({ kifuId: kifuPositions.kifuId })
    .from(kifuPositions)
    .where(where)
    .limit(10)
    .toSQL();
  return { sql: sql.toLowerCase(), params };
}

describe('parsePositionKey', () => {
  it('手数付き（4 フィールド）の SFEN も正規化した局面キーになる', () => {
    expect(parsePositionKey(`${INITIAL} 1`)?.sfen).toBe(INITIAL);
  });

  it('読めない SFEN は null', () => {
    expect(parsePositionKey('not a sfen')).toBeNull();
  });
});

describe('samePosition（ハッシュで引いて照合する）', () => {
  it('🔒 ハッシュだけでなく盤・持ち駒・手番まで where に入る（衝突を照合で落とす）', () => {
    const key = parsePositionKey(INITIAL)!;
    const { sql, params } = render(samePosition(kifuPositions, key));
    expect(sql).toContain('`kifu_positions`.`sfenhash` = ?');
    expect(sql).toContain('`kifu_positions`.`board` = ?');
    expect(sql).toContain('`kifu_positions`.`hands` = ?');
    expect(sql).toContain('`kifu_positions`.`sidetomove` = ?');
    // 照合は SQL の中にあるので、上限は照合後の行にかかる（件数がずれない）
    expect(sql.indexOf('limit')).toBeGreaterThan(sql.indexOf('`board` = ?'));
    expect(params).toContainEqual(Buffer.from(positionHash(INITIAL)));
    expect(params).toContainEqual(Buffer.from(key.board));
    expect(params).toContainEqual(Buffer.from(key.hands));
    expect(params).toContain('b');
  });

  it('読めない SFEN はどの行にも一致しない条件になる', () => {
    const { sql } = render(samePositionAsSfen(kifuPositions, 'broken'));
    expect(sql).toContain('false');
    expect(sql).not.toContain('sfenhash');
  });

  it('hashOf は shared の positionHash と同じ 8 バイト', () => {
    expect(hashOf(INITIAL)).toEqual(Buffer.from(positionHash(INITIAL)));
    expect(hashOf(INITIAL)).toHaveLength(8);
  });
});

describe('sfenOfRow（保存しない文字列を組み立てる）', () => {
  it('行の盤・持ち駒・手番から、保存していた頃と同じ SFEN が出る', () => {
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e'];
    const states = buildPositions(moves);
    states.forEach((state, i) => {
      expect(sfenOfRow(rowOf(moves.slice(0, i)))).toBe(positionSfen(state));
    });
  });
});

describe('sameSideLayout（片側の配置の照合）', () => {
  it('同じ配置なら一致する（相手の駒は見ない）', () => {
    // 先手が 7g7f を指した後、後手が何を指しても先手の配置は同じ
    const a = rowOf(['7g7f', '3c3d']);
    const baseSente = sideSfen(buildPositions(['7g7f', '8c8d'])[2], 'sente');
    expect(sameSideLayout(a, 'sente', baseSente)).toBe(true);
  });

  it('配置が違えば一致しない（ハッシュが衝突してもここで落ちる）', () => {
    const a = rowOf(['2g2f', '3c3d']);
    const baseSente = sideSfen(buildPositions(['7g7f', '8c8d'])[2], 'sente');
    expect(sameSideLayout(a, 'sente', baseSente)).toBe(false);
  });

  it('文字列で比べていた頃の判定（sideSfen の一致）と同じ結果になる', () => {
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e', '6a5b'];
    const states = buildPositions(moves);
    for (const side of ['sente', 'gote'] as const) {
      for (const base of states) {
        const baseSideSfen = sideSfen(base, side);
        states.forEach((state, i) => {
          for (const rowSide of ['sente', 'gote'] as const) {
            expect(sameSideLayout(rowOf(moves.slice(0, i)), rowSide, baseSideSfen)).toBe(
              sideSfen(state, rowSide) === baseSideSfen,
            );
          }
        });
      }
    }
  });
});
