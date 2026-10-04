import { describe, expect, it } from 'vitest';
import {
  compareCounts,
  ConversionError,
  convertRow,
  convertValue,
  isUtcSessionZone,
  kindOfSqlType,
  mysqlUtcToDate,
  rowKey,
} from './convert.js';
import { MIGRATED_TABLES, SKIPPED_TABLES } from './plan.js';

describe('mysqlUtcToDate', () => {
  it('MySQL の壁時計を UTC として読む（接続の時刻帯に依存しない）', () => {
    expect(mysqlUtcToDate('2026-01-02 03:04:05').toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('ミリ秒までの小数を持てる', () => {
    expect(mysqlUtcToDate('2026-01-02 03:04:05.123').toISOString()).toBe('2026-01-02T03:04:05.123Z');
    expect(mysqlUtcToDate('2026-01-02 03:04:05.120000').toISOString()).toBe('2026-01-02T03:04:05.120Z');
  });

  it('ミリ秒より細かい値は黙って切り捨てない', () => {
    expect(() => mysqlUtcToDate('2026-01-02 03:04:05.123456')).toThrow(ConversionError);
  });

  it('ゼロ日付・存在しない日時・形の違う文字列を弾く', () => {
    expect(() => mysqlUtcToDate('0000-00-00 00:00:00')).toThrow(ConversionError);
    expect(() => mysqlUtcToDate('2026-02-30 00:00:00')).toThrow(ConversionError);
    expect(() => mysqlUtcToDate('2026-01-02T03:04:05Z')).toThrow(ConversionError);
  });
});

describe('convertValue', () => {
  it('null はどの種類でも null', () => {
    for (const kind of ['timestamptz', 'date', 'jsonb', 'boolean', 'bytea', 'integer', 'text'] as const) {
      expect(convertValue(kind, null)).toBeNull();
    }
  });

  it('日時は文字列だけを受ける（Date で来たら mysql2 の時刻帯変換を通っている）', () => {
    expect(convertValue('timestamptz', '2026-01-02 03:04:05')).toEqual(new Date('2026-01-02T03:04:05Z'));
    expect(() => convertValue('timestamptz', new Date())).toThrow(ConversionError);
  });

  it('日付は文字列のまま', () => {
    expect(convertValue('date', '2026-03-31')).toBe('2026-03-31');
    expect(() => convertValue('date', '2026-04-31')).toThrow(ConversionError);
  });

  it('JSON の文字列はそのまま、値は文字列にする（配列を Postgres の配列にしない）', () => {
    expect(convertValue('jsonb', '["7g7f","3c3d"]')).toBe('["7g7f","3c3d"]');
    expect(convertValue('jsonb', ['7g7f', '3c3d'])).toBe('["7g7f","3c3d"]');
    expect(convertValue('jsonb', { a: 1 })).toBe('{"a":1}');
    expect(() => convertValue('jsonb', '[1,')).toThrow(ConversionError);
  });

  it('tinyint(1) の 0 / 1 を真偽値にする', () => {
    expect(convertValue('boolean', 1)).toBe(true);
    expect(convertValue('boolean', 0)).toBe(false);
    expect(() => convertValue('boolean', 2)).toThrow(ConversionError);
  });

  it('バイト列は Buffer のまま', () => {
    const b = Buffer.from([1, 2, 3]);
    expect(convertValue('bytea', b)).toBe(b);
    expect(() => convertValue('bytea', 'abc')).toThrow(ConversionError);
  });

  it('bigint unsigned は安全な範囲の number にする', () => {
    expect(convertValue('integer', 42)).toBe(42);
    expect(convertValue('integer', '42')).toBe(42);
    expect(() => convertValue('integer', '18446744073709551615')).toThrow(ConversionError);
    expect(() => convertValue('integer', 1.5)).toThrow(ConversionError);
  });

  it('文字列（enum を含む）は文字列のまま', () => {
    expect(convertValue('text', 'quick')).toBe('quick');
    expect(() => convertValue('text', 1)).toThrow(ConversionError);
  });
});

describe('convertRow', () => {
  const columns = [
    { name: 'id', kind: 'integer' },
    { name: 'createdAt', kind: 'timestamptz' },
  ] as const;

  it('列の順の値の配列にする', () => {
    expect(convertRow(columns, { id: 3, createdAt: '2026-01-02 03:04:05' })).toEqual([
      3,
      new Date('2026-01-02T03:04:05Z'),
    ]);
  });

  it('失敗した列の名前を付ける', () => {
    expect(() => convertRow(columns, { id: 3, createdAt: 'x' })).toThrow(/^createdAt: /);
  });

  it('読み取り結果に列が無ければ止める（undefined を null として黙って入れない）', () => {
    expect(() => convertRow(columns, { id: 3 })).toThrow(ConversionError);
  });
});

describe('rowKey', () => {
  it('PK の列を並べる', () => {
    expect(rowKey(['kifuId', 'side'], { kifuId: 3, side: 'sente', x: 1 })).toBe('kifuId=3,side=sente');
  });
});

describe('compareCounts', () => {
  it('一致すれば空', () => {
    expect(compareCounts({ kifus: 2, users: 1 }, { kifus: 2, users: 1 })).toEqual([]);
  });

  it('合わない表を並べる', () => {
    expect(compareCounts({ kifus: 2, users: 1 }, { kifus: 1, users: 1 })).toEqual([
      { table: 'kifus', source: 2, target: 1 },
    ]);
  });

  it('移行先に表の件数が無ければ不一致', () => {
    expect(compareCounts({ kifus: 0 }, {})).toHaveLength(1);
  });
});

describe('isUtcSessionZone', () => {
  it('UTC の表し方を受け、それ以外を弾く', () => {
    expect(isUtcSessionZone('+00:00')).toBe(true);
    expect(isUtcSessionZone('UTC')).toBe(true);
    expect(isUtcSessionZone('SYSTEM')).toBe(false);
    expect(isUtcSessionZone('+09:00')).toBe(false);
    expect(isUtcSessionZone(undefined)).toBe(false);
  });
});

describe('移す表の計画', () => {
  it('FK の順に並び、移さない表を含まない', () => {
    expect(MIGRATED_TABLES.map((t) => t.name)).toEqual([
      'users',
      'account',
      'user_aliases',
      'kifus',
      'video_kifu_sources',
      'move_analyses',
      'candidate_moves',
      'kifu_tactics',
      'drills',
      'drill_attempts',
    ]);
    expect(SKIPPED_TABLES).toEqual(['kifu_positions', 'session', 'verification']);
  });

  it('identity 列のある表を schema から拾う', () => {
    const identity = Object.fromEntries(MIGRATED_TABLES.map((t) => [t.name, t.identity]));
    expect(identity).toMatchObject({
      users: null,
      account: null,
      user_aliases: 'id',
      kifus: 'id',
      video_kifu_sources: null,
      move_analyses: 'id',
      candidate_moves: 'id',
      kifu_tactics: null,
      drills: 'id',
      drill_attempts: 'id',
    });
  });

  it('全列の型を変換の種類に対応づけられる', () => {
    const kifus = MIGRATED_TABLES.find((t) => t.name === 'kifus')!;
    expect(kifus.columns.find((c) => c.name === 'playedAt')?.kind).toBe('timestamptz');
    expect(kifus.columns.find((c) => c.name === 'usiMoves')?.kind).toBe('jsonb');
    expect(kifus.columns.find((c) => c.name === 'source')?.kind).toBe('text');
  });

  it('知らない型は黙って素通しにしない', () => {
    expect(() => kindOfSqlType('numeric(10,2)')).toThrow();
  });
});
