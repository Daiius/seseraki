import {
  bigint,
  int,
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
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().onUpdateNow(),
});

export const analyses = mysqlTable('analyses', {
  id: serial().primaryKey(),
  kifuId: bigint({ mode: 'number', unsigned: true })
    .notNull()
    .references(() => kifus.id, { onDelete: 'cascade' }),
  moveNumber: int().notNull(),
  score: int().notNull(),
  bestMove: varchar({ length: 255 }).notNull(),
  pv: text(),
  createdAt: timestamp().notNull().defaultNow(),
});

export const relations = defineRelations({ kifus, analyses }, (r) => ({
  kifus: {
    analyses: r.many.analyses(),
  },
  analyses: {
    kifu: r.one.kifus({
      from: r.analyses.kifuId,
      to: r.kifus.id,
    }),
  },
}));
