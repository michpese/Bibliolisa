import * as SQLite from 'expo-sqlite';
import { generateUuid } from '../utils/uuid';
import { runMigrations } from './migrations';
import type { SqlBindValue, SqlExecutor } from './types';

const DB_NAME = 'bibliolisa.db';

let executorPromise: Promise<SqlExecutor> | null = null;

function createExpoSqliteExecutor(sqliteDb: SQLite.SQLiteDatabase): SqlExecutor {
  // Serialisiert Transaktionen, damit schnelle Benutzeraktionen nicht in verschachtelte SQLite-Transaktionen laufen.
  let txQueue: Promise<unknown> = Promise.resolve();

  return {
    async execAsync(sql: string): Promise<void> {
      await sqliteDb.execAsync(sql);
    },

    async runAsync(sql: string, ...params: SqlBindValue[]) {
      const result = await sqliteDb.runAsync(sql, ...params);
      return {
        changes: result.changes,
        lastInsertRowId: result.lastInsertRowId,
      };
    },

    async getFirstAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T | null> {
      return sqliteDb.getFirstAsync<T>(sql, ...params);
    },

    async getAllAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T[]> {
      return sqliteDb.getAllAsync<T>(sql, ...params);
    },

    withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
      const run = txQueue.then(async () => {
        let output!: T;
        await sqliteDb.withTransactionAsync(async () => {
          output = await task();
        });
        return output;
      });
      txQueue = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Öffnet die lokale App-Datenbank (Singleton) und führt ausstehende Migrationen aus.
 */
export function getDatabase(): Promise<SqlExecutor> {
  if (!executorPromise) {
    executorPromise = (async () => {
      const rawDb = await SQLite.openDatabaseAsync(DB_NAME);
      const executor = createExpoSqliteExecutor(rawDb);
      await runMigrations(executor, generateUuid);
      return executor;
    })().catch((error) => {
      executorPromise = null;
      throw error;
    });
  }
  return executorPromise;
}
