import type { LibraryEntry } from '@bibliolisa/shared';

export type SqlBindValue = string | number | null | Uint8Array;

export interface SqlRunResult {
  changes: number;
  lastInsertRowId: number;
}

/**
 * Gemeinsames SQLite-Zugriffsinterface für expo-sqlite (Android) und better-sqlite3 (Vitest).
 */
export interface SqlExecutor {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqlBindValue[]): Promise<SqlRunResult>;
  getFirstAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T[]>;
  withTransactionAsync<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Erweitert das geteilte LibraryEntry-DTO um lokale Offline- und Cover-Sync-Felder.
 */
export interface LocalLibraryEntry extends LibraryEntry {
  coverLocalUri: string | null;
  coverPendingUpload: boolean;
  isDirty: boolean;
}
