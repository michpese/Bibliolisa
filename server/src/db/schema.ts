import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    deviceId: text('device_id'),
    deviceName: text('device_name'),
    clientType: text('client_type', { enum: ['web', 'mobile'] }).notNull(),
    replacedById: text('replaced_by_id'),
    graceUntil: text('grace_until'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_refresh_tokens_user_id').on(table.userId),
    index('idx_refresh_tokens_expires_at').on(table.expiresAt),
  ]
);

export const books = sqliteTable(
  'books',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    authors: text('authors').notNull().default('[]'),
    primaryAuthor: text('primary_author'),
    seriesName: text('series_name'),
    seriesNumber: real('series_number'),
    isbn10: text('isbn_10'),
    isbn13: text('isbn_13'),
    pageCount: integer('page_count'),
    publishedYear: integer('published_year'),
    genres: text('genres').notNull().default('[]'),
    description: text('description'),
    coverKey: text('cover_key'),
    coverSourceUrl: text('cover_source_url'),
    language: text('language'),
    publisher: text('publisher'),
    metadataSource: text('metadata_source', {
      enum: ['manual', 'openlibrary', 'google_books', 'hardcover'],
    })
      .notNull()
      .default('manual'),
    metadataExternalId: text('metadata_external_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    serverUpdatedAt: text('server_updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    index('idx_books_isbn13').on(table.isbn13),
    index('idx_books_isbn10').on(table.isbn10),
    index('idx_books_series').on(table.seriesName, table.seriesNumber),
    index('idx_books_primary_author').on(table.primaryAuthor),
    index('idx_books_server_updated_at').on(table.serverUpdatedAt, table.id),
  ]
);

export const userBooks = sqliteTable(
  'user_books',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['unread', 'reading', 'read', 'abandoned'],
    })
      .notNull()
      .default('unread'),
    rating: integer('rating'),
    notes: text('notes'),
    addedAt: text('added_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    serverUpdatedAt: text('server_updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('idx_user_books_active_unique')
      .on(table.userId, table.bookId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_user_books_user_status').on(table.userId, table.status),
    index('idx_user_books_user_sync').on(
      table.userId,
      table.serverUpdatedAt,
      table.id
    ),
    index('idx_user_books_user_added').on(table.userId, table.addedAt),
  ]
);

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type BookRow = typeof books.$inferSelect;
export type UserBookRow = typeof userBooks.$inferSelect;
