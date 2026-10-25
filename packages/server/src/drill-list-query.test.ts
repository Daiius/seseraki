import { describe, expect, it } from 'vitest';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';
import { drillAttempts, drills, kifus } from './db/schema.js';
import {
  ANSWER_COUNT,
  ATTEMPT_NO,
  LAST_ANSWERED_AT,
  LAST_VERDICT,
  drillAttemptOrderBy,
  drillListHaving,
  drillNextPlan,
  drillNextQuerySchema,
  drillStatusOf,
  isoOf,
  drillListOrderBy,
  drillListQuerySchema,
} from './drill-list-query.js';

const dialect = new PgDialect();

/** 組み立てた SQL を DB 接続なしで文字列化する */
function render(fragment: SQL | undefined) {
  if (!fragment) return { sql: '', params: [] as unknown[] };
  const { sql, params } = dialect.sqlToQuery(fragment);
  // Postgres の位置パラメータ（`$1`）を `?` に寄せて、期待値をパラメータの番号に依存させない
  return { sql: sql.replace(/\$\d+/g, '?'), params };
}

describe('drillListQuerySchema', () => {
  it('未指定は既定に落ちる（全件・除外は隠す）', () => {
    expect(drillListQuerySchema.parse({})).toEqual({ page: 1, status: 'all' });
  });

  it('page は数値に変換し、1 未満は弾く', () => {
    expect(drillListQuerySchema.parse({ page: '3' }).page).toBe(3);
    expect(drillListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('未知の値は弾く（URL 直入力）', () => {
    expect(drillListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(drillListQuerySchema.safeParse({ kind: 'tsume' }).success).toBe(false);
  });

  it('状態に excluded がある（旧 excluded=only を畳んだ。prd/13 §7.8）', () => {
    expect(drillListQuerySchema.parse({ status: 'excluded' }).status).toBe('excluded');
  });
});

describe('drillListHaving', () => {
  const parse = (q: Record<string, string>) => drillListQuerySchema.parse(q);

  it('既定では除外した問題を出さない', () => {
    const { sql } = render(drillListHaving(parse({})));
    expect(sql).toContain('"excluded"');
    expect(sql).toContain('= 0');
  });

  it('status=excluded は除外した問題だけに絞る', () => {
    const { sql } = render(drillListHaving(parse({ status: 'excluded' })));
    expect(sql).toContain('> 0');
    expect(sql).not.toContain('= 0');
  });

  it('status=unanswered は解答回数 0 の問題（諦めも解答として数える＝判定の有無で数える）', () => {
    const { sql } = render(drillListHaving(parse({ status: 'unanswered' })));
    expect(sql).toContain('"verdict" is not null');
    expect(sql).not.toContain('"move" is not null');
    expect(sql).toContain('= 0');
  });

  it('🔒 status=wrong は最後の判定が正解でない問題（一度でも正解したかではない。prd/13 §6.4）', () => {
    const { sql } = render(drillListHaving(parse({ status: 'wrong' })));
    expect(sql).toContain('array_agg');
    expect(sql).toContain("<> 'correct'");
  });

  it('status=correct は最後の判定が正解の問題', () => {
    const { sql } = render(drillListHaving(parse({ status: 'correct' })));
    expect(sql).toContain('array_agg');
    expect(sql).toContain("= 'correct'");
  });
});

describe('drillListOrderBy', () => {
  it('対局日降順 + id を副キーにする（出題順の並びは外した）', () => {
    const order = drillListOrderBy();
    expect(order).toHaveLength(2);
    expect(render(order[0]).sql).toContain('coalesce');
    expect(render(order[1]).sql).toContain('desc');
  });
});

describe('drillStatusOf', () => {
  it('最後の判定で読む（惜しいも間違えた側）', () => {
    expect(drillStatusOf(0, null)).toBe('unanswered');
    expect(drillStatusOf(2, 'correct')).toBe('correct');
    expect(drillStatusOf(2, 'close')).toBe('wrong');
    expect(drillStatusOf(1, 'wrong')).toBe('wrong');
  });
});

describe('drillNextQuerySchema', () => {
  it('既定はおすすめ', () => {
    expect(drillNextQuerySchema.parse({})).toEqual({ mode: 'recommend' });
  });

  it('since は日時として読み、読めない値は弾く', () => {
    expect(drillNextQuerySchema.parse({ since: '2026-10-23T00:00:00.000Z' }).since).toEqual(
      new Date('2026-10-23T00:00:00.000Z'),
    );
    expect(drillNextQuerySchema.safeParse({ since: 'yesterday' }).success).toBe(false);
    expect(drillNextQuerySchema.safeParse({ mode: 'all' }).success).toBe(false);
  });
});

describe('drillNextPlan（入口ごとの出題順。prd/13 §6.4）', () => {
  const plan = (q: Record<string, string>) => drillNextPlan(drillNextQuerySchema.parse(q));

  it('🔒 どの入口でも除外した問題を出さない', () => {
    for (const mode of ['recommend', 'mate', 'best', 'wrong']) {
      expect(render(plan({ mode }).having).sql).toContain('count(case when "drill_attempts"."excluded" then 1 end) = 0');
    }
  });

  it('詰将棋・次の一手はその種類の未解答だけ（ランダム）', () => {
    const mate = plan({ mode: 'mate' });
    expect(render(mate.where).params).toEqual(['mate']);
    expect(render(mate.having).sql).toContain('"verdict" is not null then 1 end) = 0');
    expect(mate.orderBy.map((o) => render(o).sql)).toEqual(['random()']);
  });

  it('間違えた問題は種類混在・最後の解答が古い順で、1 日の待ちを掛けない', () => {
    const wrong = plan({ mode: 'wrong' });
    expect(wrong.where).toBeUndefined();
    const having = render(wrong.having).sql;
    expect(having).toContain("<> 'correct'");
    expect(having).not.toContain("interval '1 day'");
    expect(render(wrong.orderBy[0]).sql).toContain('max(');
    expect(render(wrong.orderBy[0]).sql).toContain('asc');
  });

  it('おすすめは間違えた直後（1 日未満）を外し、段の順（間違えた → 直近 30 日の未解答 → 未解答 → 正解済み）', () => {
    const recommend = plan({ mode: 'recommend' });
    expect(render(recommend.having).sql).toContain("interval '1 day'");
    const tier = render(recommend.orderBy[0]).sql;
    expect(tier).toContain("interval '30 days'");
    expect(tier).toMatch(/then 0[\s\S]*then 1[\s\S]*then 2[\s\S]*else 3/);
    // ④だけ最後の解答が古い順、ほかはランダム
    expect(render(recommend.orderBy[1]).sql).toContain('asc');
    expect(render(recommend.orderBy[2]).sql).toBe('random()');
  });

  it('🔒 since を渡すとこの回に記録した問題を外す（除外だけの行は記録に数えない）', () => {
    const since = '2026-10-23T00:00:00.000Z';
    for (const mode of ['recommend', 'mate', 'best', 'wrong']) {
      const { sql, params } = render(plan({ mode, since }).having);
      expect(sql).toContain('"verdict" is not null and "drill_attempts"."created_at" >= ?');
      expect(params).toContain(since);
    }
    expect(render(plan({}).having).sql).not.toContain('>= ?');
  });
});

/**
 * 🔴 **選択リストに入れた状態で SQL を組み立てて見る**（実際に踏んだ）。
 * 断片だけを見るテストでは、**選択リストの中でだけ壊れる**種類の欠陥を捕まえられない
 * ——`alias()` したテーブルを `sql` テンプレートに差し込むと、選択リストでは
 * **別名だけが出力されて元のテーブル名が消え**、`Table 'prior' doesn't exist` で 500 になる。
 */
describe('選択リストの中で組み立てた SQL', () => {
  /** その問題の解答履歴（`listDrillAttemptsOf`）と同じ結合で組み立てる */
  function renderAttemptsSelect() {
    const query = new QueryBuilder()
      .select({ attemptNo: ATTEMPT_NO, createdAt: drillAttempts.createdAt })
      .from(drillAttempts)
      .innerJoin(drills, eq(drills.id, drillAttempts.drillId))
      .innerJoin(kifus, eq(kifus.id, drills.kifuId));
    return dialect.sqlToQuery(query.getSQL()).sql;
  }

  it('「何回目か」は副問い合わせの本体ごと出力される', () => {
    expect(renderAttemptsSelect()).toContain('select count(*) from "drill_attempts" "prior"');
  });

  it('相関の外側は必ず修飾する（内側の同名列に解決されると常に真になる）', () => {
    const sql = renderAttemptsSelect();
    expect(sql).toContain('"prior"."drill_id" = "drill_attempts"."drill_id"');
    expect(sql).toContain('"prior"."id" <= "drill_attempts"."id"');
    // 諦め（move が null・verdict あり）も数え、除外だけの行（verdict が null）は数えない
    expect(sql).toContain('"prior"."verdict" is not null');
  });

  it('一覧の集計は列をテーブルで修飾する（"created_at" は kifus にもある）', () => {
    const query = new QueryBuilder()
      .select({
        id: drills.id,
        kifuCreatedAt: kifus.createdAt,
        answers: ANSWER_COUNT,
        lastAnsweredAt: LAST_ANSWERED_AT,
        lastVerdict: LAST_VERDICT,
      })
      .from(drills)
      .innerJoin(kifus, eq(kifus.id, drills.kifuId))
      .leftJoin(drillAttempts, eq(drillAttempts.drillId, drills.id))
      .groupBy(drills.id, kifus.createdAt);
    const sql = dialect.sqlToQuery(query.getSQL()).sql;
    expect(sql).toContain('max(case when "drill_attempts"."verdict" is not null then "drill_attempts"."created_at" end)');
    expect(sql).toContain('count(case when "drill_attempts"."verdict" is not null then 1 end)');
    expect(sql).toContain(
      '(array_agg("drill_attempts"."verdict" order by "drill_attempts"."created_at" desc, "drill_attempts"."id" desc) filter (where "drill_attempts"."verdict" is not null))[1]',
    );
  });
});

describe('drillAttemptOrderBy', () => {
  it('新しい順で、同値は id 降順を副キーにする', () => {
    const order = drillAttemptOrderBy();
    expect(order).toHaveLength(2);
    expect(render(order[0]).sql).toContain('"created_at" desc');
    expect(render(order[1]).sql).toContain('"id" desc');
  });
});

describe('isoOf（集計 SQL が返す日時のデコード）', () => {
  // 🔴 `sql` 断片の戻り値には**列の日時変換が適用されない**（生の壁時計文字列が来る）。
  // DB セッションは UTC 固定（prd/03 §1.1）なので、UTC として読まないと
  // 実行環境の TZ（server は Asia/Tokyo）で解釈されて 9h ずれる（レビュー OCL-94744330）。
  it('タイムゾーンの無い DB 文字列を UTC として読む', () => {
    expect(isoOf('2026-09-10 12:00:00')).toBe('2026-09-10T12:00:00.000Z');
  });

  it('server の TZ に引きずられない', () => {
    // ⚠ ここが `new Date(value)` だと TZ=Asia/Tokyo で 03:00Z になっていた
    expect(isoOf('2026-09-10 12:00:00')).not.toBe('2026-09-10T03:00:00.000Z');
  });

  it('小数秒つきも読める', () => {
    expect(isoOf('2026-09-10 12:00:00.500')).toBe('2026-09-10T12:00:00.500Z');
  });

  it('既にオフセットが付いていれば尊重する', () => {
    expect(isoOf('2026-09-10T12:00:00+09:00')).toBe('2026-09-10T03:00:00.000Z');
  });

  it('Date で返ってきたらそのまま（ドライバ依存）', () => {
    expect(isoOf(new Date('2026-09-10T12:00:00Z'))).toBe('2026-09-10T12:00:00.000Z');
  });

  it('未解答は null', () => {
    expect(isoOf(null)).toBeNull();
  });
});
