/**
 * 🔒 ログインの経路のクエリ関数が**所有者の条件を付けて**問い合わせること（prd/14 §4）。
 *
 * DB には繋がない。drizzle に「問い合わせを記録して空の結果を返す」偽の接続を渡し、各関数が流した
 * SQL を見る。**棋譜系の表に触れる文はすべて、所有者（`owner_id` / 名前候補は `user_id`）を
 * 要求者の ID で縛っている**ことを確かめる。結果が空なので早く返る関数はその先の文を流さない——
 * 行が実在するときの分離（他人の行が見えない・消せない）は実 DB テスト（`owner-scope.db.test.ts`）が見る。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { parsePositionKey } from './positions.js';
import { relations } from './db/schema.js';
import type { Tx } from './db/index.js';
import {
  deleteKifu,
  getKifuDetail,
  listKifus,
  listVideoKifus,
  reanalyzeKifu,
  statsTactics,
  updateKifuMemo,
} from './kifu-queries.js';
import { kifuListQuerySchema } from './kifu-list-query.js';
import { statsTacticsQuerySchema } from './stats-tactics-query.js';
import {
  findPositionGames,
  findSimilarPositions,
  findSubjectGames,
  INITIAL_SFEN,
} from './position-queries.js';
import { findKifuPositionMatches } from './position-kifu-reuse.js';
import {
  drillCounts,
  listDrillAttempts,
  listDrills,
  loadDrill,
  loadDrillQuestion,
  pickNextDrill,
  unexcludeDrill,
} from './drill-query.js';
import { drillAttemptQuerySchema, drillListQuerySchema } from './drill-list-query.js';
import { countUnresolvedSubjects, removeAlias, updateAliasPeriod } from './users.js';

const ME = 'user-a';

interface Recorded {
  sql: string;
  params: unknown[];
}

/** 問い合わせを記録して空の結果を返す偽の接続の上の drizzle（tx の代わりに渡す） */
function recorder() {
  const recorded: Recorded[] = [];
  const client = {
    query(config: { text: string }, params: unknown[] = []) {
      recorded.push({ sql: config.text, params });
      return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
    },
  };
  const tx = drizzle({ client: client as never, relations }) as unknown as Tx;
  return { tx, recorded };
}

/** 所有者で縛るべき表（棋譜と子の表 6 つ・名前候補） */
const SCOPED = [
  'kifus',
  'kifu_analyses',
  'kifu_tactics',
  'kifu_positions',
  'video_kifu_sources',
  'drills',
  'drill_attempts',
  'user_aliases',
];

function touchesScoped(sql: string): boolean {
  return SCOPED.some((t) => sql.includes(`"${t}"`));
}

/** `"…"."owner_id" = $n`（名前候補は `user_id`）の $n に要求者の ID が入っているか */
function boundToOwner({ sql, params }: Recorded, owner: string): boolean {
  for (const m of sql.matchAll(/"(?:owner_id|user_id)" = \$(\d+)/g)) {
    if (params[Number(m[1]) - 1] === owner) return true;
  }
  return false;
}

const key = parsePositionKey(INITIAL_SFEN)!;

/** 調べる関数（各エンドポイントが使うもの） */
const CASES: [string, (tx: Tx) => Promise<unknown>][] = [
  ['listKifus', (tx) => listKifus(tx, ME, kifuListQuerySchema.parse({}))],
  ['getKifuDetail', (tx) => getKifuDetail(tx, ME, 1)],
  ['statsTactics', (tx) => statsTactics(tx, ME, statsTacticsQuerySchema.parse({}))],
  ['reanalyzeKifu', (tx) => reanalyzeKifu(tx, ME, 1)],
  ['deleteKifu', (tx) => deleteKifu(tx, ME, 1)],
  ['updateKifuMemo', (tx) => updateKifuMemo(tx, ME, 1, 'm')],
  ['listVideoKifus', (tx) => listVideoKifus(tx, ME)],
  ['findPositionGames', (tx) => findPositionGames(tx, ME, key)],
  ['findSubjectGames', (tx) => findSubjectGames(tx, ME, key, 'sente')],
  ['findSimilarPositions', (tx) => findSimilarPositions(tx, ME, key, { window: 4, limit: 20 })],
  ['findKifuPositionMatches（局面評価）', (tx) => findKifuPositionMatches(tx, ME, { sfen: INITIAL_SFEN, move: null })],
  ['findKifuPositionMatches（名指し評価）', (tx) => findKifuPositionMatches(tx, ME, { sfen: INITIAL_SFEN, move: '7g7f' })],
  ['pickNextDrill', (tx) => pickNextDrill(tx, ME)],
  ['loadDrill', (tx) => loadDrill(tx, ME, 1)],
  ['loadDrillQuestion', (tx) => loadDrillQuestion(tx, ME, 1)],
  ['drillCounts', (tx) => drillCounts(tx, ME)],
  ['listDrills', (tx) => listDrills(tx, ME, drillListQuerySchema.parse({}))],
  ['listDrillAttempts', (tx) => listDrillAttempts(tx, ME, drillAttemptQuerySchema.parse({}))],
  ['unexcludeDrill', (tx) => unexcludeDrill(tx, ME, 1)],
  ['updateAliasPeriod', (tx) => updateAliasPeriod(tx, ME, 1, { validFrom: null, validTo: null })],
  ['removeAlias', (tx) => removeAlias(tx, ME, 1)],
  ['countUnresolvedSubjects', (tx) => countUnresolvedSubjects(tx, ME)],
];

describe('所有者の条件（prd/14 §4）', () => {
  it.each(CASES)('%s: 棋譜系の表に触れる文はすべて要求者で縛る', async (_name, run) => {
    const { tx, recorded } = recorder();
    await run(tx);
    const scoped = recorded.filter((r) => touchesScoped(r.sql));
    expect(scoped.length).toBeGreaterThan(0);
    for (const statement of scoped) {
      expect({ sql: statement.sql, bound: boundToOwner(statement, ME) }).toEqual({
        sql: statement.sql,
        bound: true,
      });
    }
  });

  it('検査そのもの: 所有者で縛らない文を見逃さない', () => {
    expect(boundToOwner({ sql: 'select * from "kifus" where "kifus"."id" = $1', params: [1] }, ME)).toBe(false);
    expect(
      boundToOwner({ sql: 'select * from "kifus" where "kifus"."owner_id" = $1', params: ['other'] }, ME),
    ).toBe(false);
    expect(
      boundToOwner({ sql: 'select * from "kifus" where "kifus"."owner_id" = $1', params: [ME] }, ME),
    ).toBe(true);
  });
});
