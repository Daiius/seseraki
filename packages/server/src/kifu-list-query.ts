// 棋譜一覧（`GET /api/kifus`）の検索・絞り込み・並べ替え。
// DB 接続を持たない純粋な組み立てのみを置き、route.ts から使う（テスト可能に保つため）。
import {
  and,
  asc,
  desc,
  inArray,
  isNotNull,
  isNull,
  like,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { kifus } from './db/schema.js';

/** 一覧の基準日時。表示・並びとも `coalesce(playedAt, createdAt)`（prd/04 §6.1） */
export const playedOrCreatedAt = sql`coalesce(${kifus.playedAt}, ${kifus.createdAt})`;

/** LIKE のワイルドカード（`%` `_` `\`）を打ち消し、入力を素の部分一致として扱う */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const kifuListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  /** タイトル・対局者名の部分一致 */
  q: z.string().trim().max(100).optional(),
  /** 解析状態。一覧のバッジ（失敗 / 済 / 未）と同じ区分 */
  status: z.enum(['all', 'analyzed', 'unanalyzed', 'failed']).default('all'),
  /** 自分から見た勝敗 */
  outcome: z.enum(['all', 'win', 'loss']).default('all'),
  // 自分の名前候補（カンマ区切り）。「自分」の定義は web の
  // `VITE_SELF_NAMES` ∪ `VITE_SWARS_USER_ID` が単一の正なので、server は設定を持たず
  // 勝敗条件を組み立てるためだけに受け取る（prd/01 §3 対局のメタ情報）
  self: z.string().optional(),
  /** 期間の下限・上限（`YYYY-MM-DD`・両端を含む）。基準は `playedOrCreatedAt` */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(['playedAt', 'createdAt', 'title']).default('playedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type KifuListQuery = z.infer<typeof kifuListQuerySchema>;

/** カンマ区切りの名前候補を正規化する（空要素・重複を除く） */
function parseSelfNames(self: string | undefined): string[] {
  return [
    ...new Set(
      (self ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * 勝敗の絞り込み条件。両対局者とも自分の名前候補に一致する対局は側を確定できないため
 * 除外する（web の `resolveUserSide` が ambiguous として勝敗バッジを出さないのと同じ扱い）。
 */
function outcomeCondition(
  outcome: Exclude<KifuListQuery['outcome'], 'all'>,
  names: string[],
): SQL {
  // 自分を特定できなければ勝敗も決まらない。全件返すと絞り込みの意味が変わるので 0 件にする
  if (names.length === 0) return sql`1 = 0`;
  const selfIsSente = and(
    inArray(kifus.sente, names),
    or(isNull(kifus.gote), notInArray(kifus.gote, names)),
  )!;
  const selfIsGote = and(
    inArray(kifus.gote, names),
    or(isNull(kifus.sente), notInArray(kifus.sente, names)),
  )!;
  // 結果コードは `SENTE_WIN_RESIGN` 等（prd/01 §3）。一覧のバッジと同じ部分一致で判定する
  const senteWin = like(kifus.result, '%SENTE_WIN%');
  const goteWin = like(kifus.result, '%GOTE_WIN%');
  return outcome === 'win'
    ? or(and(selfIsSente, senteWin), and(selfIsGote, goteWin))!
    : or(and(selfIsSente, goteWin), and(selfIsGote, senteWin))!;
}

/** 絞り込み条件を組み立てる（件数取得と行取得で同じものを使う）。無条件なら `undefined` */
export function kifuListWhere(query: KifuListQuery): SQL | undefined {
  const conditions: SQL[] = [];

  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(
      or(
        like(kifus.title, pattern),
        like(kifus.sente, pattern),
        like(kifus.gote, pattern),
      )!,
    );
  }

  if (query.status === 'failed') {
    conditions.push(isNotNull(kifus.analysisError));
  } else if (query.status === 'analyzed') {
    conditions.push(
      and(isNull(kifus.analysisError), isNotNull(kifus.analysisCompletedAt))!,
    );
  } else if (query.status === 'unanalyzed') {
    conditions.push(
      and(isNull(kifus.analysisError), isNull(kifus.analysisCompletedAt))!,
    );
  }

  if (query.outcome !== 'all') {
    conditions.push(outcomeCondition(query.outcome, parseSelfNames(query.self)));
  }

  // 日付の境界は DB セッションのタイムゾーンで解釈される（playedAt の保存と同じ基準）。
  // `to` は指定日を含めたいので「翌日 0 時未満」とする
  if (query.from) conditions.push(sql`${playedOrCreatedAt} >= ${query.from}`);
  if (query.to) {
    conditions.push(
      sql`${playedOrCreatedAt} < date_add(${query.to}, interval 1 day)`,
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** 並べ替え。同値が並んでもページ間で行が重複・欠落しないよう id を副キーに添える */
export function kifuListOrderBy(query: KifuListQuery): SQL[] {
  const key =
    query.sort === 'title'
      ? kifus.title
      : query.sort === 'createdAt'
        ? kifus.createdAt
        : playedOrCreatedAt;
  const direction = query.order === 'asc' ? asc : desc;
  return [direction(key), direction(kifus.id)];
}
