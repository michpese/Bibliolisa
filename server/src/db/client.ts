import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from './migrate.js';
import * as schema from './schema.js';

export interface DatabaseContext {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  dbPath: string;
  coversDir: string;
  nextServerTimestamp: (now?: Date) => string;
  checkpointAndClose: () => void;
}

export interface CreateDatabaseOptions {
  dataDir: string;
  dbPath?: string;
  autoMigrate?: boolean;
}

function readMaxServerTimestampMs(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(
      `SELECT MAX(ts) AS max_ts FROM (
         SELECT MAX(server_updated_at) AS ts FROM books
         UNION ALL
         SELECT MAX(server_updated_at) AS ts FROM user_books
       )`
    )
    .get() as { max_ts: string | null } | undefined;

  if (!row?.max_ts) {
    return 0;
  }

  const parsed = Date.parse(row.max_ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseContext {
  const resolvedDataDir = path.resolve(options.dataDir);
  const resolvedDbPath =
    options.dbPath ?? path.join(resolvedDataDir, 'bibliolisa.sqlite');
  const coversDir = path.join(resolvedDataDir, 'covers');

  if (resolvedDbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });
  }

  const sqlite = new Database(resolvedDbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  if (options.autoMigrate !== false) {
    runMigrations(db);
  }

  let lastServerMs = 0;
  try {
    lastServerMs = readMaxServerTimestampMs(sqlite);
  } catch {
    lastServerMs = 0;
  }

  const nextServerTimestamp = (now?: Date): string => {
    const nowMs = (now ?? new Date()).getTime();
    lastServerMs = Math.max(nowMs, lastServerMs + 1);
    return new Date(lastServerMs).toISOString();
  };

  const checkpointAndClose = (): void => {
    if (!sqlite.open) {
      return;
    }
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      sqlite.close();
    }
  };

  return {
    sqlite,
    db,
    dbPath: resolvedDbPath,
    coversDir,
    nextServerTimestamp,
    checkpointAndClose,
  };
}
