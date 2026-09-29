import { describe, expect, it } from 'vitest';
import {
  buildPositions,
  createInitialState,
  positionHash,
  positionKey,
  positionSfen,
  sideLayoutKey,
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
    const base = sideLayoutKey(buildPositions(['7g7f', '8c8d'])[2], 'sente');
    expect(sameSideLayout(a, 'sente', base)).toBe(true);
  });

  it('配置が違えば一致しない（ハッシュが衝突してもここで落ちる）', () => {
    const a = rowOf(['2g2f', '3c3d']);
    const base = sideLayoutKey(buildPositions(['7g7f', '8c8d'])[2], 'sente');
    expect(sameSideLayout(a, 'sente', base)).toBe(false);
  });

  // 🔴 退行の回帰（dev で踏んだ）。文字列を保存していた頃は列の照合順序（utf8mb4_0900_ai_ci）が
  // 大小文字を区別せずに比べていたので、先手の配置と（回した）後手の配置が一致していた
  it('🔴 先後をまたいで一致する（初期局面の後手側 = 主体が先手の棋譜の初期局面）', () => {
    const base = sideLayoutKey(createInitialState(), 'gote');
    expect(sameSideLayout(rowOf([]), 'sente', base)).toBe(true);
    // 索引で引くハッシュも先後で同じ値になる
    expect(hashOf(sideLayoutKey(createInitialState(), 'sente'))).toEqual(hashOf(base));
  });

  it('🔴 先後をまたいで一致する（途中局面: 先手の形 = 後手が同じ形を作った局面）', () => {
    // 先手 7g7f・2g2f と、後手 3c3d・8c8d は回すと同じ形
    const sente = buildPositions(['7g7f', '3c3d', '2g2f', '8c8d'])[4];
    const base = sideLayoutKey(sente, 'sente');
    expect(sameSideLayout(rowOf(['7g7f', '3c3d', '2g2f', '8c8d']), 'gote', base)).toBe(true);
    expect(sameSideLayout(rowOf(['7g7f', '3c3d', '2g2f']), 'gote', base)).toBe(false);
  });

  it('文字列を保存していた頃の判定（照合順序で大小文字を区別しない sideSfen の一致）と同じ結果になる', () => {
    const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e', '6a5b', '2g2f', '8c8d'];
    const states = buildPositions(moves);
    for (const side of ['sente', 'gote'] as const) {
      for (const base of states) {
        const baseSideSfen = sideSfen(base, side);
        states.forEach((state, i) => {
          for (const rowSide of ['sente', 'gote'] as const) {
            expect(
              sameSideLayout(rowOf(moves.slice(0, i)), rowSide, sideLayoutKey(base, side)),
            ).toBe(sideSfen(state, rowSide).toLowerCase() === baseSideSfen.toLowerCase());
          }
        });
      }
    }
  });
});
