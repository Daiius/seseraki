import {
  bigint,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { defineRelations } from 'drizzle-orm';

export const kifus = mysqlTable(
  'kifus',
  {
    id: serial().primaryKey(),
    title: varchar({ length: 255 }).notNull(),
    kifText: text().notNull(),
    usiMoves: json().$type<string[]>(),
    sente: varchar({ length: 100 }),
    gote: varchar({ length: 100 }),
    senteDan: smallint(),
    goteDan: smallint(),
    result: varchar({ length: 50 }),
    swarsGameKey: varchar({ length: 255 }).unique(),
    playedAt: timestamp(),
    // playedAt の解釈に用いたタイムゾーン。手動貼り付け KIF は開始日時に
    // タイムゾーン欄が無いため、署名判定の結果（"JST" 既定 / "UTC"）を残す。
    // swars 経路は gameKey 由来で常に "JST"。
    sourceTz: varchar({ length: 8 }),
    analysisCompletedAt: timestamp(),
    analysisError: text(),
    // 解析世代。reanalyze で +1 し、worker の submit/error 報告は取得時と同一世代のみ受理
    // （実行中の旧解析がリセット後の状態を上書きするのを防ぐ）
    analysisRevision: int().notNull().default(0),
    memo: text(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('kifus_analysis_completed_at_idx').on(table.analysisCompletedAt),
  ],
);

// 1手ごとの解析結果
export const moveAnalyses = mysqlTable(
  'move_analyses',
  {
    id: serial().primaryKey(),
    kifuId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => kifus.id, { onDelete: 'cascade' }),
    moveNumber: int().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('move_analyses_kifu_id_move_number_uq').on(
      table.kifuId,
      table.moveNumber,
    ),
  ],
);

// MultiPV の各候補手
/**
 * 戦型ラベル（prd/03 §2.1）。`usiMoves` から導く**派生値**で、正は指し手列。
 * この表は絞り込みと集計を SQL で行うための索引にすぎない。
 */
export const kifuTactics = mysqlTable(
  'kifu_tactics',
  {
    kifuId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => kifus.id, { onDelete: 'cascade' }),
    /** ラベルの**帰属先**。「立った手番」ではない（prd/03 §2.1.1） */
    side: mysqlEnum(['sente', 'gote', 'both']).notNull(),
    /** 一次 / 二次ラベル名。**表示名そのもの**（enum やコード値にしない） */
    label: varchar({ length: 32 }).notNull(),
    /** 成立手数。表示の抑制に使う。**絞り込み条件には使わない**（prd/03 §2.1.2） */
    turn: int().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kifuId, table.side, table.label] }),
    index('kifu_tactics_label_idx').on(table.label),
  ],
);

export const candidateMoves = mysqlTable(
  'candidate_moves',
  {
    id: serial().primaryKey(),
    moveAnalysisId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => moveAnalyses.id, { onDelete: 'cascade' }),
    rank: int().notNull(),
    move: varchar({ length: 255 }).notNull(),
    scoreType: varchar({ length: 16 }).notNull(), // "cp" | "mate"
    scoreValue: int().notNull(),
    pv: json().$type<string[]>(),
    depth: int().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_moves_move_analysis_id_rank_uq').on(
      table.moveAnalysisId,
      table.rank,
    ),
  ],
);

export const relations = defineRelations(
  { kifus, moveAnalyses, candidateMoves, kifuTactics },
  (r) => ({
    kifus: {
      moveAnalyses: r.many.moveAnalyses(),
    },
    moveAnalyses: {
      kifu: r.one.kifus({
        from: r.moveAnalyses.kifuId,
        to: r.kifus.id,
      }),
      candidateMoves: r.many.candidateMoves(),
    },
    candidateMoves: {
      moveAnalysis: r.one.moveAnalyses({
        from: r.candidateMoves.moveAnalysisId,
        to: r.moveAnalyses.id,
      }),
    },
  }),
);
