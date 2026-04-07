import {
  bigint,
  int,
  json,
  mysqlTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { defineRelations } from 'drizzle-orm';

export const kifus = mysqlTable('kifus', {
  id: serial().primaryKey(),
  title: varchar({ length: 255 }).notNull(),
  kifText: text().notNull(),
  swarsGameKey: varchar({ length: 255 }).unique(),
  playedAt: timestamp(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().onUpdateNow(),
});

// 1手ごとの解析結果
export const moveAnalyses = mysqlTable('move_analyses', {
  id: serial().primaryKey(),
  kifuId: bigint({ mode: 'number', unsigned: true })
    .notNull()
    .references(() => kifus.id, { onDelete: 'cascade' }),
  moveNumber: int().notNull(),
  movePlayed: varchar({ length: 255 }),
  createdAt: timestamp().notNull().defaultNow(),
});

// MultiPV の各候補手
export const candidateMoves = mysqlTable('candidate_moves', {
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
});

export const relations = defineRelations(
  { kifus, moveAnalyses, candidateMoves },
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
