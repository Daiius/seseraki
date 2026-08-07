// 棋譜一覧（`GET /api/kifus`）の検索・絞り込み・並べ替え。
// DB 接続を持たない純粋な組み立てのみを置き、route.ts から使う（テスト可能に保つため）。
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { NON_SIDE_ATTRIBUTED_LABELS } from 'shared';
import { candidateMoves, kifus, kifuTactics, moveAnalyses } from './db/schema.js';

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
  /** 戦型ラベル名（`kifuTactics.label` と同じ表示名。prd/09 §7） */
  tactic: z.string().trim().max(32).optional(),
  // ラベルをどちらの側で絞るか。`tactic` と組で使う。
  // ⚠ **帰属が `side` でないラベル（角換わり・相掛かり）は `any` 相当**になる
  // （`side` の意味が変わるため。prd/03 §2.1.1・prd/09 §6.1）
  tacticSide: z.enum(['self', 'opponent', 'any']).default('any'),
  // 詰み手数の上限。指定時は「その手数以下の詰みを逃して**落とした**局」に絞る。
  // ⚠ **負け条件を内包する**ので `outcome=loss` を別途付ける必要はない（prd/09 §3.1）
  missedMate: z.coerce.number().int().min(1).optional(),
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
 * 「自分がこの側だった場合」の条件の組。**自分の側に依存する絞り込みはすべてこれを通す**
 * （勝敗・戦型の自分/相手・取りこぼし）。同じ意味論を何箇所にも書かないための単一の出所。
 *
 * 両対局者とも自分の名前候補に一致する対局は側を確定できないため除外する
 * （web の `resolveUserSide` が ambiguous として勝敗バッジを出さないのと同じ扱い）。
 */
interface SelfSide {
  side: 'sente' | 'gote';
  opponent: 'sente' | 'gote';
  /** その側が自分であること（相手が候補に一致する ambiguous な対局は含まない） */
  isSelf: SQL;
  /** 自分が勝った / 負けた */
  won: SQL;
  lost: SQL;
}

function selfSides(names: string[]): SelfSide[] {
  if (names.length === 0) return [];
  // 結果コードは `SENTE_WIN_RESIGN` 等（prd/01 §3）。一覧のバッジと同じ部分一致で判定する
  const senteWin = like(kifus.result, '%SENTE_WIN%');
  const goteWin = like(kifus.result, '%GOTE_WIN%');
  return [
    {
      side: 'sente',
      opponent: 'gote',
      isSelf: and(
        inArray(kifus.sente, names),
        or(isNull(kifus.gote), notInArray(kifus.gote, names)),
      )!,
      won: senteWin,
      lost: goteWin,
    },
    {
      side: 'gote',
      opponent: 'sente',
      isSelf: and(
        inArray(kifus.gote, names),
        or(isNull(kifus.sente), notInArray(kifus.sente, names)),
      )!,
      won: goteWin,
      lost: senteWin,
    },
  ];
}

/**
 * 自分の側ごとの条件を OR で束ねる。**自分を特定できなければ 0 件**にする
 * （全件返すと絞り込みの意味が変わるため）。
 */
function bySelfSide(names: string[], build: (s: SelfSide) => SQL): SQL {
  const sides = selfSides(names);
  if (sides.length === 0) return sql`1 = 0`;
  return or(...sides.map((s) => and(s.isSelf, build(s))))!;
}

/** 勝敗の絞り込み条件 */
function outcomeCondition(
  outcome: Exclude<KifuListQuery['outcome'], 'all'>,
  names: string[],
): SQL {
  return bySelfSide(names, (s) => (outcome === 'win' ? s.won : s.lost));
}

/**
 * その棋譜にラベルが付いているか。**相関 `EXISTS` で書き、JOIN しない**
 * （JOIN は `count()` と LIMIT/OFFSET を壊す。prd/03 §2.1.1・prd/04 §6.1）。
 */
function tacticExists(label: string, side?: 'sente' | 'gote'): SQL {
  const conditions = [eq(kifuTactics.kifuId, kifus.id), eq(kifuTactics.label, label)];
  if (side) conditions.push(eq(kifuTactics.side, side));
  return sql`exists (select 1 from ${kifuTactics} where ${and(...conditions)})`;
}

/** 戦型の絞り込み条件 */
function tacticCondition(query: KifuListQuery, label: string): SQL {
  // ⚠ **帰属が `side` でないラベルは `side` で絞らない**（prd/09 §6.1）。
  // きっかけ帰属の `side` は「持ち込んだ側」で双方がその戦型、対局帰属は `both` の 1 行しか
  // 持たないため、自分/相手で絞ると別の問いになってしまう
  if (query.tacticSide === 'any' || NON_SIDE_ATTRIBUTED_LABELS.includes(label)) {
    return tacticExists(label);
  }
  return bySelfSide(parseSelfNames(query.self), (s) =>
    tacticExists(label, query.tacticSide === 'self' ? s.side : s.opponent),
  );
}

/**
 * 自分の手番の局面に「`limit` 手以下で詰ませる最善手」があるか。
 *
 * `moveNumber = N` は N 手適用後・N+1 手目を指す前の局面で、`moveNumber = 0` が初期局面＝先手番
 * （prd/03 §3・prd/01 §5）。よって自分が先手なら偶数、後手なら奇数の局面が自分の手番。
 * `scoreValue` は**エンジンが返した手番視点のまま**保存されている（prd/03 §4）ので、
 * 自分の手番の局面では正の `mate` が「自分が詰ませる」を意味する。
 */
function selfMateExists(limit: number, side: 'sente' | 'gote'): SQL {
  const parity = side === 'sente' ? 0 : 1;
  return sql`exists (select 1 from ${moveAnalyses} where ${and(
    eq(moveAnalyses.kifuId, kifus.id),
    sql`mod(${moveAnalyses.moveNumber}, 2) = ${parity}`,
    sql`exists (select 1 from ${candidateMoves} where ${and(
      eq(candidateMoves.moveAnalysisId, moveAnalyses.id),
      eq(candidateMoves.rank, 1),
      eq(candidateMoves.scoreType, 'mate'),
      gte(candidateMoves.scoreValue, 1),
      lte(candidateMoves.scoreValue, limit),
    )})`,
  )})`;
}

/**
 * 取りこぼし（prd/09 §3.1）の絞り込み条件。
 *
 * ⚠ **「詰みを逃した」ではなく「詰みを逃して落とした」**。負け条件を内包するのが定義そのもので
 * （詰みを実行していれば負けていない）、そのぶん「実手が詰みでないこと」を確かめずに済む。
 */
function missedMateCondition(limit: number, names: string[]): SQL {
  return bySelfSide(names, (s) => and(s.lost, selfMateExists(limit, s.side))!);
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

  if (query.tactic) conditions.push(tacticCondition(query, query.tactic));

  if (query.missedMate !== undefined) {
    conditions.push(missedMateCondition(query.missedMate, parseSelfNames(query.self)));
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
