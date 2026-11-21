import type { SqlExecutor } from './types';

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    authors TEXT NOT NULL DEFAULT '[]',
    primary_author TEXT,
    series_name TEXT,
    series_number REAL,
    isbn_10 TEXT,
    isbn_13 TEXT,
    page_count INTEGER,
    published_year INTEGER,
    genres TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    cover_key TEXT,
    cover_source_url TEXT,
    cover_local_uri TEXT,
    cover_pending_upload INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    publisher TEXT,
    metadata_source TEXT NOT NULL DEFAULT 'manual',
    metadata_external_id TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    is_dirty INTEGER NOT NULL DEFAULT 0,
    dirty_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_books_isbn13 ON books(isbn_13);
CREATE INDEX IF NOT EXISTS idx_mobile_books_isbn10 ON books(isbn_10);
CREATE INDEX IF NOT EXISTS idx_mobile_books_series ON books(series_name, series_number);
CREATE INDEX IF NOT EXISTS idx_mobile_books_primary_author ON books(primary_author);
CREATE INDEX IF NOT EXISTS idx_mobile_books_dirty ON books(is_dirty);

CREATE TABLE IF NOT EXISTS user_books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL REFERENCES books(id),
    status TEXT NOT NULL DEFAULT 'unread',
    rating INTEGER,
    notes TEXT,
    added_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    is_dirty INTEGER NOT NULL DEFAULT 0,
    dirty_updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_user_books_active_unique
    ON user_books(user_id, book_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mobile_user_books_user_status ON user_books(user_id, status);
CREATE INDEX IF NOT EXISTS idx_mobile_user_books_user_added ON user_books(user_id, added_at);
CREATE INDEX IF NOT EXISTS idx_mobile_user_books_dirty ON user_books(is_dirty);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/**
 * Führt die lokale SQLite-Schema-Initialisierung und Standardwerte idempotent aus.
 */
export async function runMigrations(
  db: SqlExecutor,
  generateUuid: () => string
): Promise<void> {
  await db.execAsync(SCHEMA_SQL);

  await db.withTransactionAsync(async () => {
    const defaults: Array<[string, string]> = [
      ['schema_version', '1'],
      ['device_id', generateUuid()],
      ['user_id', generateUuid()],
      ['is_local_only_user', '1'],
      ['last_sync_status', 'offline'],
    ];

    for (const [key, value] of defaults) {
      await db.runAsync(
        'INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, ?)',
        key,
        value
      );
    }
  });
}
