import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { NON_SIDE_ATTRIBUTED_LABELS } from 'shared';
import {
  statsTacticsJoinOn,
  statsTacticsOrderBy,
  statsTacticsPeriodWhere,
  statsTacticsQuerySchema,
  statsTacticsRowsSelect,
  statsTacticsSummarySelect,
  statsTacticsWhere,
} from './stats-tactics-query.js';

const dialect = new MySqlDialect();

/** 組み立てた SQL を DB 接続なしで文字列化する（プレースホルダと値を両方見る） */
function render(fragment: SQL | undefined) {
  if (!fragment) return { sql: '', params: [] as unknown[] };
  const { sql, params } = dialect.sqlToQuery(fragment);
  return { sql, params };
}

/** クエリ文字列（`GET /api/stats/tactics` の query）を検証済みの値に通す */
function parse(query: Record<string, string> = {}) {
  return statsTacticsQuerySchema.parse(query);
}

const SELF = { self: 'me' };

describe('statsTacticsQuerySchema', () => {
  it('未指定なら全期間・詰み手数の上限 10（prd/09 §3.1）', () => {
    expect(parse()).toEqual({ mateMax: 10 });
  });

  it('詰み手数の上限は 1 以上の整数', () => {
    expect(parse({ mateMax: '5' }).mateMax).toBe(5);
    expect(statsTacticsQuerySchema.safeParse({ mateMax: '0' }).success).toBe(false);
    expect(statsTacticsQuerySchema.safeParse({ mateMax: '1.5' }).success).toBe(false);
  });

  it('日付は YYYY-MM-DD だけ受ける', () => {
    expect(parse({ from: '2026-07-01' }).from).toBe('2026-07-01');
    expect(statsTacticsQuerySchema.safeParse({ to: '2026/07/01' }).success).toBe(false);
  });
});

describe('statsTacticsPeriodWhere', () => {
  it('期間の指定が無ければ undefined（全期間）', () => {
    expect(statsTacticsPeriodWhere(parse(SELF))).toBeUndefined();
  });

  it('基準は一覧と同じ coalesce(playedAt, createdAt) で両端を含む', () => {
    const { sql, params } = render(
      statsTacticsPeriodWhere(parse({ ...SELF, from: '2026-07-01', to: '2026-07-31' })),
    );
    expect(sql).toContain('coalesce(`kifus`.`playedAt`, `kifus`.`createdAt`) >=');
    expect(sql).toContain('date_add(?, interval 1 day)');
    expect(params).toEqual(['2026-07-01', '2026-07-31']);
  });
});

describe('statsTacticsWhere', () => {
  it('対象局は「自分の側が確定」かつ「勝敗がついた」局に限る', () => {
    const { sql, params } = render(statsTacticsWhere(parse(SELF)));
    // 自分の側の確定 = 自分が一致し、相手は名前候補に一致しない（ambiguous を外す）
    expect(sql).toContain('not in');
    // 勝敗は勝者コードの部分一致。引き分け（DRAW_*）と result null はこれで落ちる
    expect(params).toEqual([
      'me', 'me', '%SENTE_WIN%', '%GOTE_WIN%',
      'me', 'me', '%GOTE_WIN%', '%SENTE_WIN%',
    ]);
    expect(sql).not.toContain('DRAW_');
  });

  it('期間は対象局の条件と AND で結合される', () => {
    const { params } = render(statsTacticsWhere(parse({ ...SELF, from: '2026-01-01' })));
    expect(params[0]).toBe('2026-01-01');
  });

  it('名前候補が空なら 0 件（自分が決まらなければ何も集計できない）', () => {
    expect(render(statsTacticsWhere(parse())).sql).toBe('1 = 0');
    expect(render(statsTacticsWhere(parse({ self: ' , ' }))).sql).toBe('1 = 0');
  });
});

describe('statsTacticsSummarySelect', () => {
  it('除外は 自分未確定 / 引き分け / 結果不明 の 3 つに分かれる', () => {
    const select = statsTacticsSummarySelect(parse(SELF));
    expect(Object.keys(select)).toEqual([
      'totalGames',
      'ambiguousSelf',
      'draw',
      'unknownResult',
    ]);

    // 自分未確定 = 側が確定する条件の否定（両者一致 / どちらも一致しない）
    expect(render(select.ambiguousSelf).sql).toContain('not (');
    // 引き分けは指し直しになるもの。勝敗として数えない（prd/09 §4）
    expect(render(select.draw).params).toEqual([
      'me', 'me', 'me', 'me', 'DRAW_REPETITION', 'DRAW_IMPASSE',
    ]);
    expect(render(select.unknownResult).sql).toContain('`result` is null');
  });

  it('行が無くても 0 になる（sum は null を返す）', () => {
    for (const fragment of Object.values(statsTacticsSummarySelect(parse(SELF)))) {
      expect(render(fragment).sql).toContain('coalesce(sum(');
    }
  });

  it('名前候補が空なら期間内の全局が自分未確定に落ちる', () => {
    const select = statsTacticsSummarySelect(parse());
    // 総局数は 0、引き分け・結果不明も 0 になり、`not (1 = 0)` だけが真になる
    expect(render(select.totalGames).sql).toContain('case when 1 = 0 then');
    expect(render(select.ambiguousSelf).sql).toContain('case when not (1 = 0) then');
    expect(render(select.draw).sql).toContain('(1 = 0) and');
    expect(render(select.unknownResult).sql).toContain('(1 = 0) and');
  });
});

describe('statsTacticsJoinOn', () => {
  it('手番固有ラベルは相手の側に立ったものを数える（主軸は「相手が何を採ったか」）', () => {
    const { sql, params } = render(statsTacticsJoinOn(parse(SELF)));
    expect(sql).toContain('`kifu_tactics`.`kifuId` = `kifus`.`id`');
    expect(sql).toContain('`kifu_tactics`.`side` =');
    // 自分が先手なら side=gote、自分が後手なら side=sente（相手の側）
    expect(params.slice(0, 3)).toEqual(['me', 'me', 'gote']);
    expect(params.slice(3, 6)).toEqual(['me', 'me', 'sente']);
  });

  it('帰属が side でないラベルは side を見ずに 1 行として数える', () => {
    const { sql, params } = render(statsTacticsJoinOn(parse(SELF)));
    // 一覧の絞り込みと同じく shared の公開 export から取る（配列を書き直さない。prd/09 §6.1）
    expect(params.slice(6)).toEqual([...NON_SIDE_ATTRIBUTED_LABELS]);
    expect(params.slice(6)).toContain('角換わり');
    expect(params.slice(6)).toContain('相掛かり');
    // side 条件との OR なので、これらのラベルは side に関係なく拾われる
    expect(sql).toContain('or (`kifu_tactics`.`label` in (');
  });

  it('生ラベルで数える（含意ラベルを畳む条件を持ち込まない）', () => {
    const { sql } = render(statsTacticsJoinOn(parse(SELF)));
    // `suppressForDisplay` 相当（turn の最小・含意の除外）は集計に持ち込まない（prd/09 §2.1）。
    // 石田流の局は 石田流 / 三間飛車 / 振り飛車 の 3 行すべてに乗る
    expect(sql).not.toContain('`turn`');
    expect(sql).not.toContain('not exists');
  });
});

describe('statsTacticsRowsSelect', () => {
  it('全体 / 先手時 / 後手時 を条件付き集計で 1 クエリに収める', () => {
    const select = statsTacticsRowsSelect(parse(SELF));
    expect(Object.keys(select)).toEqual([
      'label',
      'games',
      'wins',
      'senteGames',
      'senteWins',
      'goteGames',
      'goteWins',
      'analyzedLosses',
      'missedMateLosses',
    ]);
    expect(render(select.games).sql).toBe('count(*)');
    // 先手時は「自分が先手だった」だけを条件にする（自分が後手の行は数えない）
    expect(render(select.senteGames).params).toEqual(['me', 'me']);
    expect(render(select.senteWins).params).toEqual(['me', 'me', '%SENTE_WIN%']);
    expect(render(select.goteWins).params).toEqual(['me', 'me', '%GOTE_WIN%']);
    // 全体は両方の側の OR
    expect(render(select.wins).params).toEqual([
      'me', 'me', '%SENTE_WIN%', 'me', 'me', '%GOTE_WIN%',
    ]);
  });

  it('取りこぼしの分母は「解析済みの負け局」', () => {
    const select = statsTacticsRowsSelect(parse(SELF));
    const { sql, params } = render(select.analyzedLosses);
    // 失敗した棋譜は解析済みに数えない（一覧の status=analyzed と同じ述語）
    expect(sql).toContain('`analysisError` is null');
    expect(sql).toContain('`analysisCompletedAt` is not null');
    // 負け（自分が先手なら GOTE_WIN、後手なら SENTE_WIN）
    expect(params).toEqual([
      'me', 'me', '%GOTE_WIN%', 'me', 'me', '%SENTE_WIN%',
    ]);
    // ⚠ 「実手が詰みでない」の確認は不要（負けたことに含まれる。prd/09 §3.1）
    expect(sql).not.toContain('`candidate_moves`');
  });

  it('取りこぼしは自分の手番の parity（先手なら偶数・後手なら奇数）で見る', () => {
    const { sql, params } = render(
      statsTacticsRowsSelect(parse({ ...SELF, mateMax: '7' })).missedMateLosses,
    );
    expect(sql).toContain('mod(`move_analyses`.`moveNumber`, 2) =');
    expect(sql).toContain('exists (select 1 from `candidate_moves`');
    // 自分が先手: 負け = GOTE_WIN・parity 0・rank 1・mate・1..7
    expect(params.slice(0, 8)).toEqual(['me', 'me', '%GOTE_WIN%', 0, 1, 'mate', 1, 7]);
    // 自分が後手: 負け = SENTE_WIN・parity 1
    expect(params.slice(8)).toEqual(['me', 'me', '%SENTE_WIN%', 1, 1, 'mate', 1, 7]);
  });

  it('名前候補が空なら側に依存する列はすべて 0 件条件になる', () => {
    const select = statsTacticsRowsSelect(parse());
    for (const key of [
      'wins',
      'senteGames',
      'senteWins',
      'goteGames',
      'goteWins',
    ] as const) {
      expect(render(select[key]).sql).toContain('case when 1 = 0 then');
    }
  });
});

describe('statsTacticsOrderBy', () => {
  it('既定は局数降順・同数はラベル名で安定させる', () => {
    const keys = statsTacticsOrderBy();
    expect(keys).toHaveLength(2);
    expect(render(keys[0]).sql).toBe('count(*) desc');
    expect(render(keys[1]).sql).toBe('`kifu_tactics`.`label` asc');
  });
});
