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

// ⭐ 名前候補はもう受け取らない。主体側は kifus.subjectSide に導出済み（prd/11 §4）
const SELF: Record<string, string> = {};

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
  it('期間の指定が無くても動画解析は母集団から外れる（prd/10 §2.2）', () => {
    // 🔒 総局数と除外の内訳はこの母集団で数えるので、ここを外し忘れると
    // 動画解析が ambiguousSelf に積み上がって総局数が膨らむ
    const { sql, params } = render(statsTacticsPeriodWhere(parse(SELF)));
    expect(sql).toBe('`kifus`.`source` <> ?');
    expect(params).toEqual(['video']);
  });

  it('基準は一覧と同じ coalesce(playedAt, createdAt) で両端を含む', () => {
    const { sql, params } = render(
      statsTacticsPeriodWhere(parse({ ...SELF, from: '2026-07-01', to: '2026-07-31' })),
    );
    expect(sql).toContain('coalesce(`kifus`.`playedAt`, `kifus`.`createdAt`) >=');
    expect(sql).toContain('date_add(?, interval 1 day)');
    expect(params).toEqual(['video', '2026-07-01', '2026-07-31']);
  });
});

describe('statsTacticsWhere', () => {
  it('対象局は「自分の側が確定」かつ「勝敗がついた」局に限る', () => {
    const { sql, params } = render(statsTacticsWhere(parse(SELF)));
    // ⭐ 自分の側は kifus.subjectSide に導出済み（prd/11 §4）。名前候補は SQL に出てこない
    expect(sql).toContain('`kifus`.`subjectSide` = ?');
    // 勝敗は勝者コードの部分一致。引き分け（DRAW_*）と result null はこれで落ちる
    expect(params).toEqual([
      'video',
      'sente', '%SENTE_WIN%', '%GOTE_WIN%',
      'gote', '%GOTE_WIN%', '%SENTE_WIN%',
    ]);
    expect(sql).not.toContain('DRAW_');
  });

  it('期間は対象局の条件と AND で結合される', () => {
    const { params } = render(statsTacticsWhere(parse({ ...SELF, from: '2026-01-01' })));
    expect(params[0]).toBe('video');
    expect(params[1]).toBe('2026-01-01');
  });

  it('⭐ 主体側で絞る（名前候補が無ければ subjectSide が NULL になり自然に 0 件）', () => {
    const { sql } = render(statsTacticsWhere(parse()));
    expect(sql).toContain('`kifus`.`subjectSide` = ?');
    expect(sql).not.toContain('1 = 0');
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
      'sente', 'gote', 'DRAW_REPETITION', 'DRAW_IMPASSE',
    ]);
    expect(render(select.unknownResult).sql).toContain('`result` is null');
  });

  it('行が無くても 0 になる（sum は null を返す）', () => {
    for (const fragment of Object.values(statsTacticsSummarySelect(parse(SELF)))) {
      expect(render(fragment).sql).toContain('coalesce(sum(');
    }
  });

  it('主体側が決まらない局は「自分未確定」に落ちる', () => {
    const select = statsTacticsSummarySelect(parse());
    // ⭐ どの列も subjectSide で絞る。名前候補は現れない（prd/11 §4）
    for (const fragment of Object.values(select)) {
      expect(render(fragment).sql).toContain('`kifus`.`subjectSide` = ?');
      expect(render(fragment).sql).not.toContain('1 = 0');
    }
  });
});

describe('statsTacticsJoinOn', () => {
  it('手番固有ラベルは相手の側に立ったものを数える（主軸は「相手が何を採ったか」）', () => {
    const { sql, params } = render(statsTacticsJoinOn(parse(SELF)));
    expect(sql).toContain('`kifu_tactics`.`kifuId` = `kifus`.`id`');
    expect(sql).toContain('`kifu_tactics`.`side` =');
    // 自分が先手なら side=gote、自分が後手なら side=sente（相手の側）
    // 主体が先手の局では相手（gote）側のラベル、後手の局では sente 側のラベルを数える
    expect(params.slice(0, 2)).toEqual(['sente', 'gote']);
    expect(params.slice(2, 4)).toEqual(['gote', 'sente']);
  });

  it('帰属が side でないラベルは side を見ずに 1 行として数える', () => {
    const { sql, params } = render(statsTacticsJoinOn(parse(SELF)));
    // 一覧の絞り込みと同じく shared の公開 export から取る（配列を書き直さない。prd/09 §6.1）
    expect(params.slice(4)).toEqual([...NON_SIDE_ATTRIBUTED_LABELS]);
    expect(params.slice(4)).toContain('角換わり');
    expect(params.slice(4)).toContain('相掛かり');
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
    expect(render(select.senteGames).params).toEqual(['sente']);
    expect(render(select.senteWins).params).toEqual(['sente', '%SENTE_WIN%']);
    expect(render(select.goteWins).params).toEqual(['gote', '%GOTE_WIN%']);
    // 全体は両方の側の OR
    expect(render(select.wins).params).toEqual([
      'sente', '%SENTE_WIN%', 'gote', '%GOTE_WIN%',
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
      'sente', '%GOTE_WIN%', 'gote', '%SENTE_WIN%',
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
    expect(params.slice(0, 7)).toEqual(['sente', '%GOTE_WIN%', 0, 1, 'mate', 1, 7]);
    // 自分が後手: 負け = SENTE_WIN・parity 1
    expect(params.slice(7)).toEqual(['gote', '%SENTE_WIN%', 1, 1, 'mate', 1, 7]);
  });

  it('⭐ 側に依存する列は subjectSide で絞る（名前候補は現れない）', () => {
    const select = statsTacticsRowsSelect(parse());
    for (const key of [
      'wins',
      'senteGames',
      'senteWins',
      'goteGames',
      'goteWins',
    ] as const) {
      // ⭐ 名前候補ではなく主体側で絞る。名前が未設定なら subjectSide が NULL に
      // なるので、条件に合う行が無く自然に 0 件になる（prd/11 §4）
      expect(render(select[key]).sql).toContain('`kifus`.`subjectSide` = ?');
      expect(render(select[key]).sql).not.toContain('1 = 0');
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
