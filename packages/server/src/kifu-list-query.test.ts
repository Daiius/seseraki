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

/**
 * 一覧は**常に**動画解析を外す（prd/10 §2.2）ので、どの条件でも params の先頭はこれになる。
 * 各テストが期待値の先頭にこれを置いているのは、条件が本当に固定されていることを示すため。
 */
const OWN = 'video';

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
      tacticSide: 'any',
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

  it('戦型は 32 字まで（kifuTactics.label と同じ上限）', () => {
    expect(parse({ tactic: ' 四間飛車 ' }).tactic).toBe('四間飛車');
    expect(kifuListQuerySchema.safeParse({ tactic: 'あ'.repeat(33) }).success).toBe(false);
    expect(kifuListQuerySchema.safeParse({ tacticSide: 'both' }).success).toBe(false);
  });

  it('取りこぼしの手数は 1 以上の整数', () => {
    expect(parse({ missedMate: '10' }).missedMate).toBe(10);
    expect(kifuListQuerySchema.safeParse({ missedMate: '0' }).success).toBe(false);
    expect(kifuListQuerySchema.safeParse({ missedMate: '1.5' }).success).toBe(false);
  });
});

describe('kifuListWhere', () => {
  it('無条件でも動画解析だけは外れる（prd/10 §2.2）', () => {
    const { sql, params } = render(kifuListWhere(parse({})));
    expect(sql).toBe('`kifus`.`source` <> ?');
    expect(params).toEqual([OWN]);
  });

  it('どの絞り込みでも動画解析の除外は落ちない', () => {
    // 🔒 引数で外せる条件にしていないこと（トグルにすると集計の意味が UI 状態に依存する）
    const queries: Record<string, string>[] = [
      {},
      { q: '羽生' },
      { status: 'analyzed' },
      { outcome: 'win', self: 'me' },
      { tactic: '四間飛車' },
      { from: '2026-07-01' },
      { missedMate: '10', self: 'me' },
    ];
    for (const query of queries) {
      const { sql } = render(kifuListWhere(parse(query)));
      expect(sql).toContain('`kifus`.`source` <> ?');
    }
  });

  it('検索語はタイトル・先手・後手の部分一致になり、ワイルドカードは無効化される', () => {
    const { sql, params } = render(kifuListWhere(parse({ q: '50%' })));
    expect(sql).toContain('`title` like');
    expect(sql).toContain('`sente` like');
    expect(sql).toContain('`gote` like');
    expect(params).toEqual([OWN, '%50\\%%', '%50\\%%', '%50\\%%']);
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

  it('decided は勝ちと負けの両方を含む（分析ページの対象局と同じ母集団）', () => {
    const decided = render(kifuListWhere(parse({ outcome: 'decided', self: 'me' })));
    const win = render(kifuListWhere(parse({ outcome: 'win', self: 'me' })));
    // 勝者コードは先手側・後手側それぞれに 2 つずつ現れる（勝ち条件の 2 倍）
    expect(decided.params.filter((p) => p === '%SENTE_WIN%')).toHaveLength(2);
    expect(decided.params.filter((p) => p === '%GOTE_WIN%')).toHaveLength(2);
    expect(win.params.filter((p) => p === '%SENTE_WIN%')).toHaveLength(1);
    // 側を確定できない対局を外す条件は勝ち負けと同じものを通る
    expect(decided.sql).toContain('not in');
  });

  it('自分の名前候補が無ければ勝敗では 0 件にする', () => {
    expect(render(kifuListWhere(parse({ outcome: 'win' }))).sql).toContain('1 = 0');
    expect(render(kifuListWhere(parse({ outcome: 'win', self: ' , ' }))).sql).toContain(
      '1 = 0',
    );
  });

  it('期間は coalesce(playedAt, createdAt) を基準に両端を含む', () => {
    const { sql, params } = render(
      kifuListWhere(parse({ from: '2026-07-01', to: '2026-07-31' })),
    );
    expect(sql).toContain('coalesce(`kifus`.`playedAt`, `kifus`.`createdAt`) >=');
    // 終了日を含めるため「翌日 0 時未満」で切る
    expect(sql).toContain('date_add(?, interval 1 day)');
    expect(params).toEqual([OWN, '2026-07-01', '2026-07-31']);
  });

  it('戦型は kifu_tactics への相関 EXISTS になる（JOIN しない）', () => {
    const { sql, params } = render(kifuListWhere(parse({ tactic: '四間飛車' })));
    expect(sql).toContain('exists (select 1 from `kifu_tactics`');
    expect(sql).toContain('`kifu_tactics`.`kifuId` = `kifus`.`id`');
    // JOIN すると count() と LIMIT/OFFSET が壊れる（prd/03 §2.1.1・prd/04 §6.1）
    expect(sql).not.toContain('join');
    expect(params).toEqual([OWN, '四間飛車']);
    // 既定（tacticSide=any）では side を見ないので自分の名前候補も要らない
    expect(sql).not.toContain('`kifu_tactics`.`side`');
  });

  it('自分 / 相手で絞ると side が自分の側・相手の側になる', () => {
    const self = render(kifuListWhere(parse({ tactic: '四間飛車', tacticSide: 'self', self: 'me' })));
    expect(self.sql).toContain('`kifu_tactics`.`side` =');
    // 先手が自分なら side=sente、後手が自分なら side=gote を見る
    expect(self.params).toEqual([
      OWN, 'me', 'me', '四間飛車', 'sente', 'me', 'me', '四間飛車', 'gote',
    ]);

    const opponent = render(
      kifuListWhere(parse({ tactic: '四間飛車', tacticSide: 'opponent', self: 'me' })),
    );
    expect(opponent.sql).toBe(self.sql);
    expect(opponent.params).toEqual([
      OWN, 'me', 'me', '四間飛車', 'gote', 'me', 'me', '四間飛車', 'sente',
    ]);
  });

  it('帰属が side でないラベルは tacticSide を指定しても side を見ない', () => {
    // 角換わり（きっかけ帰属）・相掛かり（対局帰属）は side の意味が違う（prd/09 §6.1）
    for (const tactic of ['角換わり', '相掛かり']) {
      const { sql, params } = render(
        kifuListWhere(parse({ tactic, tacticSide: 'self', self: 'me' })),
      );
      expect(sql).not.toContain('`kifu_tactics`.`side`');
      expect(params).toEqual([OWN, tactic]);
    }
  });

  it('自分の名前候補が無ければ側を要する戦型の絞り込みは 0 件にする', () => {
    expect(
      render(kifuListWhere(parse({ tactic: '四間飛車', tacticSide: 'self' }))).sql,
    ).toContain('1 = 0');
    expect(render(kifuListWhere(parse({ missedMate: '10' }))).sql).toContain('1 = 0');
  });

  it('取りこぼしは「自分の手番の rank=1 の詰み」かつ「負け」で絞る', () => {
    const { sql, params } = render(kifuListWhere(parse({ missedMate: '10', self: 'me' })));
    expect(sql).toContain('exists (select 1 from `move_analyses`');
    expect(sql).toContain('exists (select 1 from `candidate_moves`');
    // 自分の手番は moveNumber の parity（先手なら偶数・後手なら奇数。prd/03 §2.3）
    expect(sql).toContain('mod(`move_analyses`.`moveNumber`, 2) =');
    expect(params[0]).toBe(OWN);
    expect(params.slice(1, 9)).toEqual(['me', 'me', '%GOTE_WIN%', 0, 1, 'mate', 1, 10]);
    // ⚠ 負け条件を内包する（outcome=loss を別途付ける必要はない。prd/09 §3.1）
    expect(params.slice(9)).toEqual(['me', 'me', '%SENTE_WIN%', 1, 1, 'mate', 1, 10]);
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
