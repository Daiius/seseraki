import { describe, expect, it } from 'vitest';
import { MySqlDialect, QueryBuilder } from 'drizzle-orm/mysql-core';
import { eq, type SQL } from 'drizzle-orm';
import { drillAttempts, drills, kifus } from './db/schema.js';
import {
  ANSWER_COUNT,
  ATTEMPT_NO,
  LAST_ANSWERED_AT,
  drillAttemptOrderBy,
  drillAttemptQuerySchema,
  drillAttemptWhere,
  drillListHaving,
  drillListOrderBy,
  drillListQuerySchema,
} from './drill-list-query.js';

const dialect = new MySqlDialect();

/** 組み立てた SQL を DB 接続なしで文字列化する */
function render(fragment: SQL | undefined) {
  if (!fragment) return { sql: '', params: [] as unknown[] };
  const { sql, params } = dialect.sqlToQuery(fragment);
  return { sql, params };
}

describe('drillListQuerySchema', () => {
  it('未指定は既定に落ちる（対局日降順・除外は隠す・全件）', () => {
    expect(drillListQuerySchema.parse({})).toEqual({
      page: 1,
      status: 'all',
      excluded: 'hide',
      sort: 'played',
    });
  });

  it('page は数値に変換し、1 未満は弾く', () => {
    expect(drillListQuerySchema.parse({ page: '3' }).page).toBe(3);
    expect(drillListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('未知の値は弾く（URL 直入力）', () => {
    expect(drillListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(drillListQuerySchema.safeParse({ kind: 'tsume' }).success).toBe(false);
  });
});

describe('drillListHaving', () => {
  const parse = (q: Record<string, string>) => drillListQuerySchema.parse(q);

  it('既定では除外した問題を出さない', () => {
    const { sql } = render(drillListHaving(parse({})));
    expect(sql).toContain('`excluded`');
    expect(sql).toContain('= 0');
  });

  it('excluded=only は除外した問題だけに絞る', () => {
    const { sql } = render(drillListHaving(parse({ excluded: 'only' })));
    expect(sql).toContain('> 0');
  });

  it('status=unanswered は解答回数 0 の問題', () => {
    const { sql } = render(drillListHaving(parse({ status: 'unanswered' })));
    expect(sql).toContain('`move` is not null');
    expect(sql).toContain('= 0');
  });

  it('status=wrong は「解答済みだがまだ正解していない」', () => {
    const { sql } = render(drillListHaving(parse({ status: 'wrong' })));
    expect(sql).toContain('> 0');
    expect(sql).toContain("'correct'");
  });

  it('status=correct は正解した問題', () => {
    const { sql } = render(drillListHaving(parse({ status: 'correct' })));
    expect(sql).toContain("'correct'");
    expect(sql).toContain('> 0');
  });
});

describe('drillListOrderBy', () => {
  it('既定は対局日降順 + id を副キーにする', () => {
    const order = drillListOrderBy(drillListQuerySchema.parse({}));
    expect(order).toHaveLength(2);
    expect(render(order[0]).sql).toContain('coalesce');
    expect(render(order[1]).sql).toContain('desc');
  });

  it('sort=status は出題順の段を先頭に置く', () => {
    const order = drillListOrderBy(drillListQuerySchema.parse({ sort: 'status' }));
    expect(order).toHaveLength(3);
    expect(render(order[0]).sql).toContain('case');
  });
});

describe('drillAttemptWhere', () => {
  const parse = (q: Record<string, string>) => drillAttemptQuerySchema.parse(q);

  it('既定は所有者だけで絞る（除外の行も含む）', () => {
    const { sql, params } = render(drillAttemptWhere(7, parse({})));
    expect(sql).toContain('`ownerId`');
    expect(params).toEqual([7]);
  });

  it('verdict=excluded は「自明だった」の行', () => {
    const { sql, params } = render(drillAttemptWhere(7, parse({ verdict: 'excluded' })));
    expect(sql).toContain('`excluded`');
    expect(params).toEqual([7, true]);
  });

  it('verdict=correct は解答の行だけ（除外だけの行を混ぜない）', () => {
    const { sql, params } = render(drillAttemptWhere(7, parse({ verdict: 'correct' })));
    expect(sql).toContain('`move` is not null');
    expect(params).toEqual([7, 'correct']);
  });

  it('kind は出題の種類で絞る', () => {
    const { params } = render(drillAttemptWhere(7, parse({ kind: 'mate' })));
    expect(params).toEqual([7, 'mate']);
  });
});

/**
 * 🔴 **選択リストに入れた状態で SQL を組み立てて見る**（実際に踏んだ）。
 * 断片だけを見るテストでは、**選択リストの中でだけ壊れる**種類の欠陥を捕まえられない
 * ——`alias()` したテーブルを `sql` テンプレートに差し込むと、選択リストでは
 * **別名だけが出力されて元のテーブル名が消え**、`Table 'prior' doesn't exist` で 500 になる。
 */
describe('選択リストの中で組み立てた SQL', () => {
  /** 履歴の一覧（`listDrillAttempts`）と同じ結合で組み立てる */
  function renderAttemptsSelect() {
    const query = new QueryBuilder()
      .select({ attemptNo: ATTEMPT_NO, createdAt: drillAttempts.createdAt })
      .from(drillAttempts)
      .innerJoin(drills, eq(drills.id, drillAttempts.drillId))
      .innerJoin(kifus, eq(kifus.id, drills.kifuId));
    return dialect.sqlToQuery(query.getSQL()).sql;
  }

  it('「何回目か」は副問い合わせの本体ごと出力される', () => {
    expect(renderAttemptsSelect()).toContain('select count(*) from `drill_attempts` `prior`');
  });

  it('相関の外側は必ず修飾する（内側の同名列に解決されると常に真になる）', () => {
    const sql = renderAttemptsSelect();
    expect(sql).toContain('`prior`.`drillId` = `drill_attempts`.`drillId`');
    expect(sql).toContain('`prior`.`id` <= `drill_attempts`.`id`');
    expect(sql).toContain('`prior`.`move` is not null');
  });

  it('一覧の集計は列をテーブルで修飾する（`createdAt` は kifus にもある）', () => {
    const query = new QueryBuilder()
      .select({
        id: drills.id,
        kifuCreatedAt: kifus.createdAt,
        answers: ANSWER_COUNT,
        lastAnsweredAt: LAST_ANSWERED_AT,
      })
      .from(drills)
      .innerJoin(kifus, eq(kifus.id, drills.kifuId))
      .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
      .groupBy(drills.id, kifus.createdAt);
    const sql = dialect.sqlToQuery(query.getSQL()).sql;
    expect(sql).toContain('max(case when `drill_attempts`.`move` is not null then `drill_attempts`.`createdAt` end)');
  });
});

describe('drillAttemptOrderBy', () => {
  it('新しい順で、同値は id 降順を副キーにする', () => {
    const order = drillAttemptOrderBy();
    expect(order).toHaveLength(2);
    expect(render(order[0]).sql).toContain('`createdAt` desc');
    expect(render(order[1]).sql).toContain('`id` desc');
  });
});
