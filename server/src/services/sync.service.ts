import {
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  IsoUtcTimestampSchema,
  toCanonicalIsoUtc,
  UUIDv4Schema,
  type Book,
  type SyncPushResultItem,
  type SyncRequest,
  type SyncResponse,
  type UserBook,
} from '@bibliolisa/shared';
import type { DatabaseContext } from '../db/client.js';
import { AppError } from '../plugins/error-handler.js';

export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface BookDbRow {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string;
  primary_author: string | null;
  series_name: string | null;
  series_number: number | null;
  isbn_10: string | null;
  isbn_13: string | null;
  page_count: number | null;
  published_year: number | null;
  genres: string;
  description: string | null;
  cover_key: string | null;
  cover_source_url: string | null;
  language: string | null;
  publisher: string | null;
  metadata_source: Book['metadataSource'];
  metadata_external_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  server_updated_at: string;
  deleted_at: string | null;
}

interface UserBookDbRow {
  id: string;
  user_id: string;
  book_id: string;
  status: UserBook['status'];
  rating: number | null;
  notes: string | null;
  added_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  server_updated_at: string;
  deleted_at: string | null;
}

interface SyncWatermark {
  serverUpdatedAt: string;
  id: string;
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function mapBookRow(row: BookDbRow): Book {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    authors: parseJsonStringArray(row.authors),
    seriesName: row.series_name,
    seriesNumber: row.series_number,
    isbn10: row.isbn_10,
    isbn13: row.isbn_13,
    pageCount: row.page_count,
    publishedYear: row.published_year,
    genres: parseJsonStringArray(row.genres),
    description: row.description,
    coverKey: row.cover_key,
    coverSourceUrl: row.cover_source_url,
    language: row.language,
    publisher: row.publisher,
    metadataSource: row.metadata_source,
    metadataExternalId: row.metadata_external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapUserBookRow(row: UserBookDbRow): UserBook {
  return {
    id: row.id,
    userId: row.user_id,
    bookId: row.book_id,
    status: row.status,
    rating: row.rating,
    notes: row.notes,
    addedAt: row.added_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function encodeSyncCursor(serverUpdatedAt: string, id: string): string {
  return Buffer.from(`${serverUpdatedAt}|${id}`, 'utf8').toString('base64');
}

export function decodeSyncCursor(raw: string): SyncWatermark {
  let decoded: string;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 0) {
      throw new Error('empty');
    }
    decoded = buf.toString('utf8');
  } catch {
    throw new AppError(400, 'INVALID_SYNC_CURSOR', 'Ungültiger Sync-Cursor.');
  }

  const parts = decoded.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(400, 'INVALID_SYNC_CURSOR', 'Ungültiger Sync-Cursor.');
  }

  const tsCheck = IsoUtcTimestampSchema.safeParse(parts[0]);
  const idCheck = UUIDv4Schema.safeParse(parts[1]);
  if (!tsCheck.success || !idCheck.success) {
    throw new AppError(400, 'INVALID_SYNC_CURSOR', 'Ungültiger Sync-Cursor.');
  }

  return {
    serverUpdatedAt: tsCheck.data,
    id: idCheck.data,
  };
}

function pickLaterWatermark(
  a: SyncWatermark | null,
  b: SyncWatermark | null
): SyncWatermark | null {
  if (!a) return b;
  if (!b) return a;
  if (a.serverUpdatedAt !== b.serverUpdatedAt) {
    return a.serverUpdatedAt > b.serverUpdatedAt ? a : b;
  }
  return a.id >= b.id ? a : b;
}

function normalizeBookIsbns(
  rawIsbn10: string | null,
  rawIsbn13: string | null
): { isbn10: string | null; isbn13: string | null } {
  let isbn10 = rawIsbn10;
  let isbn13 = rawIsbn13;
  if (isbn13 !== null && isbn10 === null) {
    isbn10 = isbn13ToIsbn10(isbn13);
  } else if (isbn10 !== null && isbn13 === null) {
    isbn13 = isbn10ToIsbn13(isbn10);
  }
  return { isbn10, isbn13 };
}

export class SyncService {
  private readonly dbCtx: DatabaseContext;
  private readonly now: () => Date;

  constructor(dbCtx: DatabaseContext, now?: () => Date) {
    this.dbCtx = dbCtx;
    this.now = now ?? (() => new Date());
  }

  sync(userId: string, request: SyncRequest): SyncResponse {
    const serverNowDate = this.now();
    const serverNowMs = serverNowDate.getTime();
    const serverTimeIso = toCanonicalIsoUtc(serverNowDate);
    const clientMs = Date.parse(request.clientTime);
    const clockSkewMs = Math.round(serverNowMs - clientMs);
    let clockSkewWarning = Math.abs(clockSkewMs) > MAX_FUTURE_CLOCK_SKEW_MS;

    const maxAllowedUpdatedAtIso = new Date(
      serverNowMs + MAX_FUTURE_CLOCK_SKEW_MS
    ).toISOString();

    const clampUpdatedAt = (
      rawIso: string
    ): { value: string; clamped: boolean } => {
      if (rawIso > maxAllowedUpdatedAtIso) {
        clockSkewWarning = true;
        return { value: maxAllowedUpdatedAtIso, clamped: true };
      }
      return { value: rawIso, clamped: false };
    };

    const decodedCursor = request.cursor
      ? decodeSyncCursor(request.cursor)
      : null;

    return this.dbCtx.sqlite.transaction((): SyncResponse => {
      const bookPushResults: SyncPushResultItem[] = [];
      const userBookPushResults: SyncPushResultItem[] = [];

      const acceptedUnclampedBookIds = new Set<string>();
      const acceptedUnclampedUserBookIds = new Set<string>();
      const forcedPullBookIds = new Set<string>();
      const forcedPullUserBookIds = new Set<string>();

      let maxAcceptedWatermark: SyncWatermark | null = null;

      // --- Phase A: Push books ---
      const selectBookStmt = this.dbCtx.sqlite.prepare(
        'SELECT * FROM books WHERE id = ?'
      );
      const userHasBookRefStmt = this.dbCtx.sqlite.prepare(
        'SELECT 1 FROM user_books WHERE user_id = ? AND book_id = ? LIMIT 1'
      );
      const otherUserHasBookRefStmt = this.dbCtx.sqlite.prepare(
        'SELECT 1 FROM user_books WHERE book_id = ? AND user_id != ? LIMIT 1'
      );
      const insertBookStmt = this.dbCtx.sqlite.prepare(
        `INSERT INTO books (
          id, title, subtitle, authors, primary_author,
          series_name, series_number, isbn_10, isbn_13,
          page_count, published_year, genres, description,
          cover_key, cover_source_url, language, publisher,
          metadata_source, metadata_external_id, created_by_user_id,
          created_at, updated_at, server_updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateBookStmt = this.dbCtx.sqlite.prepare(
        `UPDATE books SET
          title = ?, subtitle = ?, authors = ?, primary_author = ?,
          series_name = ?, series_number = ?, isbn_10 = ?, isbn_13 = ?,
          page_count = ?, published_year = ?, genres = ?, description = ?,
          cover_key = ?, cover_source_url = ?, language = ?, publisher = ?,
          metadata_source = ?, metadata_external_id = ?,
          updated_at = ?, server_updated_at = ?, deleted_at = ?
        WHERE id = ?`
      );

      for (const incoming of request.changes.books) {
        const { value: effectiveUpdatedAt, clamped } = clampUpdatedAt(
          incoming.updatedAt
        );
        const { isbn10, isbn13 } = normalizeBookIsbns(
          incoming.isbn10,
          incoming.isbn13
        );
        const primaryAuthor = incoming.authors[0]?.trim() || null;

        const existing = selectBookStmt.get(incoming.id) as
          | BookDbRow
          | undefined;

        if (existing) {
          const canAccess =
            existing.created_by_user_id === userId ||
            Boolean(userHasBookRefStmt.get(userId, incoming.id));

          if (!canAccess) {
            bookPushResults.push({
              id: incoming.id,
              status: 'rejected',
              reason: 'book_not_in_user_library',
            });
            continue;
          }

          if (
            incoming.deletedAt !== null &&
            otherUserHasBookRefStmt.get(incoming.id, userId)
          ) {
            bookPushResults.push({
              id: incoming.id,
              status: 'rejected',
              reason: 'book_referenced_by_other_users',
            });
            forcedPullBookIds.add(incoming.id);
            continue;
          }

          if (effectiveUpdatedAt > existing.updated_at) {
            const serverTs = this.dbCtx.nextServerTimestamp(serverNowDate);
            updateBookStmt.run(
              incoming.title,
              incoming.subtitle,
              JSON.stringify(incoming.authors),
              primaryAuthor,
              incoming.seriesName,
              incoming.seriesNumber,
              isbn10,
              isbn13,
              incoming.pageCount,
              incoming.publishedYear,
              JSON.stringify(incoming.genres),
              incoming.description,
              incoming.coverKey,
              incoming.coverSourceUrl,
              incoming.language,
              incoming.publisher,
              incoming.metadataSource,
              incoming.metadataExternalId,
              effectiveUpdatedAt,
              serverTs,
              incoming.deletedAt,
              incoming.id
            );

            bookPushResults.push({ id: incoming.id, status: 'accepted' });
            maxAcceptedWatermark = pickLaterWatermark(maxAcceptedWatermark, {
              serverUpdatedAt: serverTs,
              id: incoming.id,
            });
            if (clamped) {
              forcedPullBookIds.add(incoming.id);
            } else {
              acceptedUnclampedBookIds.add(incoming.id);
            }
          } else {
            bookPushResults.push({
              id: incoming.id,
              status: 'conflict_server_won',
              reason: `Server-Datensatz besitzt neueres oder gleiches updatedAt (${existing.updated_at})`,
            });
            forcedPullBookIds.add(incoming.id);
          }
        } else {
          const serverTs = this.dbCtx.nextServerTimestamp(serverNowDate);
          insertBookStmt.run(
            incoming.id,
            incoming.title,
            incoming.subtitle,
            JSON.stringify(incoming.authors),
            primaryAuthor,
            incoming.seriesName,
            incoming.seriesNumber,
            isbn10,
            isbn13,
            incoming.pageCount,
            incoming.publishedYear,
            JSON.stringify(incoming.genres),
            incoming.description,
            incoming.coverKey,
            incoming.coverSourceUrl,
            incoming.language,
            incoming.publisher,
            incoming.metadataSource,
            incoming.metadataExternalId,
            userId,
            incoming.createdAt,
            effectiveUpdatedAt,
            serverTs,
            incoming.deletedAt
          );

          bookPushResults.push({ id: incoming.id, status: 'accepted' });
          maxAcceptedWatermark = pickLaterWatermark(maxAcceptedWatermark, {
            serverUpdatedAt: serverTs,
            id: incoming.id,
          });
          if (clamped) {
            forcedPullBookIds.add(incoming.id);
          } else {
            acceptedUnclampedBookIds.add(incoming.id);
          }
        }
      }

      // --- Phase B: Push userBooks ---
      const selectUserBookStmt = this.dbCtx.sqlite.prepare(
        'SELECT * FROM user_books WHERE id = ?'
      );
      const selectActiveByUserAndBookStmt = this.dbCtx.sqlite.prepare(
        `SELECT * FROM user_books
         WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL AND id != ?
         LIMIT 1`
      );
      const insertUserBookStmt = this.dbCtx.sqlite.prepare(
        `INSERT INTO user_books (
          id, user_id, book_id, status, rating, notes,
          added_at, started_at, finished_at,
          created_at, updated_at, server_updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateUserBookStmt = this.dbCtx.sqlite.prepare(
        `UPDATE user_books SET
          book_id = ?, status = ?, rating = ?, notes = ?,
          added_at = ?, started_at = ?, finished_at = ?,
          updated_at = ?, server_updated_at = ?, deleted_at = ?
        WHERE id = ? AND user_id = ?`
      );

      for (const incoming of request.changes.userBooks) {
        const { value: effectiveUpdatedAt, clamped } = clampUpdatedAt(
          incoming.updatedAt
        );

        const existing = selectUserBookStmt.get(incoming.id) as
          | UserBookDbRow
          | undefined;

        if (existing && existing.user_id !== userId) {
          userBookPushResults.push({
            id: incoming.id,
            status: 'rejected',
            reason: 'forbidden_user_book_id',
          });
          continue;
        }

        const bookExists = selectBookStmt.get(incoming.bookId) as
          | BookDbRow
          | undefined;
        if (!bookExists) {
          userBookPushResults.push({
            id: incoming.id,
            status: 'rejected',
            reason: 'book_not_found',
          });
          continue;
        }

        if (incoming.deletedAt === null) {
          const existingActive = selectActiveByUserAndBookStmt.get(
            userId,
            incoming.bookId,
            incoming.id
          ) as UserBookDbRow | undefined;

          if (existingActive) {
            if (effectiveUpdatedAt > existingActive.updated_at) {
              const serverTs = this.dbCtx.nextServerTimestamp(serverNowDate);
              updateUserBookStmt.run(
                incoming.bookId,
                incoming.status,
                incoming.rating,
                incoming.notes,
                incoming.addedAt,
                incoming.startedAt,
                incoming.finishedAt,
                effectiveUpdatedAt,
                serverTs,
                null,
                existingActive.id,
                userId
              );
              maxAcceptedWatermark = pickLaterWatermark(maxAcceptedWatermark, {
                serverUpdatedAt: serverTs,
                id: existingActive.id,
              });
            }

            userBookPushResults.push({
              id: incoming.id,
              status: 'rejected',
              reason: 'duplicate_active_user_book_merged',
            });
            forcedPullUserBookIds.add(existingActive.id);
            continue;
          }
        }

        if (existing) {
          if (effectiveUpdatedAt > existing.updated_at) {
            const serverTs = this.dbCtx.nextServerTimestamp(serverNowDate);
            updateUserBookStmt.run(
              incoming.bookId,
              incoming.status,
              incoming.rating,
              incoming.notes,
              incoming.addedAt,
              incoming.startedAt,
              incoming.finishedAt,
              effectiveUpdatedAt,
              serverTs,
              incoming.deletedAt,
              incoming.id,
              userId
            );

            userBookPushResults.push({ id: incoming.id, status: 'accepted' });
            maxAcceptedWatermark = pickLaterWatermark(maxAcceptedWatermark, {
              serverUpdatedAt: serverTs,
              id: incoming.id,
            });
            if (clamped) {
              forcedPullUserBookIds.add(incoming.id);
            } else {
              acceptedUnclampedUserBookIds.add(incoming.id);
            }
          } else {
            userBookPushResults.push({
              id: incoming.id,
              status: 'conflict_server_won',
              reason: `Server-Datensatz besitzt neueres oder gleiches updatedAt (${existing.updated_at})`,
            });
            forcedPullUserBookIds.add(existing.id);
          }
        } else {
          const serverTs = this.dbCtx.nextServerTimestamp(serverNowDate);
          insertUserBookStmt.run(
            incoming.id,
            userId,
            incoming.bookId,
            incoming.status,
            incoming.rating,
            incoming.notes,
            incoming.addedAt,
            incoming.startedAt,
            incoming.finishedAt,
            incoming.createdAt,
            effectiveUpdatedAt,
            serverTs,
            incoming.deletedAt
          );

          userBookPushResults.push({ id: incoming.id, status: 'accepted' });
          maxAcceptedWatermark = pickLaterWatermark(maxAcceptedWatermark, {
            serverUpdatedAt: serverTs,
            id: incoming.id,
          });
          if (clamped) {
            forcedPullUserBookIds.add(incoming.id);
          } else {
            acceptedUnclampedUserBookIds.add(incoming.id);
          }
        }
      }

      // --- Phase C: Pull (strikt mandantenisoliert inkl. pull.books-Scoping) ---
      const cursorTs = decodedCursor?.serverUpdatedAt ?? null;
      const cursorId = decodedCursor?.id ?? null;

      const pullStreamStmt = this.dbCtx.sqlite.prepare(
        `SELECT 'book' AS entity_type, b.id AS id, b.server_updated_at AS server_updated_at
         FROM books b
         WHERE EXISTS (
           SELECT 1 FROM user_books ub_ref
           WHERE ub_ref.user_id = ? AND ub_ref.book_id = b.id
         )
           AND (? IS NULL OR b.server_updated_at > ? OR (b.server_updated_at = ? AND b.id > ?))
         UNION ALL
         SELECT 'user_book' AS entity_type, ub.id AS id, ub.server_updated_at AS server_updated_at
         FROM user_books ub
         WHERE ub.user_id = ?
           AND (? IS NULL OR ub.server_updated_at > ? OR (ub.server_updated_at = ? AND ub.id > ?))
         ORDER BY server_updated_at ASC, id ASC, entity_type ASC`
      );

      const pageCandidates: Array<{
        entity_type: 'book' | 'user_book';
        id: string;
        server_updated_at: string;
      }> = [];

      for (const row of pullStreamStmt.iterate(
        userId,
        cursorTs,
        cursorTs,
        cursorTs,
        cursorId,
        userId,
        cursorTs,
        cursorTs,
        cursorTs,
        cursorId
      ) as IterableIterator<{
        entity_type: 'book' | 'user_book';
        id: string;
        server_updated_at: string;
      }>) {
        if (
          row.entity_type === 'book' &&
          acceptedUnclampedBookIds.has(row.id)
        ) {
          continue;
        }
        if (
          row.entity_type === 'user_book' &&
          acceptedUnclampedUserBookIds.has(row.id)
        ) {
          continue;
        }
        pageCandidates.push(row);
        if (pageCandidates.length > request.limit) {
          break;
        }
      }

      const hasMore = pageCandidates.length > request.limit;
      const pageItems = hasMore
        ? pageCandidates.slice(0, request.limit)
        : pageCandidates;

      let nextCursor: string | null = request.cursor;
      if (hasMore) {
        const last = pageItems[pageItems.length - 1]!;
        nextCursor = encodeSyncCursor(last.server_updated_at, last.id);
      } else {
        const lastPageItem = pageItems[pageItems.length - 1];
        const pageWatermark: SyncWatermark | null = lastPageItem
          ? {
              serverUpdatedAt: lastPageItem.server_updated_at,
              id: lastPageItem.id,
            }
          : null;
        const bestWatermark = pickLaterWatermark(
          pageWatermark,
          maxAcceptedWatermark
        );
        const finalWatermark = pickLaterWatermark(bestWatermark, decodedCursor);
        if (finalWatermark) {
          nextCursor = encodeSyncCursor(
            finalWatermark.serverUpdatedAt,
            finalWatermark.id
          );
        }
      }

      const userBookIdsToLoad = new Set<string>(forcedPullUserBookIds);
      const bookIdsToLoad = new Set<string>(forcedPullBookIds);

      for (const item of pageItems) {
        if (item.entity_type === 'user_book') {
          userBookIdsToLoad.add(item.id);
        } else {
          bookIdsToLoad.add(item.id);
        }
      }

      const pulledUserBooks = this.loadUserBooksForUser(
        userId,
        Array.from(userBookIdsToLoad)
      );

      // Sicherstellen, dass jeder gepullte user_books-Eintrag sein referenziertes Buch mitbringt
      for (const ub of pulledUserBooks) {
        if (!acceptedUnclampedBookIds.has(ub.bookId)) {
          bookIdsToLoad.add(ub.bookId);
        }
      }

      const pulledBooks = this.loadScopedBooksForUser(
        userId,
        Array.from(bookIdsToLoad)
      );

      return {
        serverTime: serverTimeIso,
        nextCursor,
        hasMore,
        clockSkewMs,
        clockSkewWarning,
        pushResults: {
          books: bookPushResults,
          userBooks: userBookPushResults,
        },
        pull: {
          books: pulledBooks,
          userBooks: pulledUserBooks,
        },
      };
    })();
  }

  private loadUserBooksForUser(userId: string, ids: string[]): UserBook[] {
    if (ids.length === 0) return [];
    const rows: UserBookDbRow[] = [];
    const chunkSize = 400;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = this.dbCtx.sqlite
        .prepare(
          `SELECT * FROM user_books
           WHERE user_id = ? AND id IN (${placeholders})`
        )
        .all(userId, ...chunk) as UserBookDbRow[];
      rows.push(...chunkRows);
    }

    rows.sort((a, b) =>
      a.server_updated_at !== b.server_updated_at
        ? a.server_updated_at < b.server_updated_at
          ? -1
          : 1
        : a.id.localeCompare(b.id)
    );

    return rows.map(mapUserBookRow);
  }

  private loadScopedBooksForUser(userId: string, ids: string[]): Book[] {
    if (ids.length === 0) return [];
    const rows: BookDbRow[] = [];
    const chunkSize = 400;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = this.dbCtx.sqlite
        .prepare(
          `SELECT b.* FROM books b
           WHERE b.id IN (${placeholders})
             AND EXISTS (
               SELECT 1 FROM user_books ub_ref
               WHERE ub_ref.user_id = ? AND ub_ref.book_id = b.id
             )`
        )
        .all(...chunk, userId) as BookDbRow[];
      rows.push(...chunkRows);
    }

    rows.sort((a, b) =>
      a.server_updated_at !== b.server_updated_at
        ? a.server_updated_at < b.server_updated_at
          ? -1
          : 1
        : a.id.localeCompare(b.id)
    );

    return rows.map(mapBookRow);
  }
}
