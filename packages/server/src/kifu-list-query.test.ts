import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import {
  escapeLike,
  kifuListOrderBy,
  kifuListQuerySchema,
  kifuListWhere,
} from './kifu-list-query.js';

const dialect = new MySqlDialect();

/** 組み立てた SQL を DB 接続なしで文字列化する（プレースホルダと値を両方見る） */
function render(fragment: SQL | undefined) {
  if (!fragment) return { sql: '', params: [] as unknown[] };
  const { sql, params } = dialect.sqlToQuery(fragment);
  return { sql, params };
}

/** クエリ文字列（`GET /api/kifus` の query）を検証済みの値に通す */
function parse(query: Record<string, string>) {
  return kifuListQuerySchema.parse(query);
}

describe('escapeLike', () => {
  it('ワイルドカードを打ち消す', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('通常の文字はそのまま', () => {
    expect(escapeLike('山田 太郎')).toBe('山田 太郎');
  });
});

describe('kifuListQuerySchema', () => {
  it('未指定なら既定値（1ページ目・全件・対局日時の降順）', () => {
    expect(parse({})).toEqual({
      page: 1,
      status: 'all',
      outcome: 'all',
      sort: 'playedAt',
      order: 'desc',
    });
  });

  it('検索語の前後の空白は落とす', () => {
    expect(parse({ q: '  羽生  ' }).q).toBe('羽生');
  });

  it('許可外の値は弾く', () => {
    expect(kifuListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(kifuListQuerySchema.safeParse({ sort: 'result' }).success).toBe(false);
    expect(kifuListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('日付は YYYY-MM-DD だけ受ける', () => {
    expect(parse({ from: '2026-07-01' }).from).toBe('2026-07-01');
    expect(kifuListQuerySchema.safeParse({ from: '2026/07/01' }).success).toBe(false);
  });
});

describe('kifuListWhere', () => {
  it('無条件なら undefined（従来どおり全件）', () => {
    expect(kifuListWhere(parse({}))).toBeUndefined();
  });

  it('検索語はタイトル・先手・後手の部分一致になり、ワイルドカードは無効化される', () => {
    const { sql, params } = render(kifuListWhere(parse({ q: '50%' })));
    expect(sql).toContain('`title` like');
    expect(sql).toContain('`sente` like');
    expect(sql).toContain('`gote` like');
    expect(params).toEqual(['%50\\%%', '%50\\%%', '%50\\%%']);
  });

  it('解析状態は一覧のバッジと同じ区分で分かれる', () => {
    expect(render(kifuListWhere(parse({ status: 'failed' }))).sql).toContain(
      '`analysisError` is not null',
    );
    expect(render(kifuListWhere(parse({ status: 'analyzed' }))).sql).toContain(
      '`analysisCompletedAt` is not null',
    );
    expect(render(kifuListWhere(parse({ status: 'unanalyzed' }))).sql).toContain(
      '`analysisCompletedAt` is null',
    );
    // 失敗した棋譜は「済」にも「未」にも数えない
    expect(render(kifuListWhere(parse({ status: 'analyzed' }))).sql).toContain(
      '`analysisError` is null',
    );
    expect(render(kifuListWhere(parse({ status: 'unanalyzed' }))).sql).toContain(
      '`analysisError` is null',
    );
  });

  it('勝ちは自分の側と勝者コードの組み合わせで絞る', () => {
    const { sql, params } = render(
      kifuListWhere(parse({ outcome: 'win', self: 'Daiius,daiius' })),
    );
    expect(params).toContain('%SENTE_WIN%');
    expect(params).toContain('%GOTE_WIN%');
    // 相手も自分の名前候補に一致する対局（側を確定できない）は除外する
    expect(sql).toContain('not in');
    expect(params.filter((p) => p === 'Daiius')).toHaveLength(4);
  });

  it('負けは勝ちと勝者コードの対応が逆になる', () => {
    const win = render(kifuListWhere(parse({ outcome: 'win', self: 'me' })));
    const loss = render(kifuListWhere(parse({ outcome: 'loss', self: 'me' })));
    expect(loss.sql).toBe(win.sql);
    // 先手側 / 後手側それぞれに割り当てる勝者コードが入れ替わる
    expect(loss.params).not.toEqual(win.params);
    expect(loss.params.slice().sort()).toEqual(win.params.slice().sort());
  });

  it('自分の名前候補が無ければ勝敗では 0 件にする', () => {
    expect(render(kifuListWhere(parse({ outcome: 'win' }))).sql).toBe('1 = 0');
    expect(render(kifuListWhere(parse({ outcome: 'win', self: ' , ' }))).sql).toBe('1 = 0');
  });

  it('期間は coalesce(playedAt, createdAt) を基準に両端を含む', () => {
    const { sql, params } = render(
      kifuListWhere(parse({ from: '2026-07-01', to: '2026-07-31' })),
    );
    expect(sql).toContain('coalesce(`kifus`.`playedAt`, `kifus`.`createdAt`) >=');
    // 終了日を含めるため「翌日 0 時未満」で切る
    expect(sql).toContain('date_add(?, interval 1 day)');
    expect(params).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('複数の条件は AND で結合される', () => {
    const { sql } = render(
      kifuListWhere(parse({ q: '羽生', status: 'analyzed', from: '2026-01-01' })),
    );
    expect(sql.split(' and ').length).toBeGreaterThan(2);
  });
});

describe('kifuListOrderBy', () => {
  it('既定は対局日時（無ければ登録日時）の降順', () => {
    const [primary] = kifuListOrderBy(parse({}));
    expect(render(primary).sql).toBe(
      'coalesce(`kifus`.`playedAt`, `kifus`.`createdAt`) desc',
    );
  });

  it('基準と向きを切り替えられる', () => {
    expect(render(kifuListOrderBy(parse({ sort: 'title', order: 'asc' }))[0]).sql).toBe(
      '`kifus`.`title` asc',
    );
    expect(render(kifuListOrderBy(parse({ sort: 'createdAt' }))[0]).sql).toBe(
      '`kifus`.`createdAt` desc',
    );
  });

  it('id を副キーに添えてページ間の重複・欠落を防ぐ', () => {
    const keys = kifuListOrderBy(parse({ order: 'asc' }));
    expect(keys).toHaveLength(2);
    expect(render(keys[1]).sql).toBe('`kifus`.`id` asc');
  });
});
