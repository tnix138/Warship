import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { desc } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const scores = sqliteTable('scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nick: text('nick').notNull(),
  kills: integer('kills').notNull().default(0),
  xp: integer('xp').notNull().default(0),
  level: integer('level').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export type ScoreRow = typeof scores.$inferSelect;

export class WarshipDatabase {
  readonly #sqlite: Database.Database;
  readonly #db: BetterSQLite3Database;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.#sqlite = new Database(filePath);
    this.#sqlite.pragma('journal_mode = WAL');
    this.#sqlite.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nick TEXT NOT NULL,
        kills INTEGER NOT NULL DEFAULT 0,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    this.#db = drizzle(this.#sqlite);
  }

  recordScore(entry: { nick: string; kills: number; xp: number; level: number }): void {
    this.#db
      .insert(scores)
      .values({
        nick: entry.nick,
        kills: entry.kills,
        xp: entry.xp,
        level: entry.level,
        createdAt: Date.now(),
      })
      .run();
  }

  getTopScores(limit = 10): ScoreRow[] {
    return this.#db.select().from(scores).orderBy(desc(scores.xp)).limit(limit).all();
  }

  close(): void {
    this.#sqlite.close();
  }
}
