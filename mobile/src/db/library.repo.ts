import {
  CreateLibraryEntrySchema,
  UpdateLibraryEntrySchema,
  getDefaultSortOrder,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  sortLibraryEntries,
  toCanonicalIsoUtc,
  type CreateLibraryEntry,
  type FacetCount,
  type LibraryEntry,
  type LibraryFacetsResponse,
  type LibrarySortField,
  type ReadingStatus,
  type SoftDeleteResponse,
  type SortOrder,
  type StatusCounts,
  type UpdateLibraryEntry,
} from '@bibliolisa/shared';
import type { LocalLibraryEntry, SqlBindValue, SqlExecutor } from './types';

interface JoinedMobileRow {
  ub_id: string;
  ub_user_id: string;
  ub_book_id: string;
  ub_status: ReadingStatus;
  ub_rating: number | null;
  ub_notes: string | null;
  ub_added_at: string;
  ub_started_at: string | null;
  ub_finished_at: string | null;
  ub_created_at: string;
  ub_updated_at: string;
  ub_deleted_at: string | null;
  ub_is_dirty: number;
  b_id: string;
  b_title: string;
  b_subtitle: string | null;
  b_authors: string;
  b_series_name: string | null;
  b_series_number: number | null;
  b_isbn_10: string | null;
  b_isbn_13: string | null;
  b_page_count: number | null;
  b_published_year: number | null;
  b_genres: string;
  b_description: string | null;
  b_cover_key: string | null;
  b_cover_source_url: string | null;
  b_cover_local_uri: string | null;
  b_cover_pending_upload: number;
  b_language: string | null;
  b_publisher: string | null;
  b_metadata_source: LibraryEntry['book']['metadataSource'];
  b_metadata_external_id: string | null;
  b_created_at: string;
  b_updated_at: string;
  b_deleted_at: string | null;
  b_is_dirty: number;
}

const JOINED_SELECT = `
  ub.id AS ub_id,
  ub.user_id AS ub_user_id,
  ub.book_id AS ub_book_id,
  ub.status AS ub_status,
  ub.rating AS ub_rating,
  ub.notes AS ub_notes,
  ub.added_at AS ub_added_at,
  ub.started_at AS ub_started_at,
  ub.finished_at AS ub_finished_at,
  ub.created_at AS ub_created_at,
  ub.updated_at AS ub_updated_at,
  ub.deleted_at AS ub_deleted_at,
  ub.is_dirty AS ub_is_dirty,
  b.id AS b_id,
  b.title AS b_title,
  b.subtitle AS b_subtitle,
  b.authors AS b_authors,
  b.series_name AS b_series_name,
  b.series_number AS b_series_number,
  b.isbn_10 AS b_isbn_10,
  b.isbn_13 AS b_isbn_13,
  b.page_count AS b_page_count,
  b.published_year AS b_published_year,
  b.genres AS b_genres,
  b.description AS b_description,
  b.cover_key AS b_cover_key,
  b.cover_source_url AS b_cover_source_url,
  b.cover_local_uri AS b_cover_local_uri,
  b.cover_pending_upload AS b_cover_pending_upload,
  b.language AS b_language,
  b.publisher AS b_publisher,
  b.metadata_source AS b_metadata_source,
  b.metadata_external_id AS b_metadata_external_id,
  b.created_at AS b_created_at,
  b.updated_at AS b_updated_at,
  b.deleted_at AS b_deleted_at,
  b.is_dirty AS b_is_dirty
`;

export interface LocalLibraryFilters {
  q?: string;
  status?: ReadingStatus;
  genre?: string;
  author?: string;
  series?: string;
  minRating?: number;
  maxRating?: number;
  sort?: LibrarySortField;
  order?: SortOrder;
}

export interface LocalCoverWriteOptions {
  coverLocalUri?: string | null;
  coverPendingUpload?: boolean;
}

export interface LocalCreateOptions extends LocalCoverWriteOptions {
  generateUuid: () => string;
  now?: () => Date;
}

export interface LocalUpdateOptions extends LocalCoverWriteOptions {
  now?: () => Date;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function mapRow(row: JoinedMobileRow): LocalLibraryEntry {
  return {
    id: row.ub_id,
    userId: row.ub_user_id,
    bookId: row.ub_book_id,
    status: row.ub_status,
    rating: row.ub_rating,
    notes: row.ub_notes,
    addedAt: row.ub_added_at,
    startedAt: row.ub_started_at,
    finishedAt: row.ub_finished_at,
    createdAt: row.ub_created_at,
    updatedAt: row.ub_updated_at,
    deletedAt: row.ub_deleted_at,
    coverLocalUri: row.b_cover_local_uri,
    coverPendingUpload: row.b_cover_pending_upload === 1,
    isDirty: row.ub_is_dirty === 1 || row.b_is_dirty === 1,
    book: {
      id: row.b_id,
      title: row.b_title,
      subtitle: row.b_subtitle,
      authors: parseStringArray(row.b_authors),
      seriesName: row.b_series_name,
      seriesNumber: row.b_series_number,
      isbn10: row.b_isbn_10,
      isbn13: row.b_isbn_13,
      pageCount: row.b_page_count,
      publishedYear: row.b_published_year,
      genres: parseStringArray(row.b_genres),
      description: row.b_description,
      coverKey: row.b_cover_key,
      coverSourceUrl: row.b_cover_source_url,
      language: row.b_language,
      publisher: row.b_publisher,
      metadataSource: row.b_metadata_source,
      metadataExternalId: row.b_metadata_external_id,
      createdAt: row.b_created_at,
      updatedAt: row.b_updated_at,
      deletedAt: row.b_deleted_at,
    },
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function sortFacets(map: Map<string, { value: string; count: number }>): FacetCount[] {
  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.value.toLowerCase().localeCompare(b.value.toLowerCase());
  });
}

async function getEntryRowForUser(
  db: SqlExecutor,
  userId: string,
  userBookId: string,
  includeDeleted = false
): Promise<JoinedMobileRow | null> {
  const deletedClause = includeDeleted ? '' : 'AND ub.deleted_at IS NULL';
  return db.getFirstAsync<JoinedMobileRow>(
    `SELECT ${JOINED_SELECT}
     FROM user_books ub
     INNER JOIN books b ON b.id = ub.book_id
     WHERE ub.id = ? AND ub.user_id = ? AND b.deleted_at IS NULL ${deletedClause}`,
    userBookId,
    userId
  );
}

/**
 * Listet aktive Bibliothekseinträge des Benutzers vollständig offline aus SQLite.
 */
export async function listLocalLibraryEntries(
  db: SqlExecutor,
  userId: string,
  filters: LocalLibraryFilters = {}
): Promise<LocalLibraryEntry[]> {
  const conditions: string[] = [
    'ub.user_id = ?',
    'ub.deleted_at IS NULL',
    'b.deleted_at IS NULL',
  ];
  const params: SqlBindValue[] = [userId];

  if (filters.status !== undefined) {
    conditions.push('ub.status = ?');
    params.push(filters.status);
  }
  if (filters.minRating !== undefined) {
    conditions.push('ub.rating >= ?');
    params.push(filters.minRating);
  }
  if (filters.maxRating !== undefined) {
    conditions.push('ub.rating <= ?');
    params.push(filters.maxRating);
  }
  if (filters.series !== undefined && filters.series.trim() !== '') {
    conditions.push('LOWER(b.series_name) = LOWER(?)');
    params.push(filters.series.trim());
  }

  const trimmedQuery = filters.q?.trim();
  if (trimmedQuery) {
    const pattern = `%${escapeLikePattern(trimmedQuery.toLowerCase())}%`;
    const cleanedIsbnQuery = trimmedQuery.replace(/[\s-]+/g, '').toLowerCase();
    if (cleanedIsbnQuery.length > 0) {
      const isbnPattern = `%${escapeLikePattern(cleanedIsbnQuery)}%`;
      conditions.push(
        `(LOWER(b.title) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.subtitle, '')) LIKE ? ESCAPE '\\'
          OR LOWER(b.authors) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.series_name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.isbn_10, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.isbn_13, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(ub.notes, '')) LIKE ? ESCAPE '\\')`
      );
      params.push(
        pattern,
        pattern,
        pattern,
        pattern,
        isbnPattern,
        isbnPattern,
        pattern
      );
    } else {
      conditions.push(
        `(LOWER(b.title) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.subtitle, '')) LIKE ? ESCAPE '\\'
          OR LOWER(b.authors) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(b.series_name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(ub.notes, '')) LIKE ? ESCAPE '\\')`
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
  }

  const rows = await db.getAllAsync<JoinedMobileRow>(
    `SELECT ${JOINED_SELECT}
     FROM user_books ub
     INNER JOIN books b ON b.id = ub.book_id
     WHERE ${conditions.join(' AND ')}`,
    ...params
  );

  let entries = rows.map(mapRow);

  if (filters.genre !== undefined && filters.genre.trim() !== '') {
    const targetGenre = filters.genre.trim().toLowerCase();
    entries = entries.filter((entry) =>
      entry.book.genres.some((genre) => genre.trim().toLowerCase() === targetGenre)
    );
  }

  if (filters.author !== undefined && filters.author.trim() !== '') {
    const targetAuthor = filters.author.trim().toLowerCase();
    entries = entries.filter((entry) =>
      entry.book.authors.some((author) => author.trim().toLowerCase() === targetAuthor)
    );
  }

  const sortField = filters.sort ?? 'added_at';
  const sortOrder = filters.order ?? getDefaultSortOrder(sortField);
  return sortLibraryEntries(entries, sortField, sortOrder) as LocalLibraryEntry[];
}

export async function listAllActiveLocalEntries(
  db: SqlExecutor,
  userId: string
): Promise<LocalLibraryEntry[]> {
  return listLocalLibraryEntries(db, userId, { sort: 'added_at', order: 'desc' });
}

export async function getLocalLibraryEntryById(
  db: SqlExecutor,
  userId: string,
  userBookId: string,
  includeDeleted = false
): Promise<LocalLibraryEntry | null> {
  const row = await getEntryRowForUser(db, userId, userBookId, includeDeleted);
  return row ? mapRow(row) : null;
}

export async function findActiveLocalEntryByIsbn(
  db: SqlExecutor,
  userId: string,
  isbn13: string | null,
  isbn10: string | null
): Promise<LocalLibraryEntry | null> {
  if (!isbn13 && !isbn10) {
    return null;
  }

  const conditions: string[] = [];
  const params: SqlBindValue[] = [userId];
  if (isbn13) {
    conditions.push('b.isbn_13 = ?');
    params.push(isbn13);
  }
  if (isbn10) {
    conditions.push('b.isbn_10 = ?');
    params.push(isbn10);
  }

  const row = await db.getFirstAsync<JoinedMobileRow>(
    `SELECT ${JOINED_SELECT}
     FROM user_books ub
     INNER JOIN books b ON b.id = ub.book_id
     WHERE ub.user_id = ?
       AND ub.deleted_at IS NULL
       AND b.deleted_at IS NULL
       AND (${conditions.join(' OR ')})
     LIMIT 1`,
    ...params
  );

  return row ? mapRow(row) : null;
}

export async function getLocalLibraryFacets(
  db: SqlExecutor,
  userId: string
): Promise<LibraryFacetsResponse> {
  const entries = await listAllActiveLocalEntries(db, userId);

  const genreMap = new Map<string, { value: string; count: number }>();
  const seriesMap = new Map<string, { value: string; count: number }>();
  const authorMap = new Map<string, { value: string; count: number }>();
  const statusCounts: StatusCounts = {
    unread: 0,
    reading: 0,
    read: 0,
    abandoned: 0,
  };

  for (const entry of entries) {
    statusCounts[entry.status] += 1;

    const seenGenres = new Set<string>();
    for (const genre of entry.book.genres) {
      const trimmed = genre.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seenGenres.has(key)) continue;
      seenGenres.add(key);
      const current = genreMap.get(key);
      if (current) {
        current.count += 1;
      } else {
        genreMap.set(key, { value: trimmed, count: 1 });
      }
    }

    const seriesTrimmed = entry.book.seriesName?.trim();
    if (seriesTrimmed) {
      const key = seriesTrimmed.toLowerCase();
      const current = seriesMap.get(key);
      if (current) {
        current.count += 1;
      } else {
        seriesMap.set(key, { value: seriesTrimmed, count: 1 });
      }
    }

    const seenAuthors = new Set<string>();
    for (const author of entry.book.authors) {
      const trimmed = author.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seenAuthors.has(key)) continue;
      seenAuthors.add(key);
      const current = authorMap.get(key);
      if (current) {
        current.count += 1;
      } else {
        authorMap.set(key, { value: trimmed, count: 1 });
      }
    }
  }

  return {
    genres: sortFacets(genreMap),
    series: sortFacets(seriesMap),
    authors: sortFacets(authorMap),
    statusCounts,
    total: entries.length,
  };
}

/**
 * Legt ein Buch samt persönlichem Indexeintrag offline an (Client-UUIDv4, is_dirty = 1).
 */
export async function createLocalLibraryEntry(
  db: SqlExecutor,
  userId: string,
  rawInput: CreateLibraryEntry,
  options: LocalCreateOptions
): Promise<LocalLibraryEntry> {
  const input = CreateLibraryEntrySchema.parse(rawInput);
  const nowDate = (options.now ?? (() => new Date()))();
  const nowIso = toCanonicalIsoUtc(nowDate);
  const userBookId = input.id ?? options.generateUuid();

  await db.withTransactionAsync(async () => {
    const existingEntry = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM user_books WHERE id = ?',
      userBookId
    );
    if (existingEntry) {
      throw new Error('Ein Bibliothekseintrag mit dieser ID existiert bereits.');
    }

    let resolvedBookId: string;

    if (input.bookId !== undefined) {
      const existingBook = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM books WHERE id = ? AND deleted_at IS NULL',
        input.bookId
      );
      if (!existingBook) {
        throw new Error('Angegebenes Buch wurde lokal nicht gefunden.');
      }
      resolvedBookId = existingBook.id;
    } else if (input.book !== undefined) {
      const bookInput = input.book;
      let isbn10 = bookInput.isbn10 ?? null;
      let isbn13 = bookInput.isbn13 ?? null;
      if (isbn13 !== null && isbn10 === null) {
        isbn10 = isbn13ToIsbn10(isbn13);
      } else if (isbn10 !== null && isbn13 === null) {
        isbn13 = isbn10ToIsbn13(isbn10);
      }

      let matchedBookId: string | null = null;
      if (bookInput.id !== undefined) {
        const existingById = await db.getFirstAsync<{ id: string; deleted_at: string | null }>(
          'SELECT id, deleted_at FROM books WHERE id = ?',
          bookInput.id
        );
        if (existingById) {
          if (existingById.deleted_at !== null) {
            throw new Error('Das angegebene Buch wurde gelöscht.');
          }
          matchedBookId = existingById.id;
        }
      } else {
        if (isbn13 !== null) {
          const byIsbn13 = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM books WHERE isbn_13 = ? AND deleted_at IS NULL LIMIT 1',
            isbn13
          );
          if (byIsbn13) matchedBookId = byIsbn13.id;
        }
        if (matchedBookId === null && isbn10 !== null) {
          const byIsbn10 = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM books WHERE isbn_10 = ? AND deleted_at IS NULL LIMIT 1',
            isbn10
          );
          if (byIsbn10) matchedBookId = byIsbn10.id;
        }
      }

      if (matchedBookId !== null) {
        resolvedBookId = matchedBookId;
        if (options.coverLocalUri !== undefined || options.coverPendingUpload !== undefined) {
          await db.runAsync(
            `UPDATE books
             SET cover_local_uri = COALESCE(?, cover_local_uri),
                 cover_pending_upload = CASE WHEN ? THEN 1 ELSE cover_pending_upload END,
                 updated_at = ?,
                 is_dirty = 1,
                 dirty_updated_at = ?
             WHERE id = ?`,
            options.coverLocalUri ?? null,
            options.coverPendingUpload ? 1 : 0,
            nowIso,
            nowIso,
            resolvedBookId
          );
        }
      } else {
        resolvedBookId = bookInput.id ?? options.generateUuid();
        const primaryAuthor = bookInput.authors[0]?.trim() || null;

        await db.runAsync(
          `INSERT INTO books (
            id, title, subtitle, authors, primary_author,
            series_name, series_number, isbn_10, isbn_13,
            page_count, published_year, genres, description,
            cover_key, cover_source_url, cover_local_uri, cover_pending_upload,
            language, publisher, metadata_source, metadata_external_id,
            created_by_user_id, created_at, updated_at, deleted_at,
            is_dirty, dirty_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
          resolvedBookId,
          bookInput.title,
          bookInput.subtitle ?? null,
          JSON.stringify(bookInput.authors),
          primaryAuthor,
          bookInput.seriesName ?? null,
          bookInput.seriesNumber ?? null,
          isbn10,
          isbn13,
          bookInput.pageCount ?? null,
          bookInput.publishedYear ?? null,
          JSON.stringify(bookInput.genres),
          bookInput.description ?? null,
          bookInput.coverKey ?? null,
          bookInput.coverSourceUrl ?? null,
          options.coverLocalUri ?? null,
          options.coverPendingUpload ? 1 : 0,
          bookInput.language ?? null,
          bookInput.publisher ?? null,
          bookInput.metadataSource,
          bookInput.metadataExternalId ?? null,
          userId,
          nowIso,
          nowIso,
          nowIso
        );
      }
    } else {
      throw new Error('Entweder bookId oder book muss angegeben werden.');
    }

    const duplicateActive = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM user_books WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL',
      userId,
      resolvedBookId
    );
    if (duplicateActive) {
      throw new Error('Dieses Buch befindet sich bereits in deinem Index.');
    }

    const addedAt = input.addedAt ?? nowIso;
    await db.runAsync(
      `INSERT INTO user_books (
        id, user_id, book_id, status, rating, notes,
        added_at, started_at, finished_at,
        created_at, updated_at, deleted_at, is_dirty, dirty_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
      userBookId,
      userId,
      resolvedBookId,
      input.status,
      input.rating ?? null,
      input.notes ?? null,
      addedAt,
      input.startedAt ?? null,
      input.finishedAt ?? null,
      nowIso,
      nowIso,
      nowIso
    );
  });

  const created = await getLocalLibraryEntryById(db, userId, userBookId, false);
  if (!created) {
    throw new Error('Neu angelegter Eintrag konnte nicht geladen werden.');
  }
  return created;
}

/**
 * Aktualisiert persönliche Indexfelder und/oder Buch-Metadaten offline und markiert is_dirty = 1.
 */
export async function updateLocalLibraryEntry(
  db: SqlExecutor,
  userId: string,
  userBookId: string,
  rawInput: UpdateLibraryEntry,
  options: LocalUpdateOptions = {}
): Promise<LocalLibraryEntry> {
  const input = UpdateLibraryEntrySchema.parse(rawInput);
  const nowDate = (options.now ?? (() => new Date()))();
  const nowIso = toCanonicalIsoUtc(nowDate);

  await db.withTransactionAsync(async () => {
    const existing = await getEntryRowForUser(db, userId, userBookId, false);
    if (!existing) {
      throw new Error('Bibliothekseintrag nicht gefunden.');
    }

    const userAssignments: string[] = [];
    const userParams: SqlBindValue[] = [];

    if (input.status !== undefined) {
      userAssignments.push('status = ?');
      userParams.push(input.status);
    }
    if (input.rating !== undefined) {
      userAssignments.push('rating = ?');
      userParams.push(input.rating);
    }
    if (input.notes !== undefined) {
      userAssignments.push('notes = ?');
      userParams.push(input.notes);
    }
    if (input.addedAt !== undefined) {
      userAssignments.push('added_at = ?');
      userParams.push(input.addedAt);
    }
    if (input.startedAt !== undefined) {
      userAssignments.push('started_at = ?');
      userParams.push(input.startedAt);
    }
    if (input.finishedAt !== undefined) {
      userAssignments.push('finished_at = ?');
      userParams.push(input.finishedAt);
    }

    if (userAssignments.length > 0) {
      userAssignments.push('updated_at = ?', 'is_dirty = 1', 'dirty_updated_at = ?');
      userParams.push(nowIso, nowIso);
      await db.runAsync(
        `UPDATE user_books SET ${userAssignments.join(', ')}
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        ...userParams,
        userBookId,
        userId
      );
    }

    const bookAssignments: string[] = [];
    const bookParams: SqlBindValue[] = [];

    if (input.book !== undefined) {
      const b = input.book;
      if (b.title !== undefined) {
        bookAssignments.push('title = ?');
        bookParams.push(b.title);
      }
      if (b.subtitle !== undefined) {
        bookAssignments.push('subtitle = ?');
        bookParams.push(b.subtitle);
      }
      if (b.authors !== undefined) {
        bookAssignments.push('authors = ?', 'primary_author = ?');
        bookParams.push(JSON.stringify(b.authors), b.authors[0]?.trim() || null);
      }
      if (b.seriesName !== undefined) {
        bookAssignments.push('series_name = ?');
        bookParams.push(b.seriesName);
      }
      if (b.seriesNumber !== undefined) {
        bookAssignments.push('series_number = ?');
        bookParams.push(b.seriesNumber);
      }

      let nextIsbn10 = b.isbn10;
      let nextIsbn13 = b.isbn13;
      if (nextIsbn13 !== undefined && nextIsbn13 !== null && nextIsbn10 === undefined) {
        nextIsbn10 = isbn13ToIsbn10(nextIsbn13);
      } else if (nextIsbn10 !== undefined && nextIsbn10 !== null && nextIsbn13 === undefined) {
        nextIsbn13 = isbn10ToIsbn13(nextIsbn10);
      }

      if (nextIsbn10 !== undefined) {
        bookAssignments.push('isbn_10 = ?');
        bookParams.push(nextIsbn10);
      }
      if (nextIsbn13 !== undefined) {
        bookAssignments.push('isbn_13 = ?');
        bookParams.push(nextIsbn13);
      }
      if (b.pageCount !== undefined) {
        bookAssignments.push('page_count = ?');
        bookParams.push(b.pageCount);
      }
      if (b.publishedYear !== undefined) {
        bookAssignments.push('published_year = ?');
        bookParams.push(b.publishedYear);
      }
      if (b.genres !== undefined) {
        bookAssignments.push('genres = ?');
        bookParams.push(JSON.stringify(b.genres));
      }
      if (b.description !== undefined) {
        bookAssignments.push('description = ?');
        bookParams.push(b.description);
      }
      if (b.coverKey !== undefined) {
        bookAssignments.push('cover_key = ?');
        bookParams.push(b.coverKey);
      }
      if (b.coverSourceUrl !== undefined) {
        bookAssignments.push('cover_source_url = ?');
        bookParams.push(b.coverSourceUrl);
      }
      if (b.language !== undefined) {
        bookAssignments.push('language = ?');
        bookParams.push(b.language);
      }
      if (b.publisher !== undefined) {
        bookAssignments.push('publisher = ?');
        bookParams.push(b.publisher);
      }
      if (b.metadataSource !== undefined) {
        bookAssignments.push('metadata_source = ?');
        bookParams.push(b.metadataSource);
      }
      if (b.metadataExternalId !== undefined) {
        bookAssignments.push('metadata_external_id = ?');
        bookParams.push(b.metadataExternalId);
      }
    }

    if (options.coverLocalUri !== undefined) {
      bookAssignments.push('cover_local_uri = ?');
      bookParams.push(options.coverLocalUri);
    }
    if (options.coverPendingUpload !== undefined) {
      bookAssignments.push('cover_pending_upload = ?');
      bookParams.push(options.coverPendingUpload ? 1 : 0);
    }

    if (bookAssignments.length > 0) {
      bookAssignments.push('updated_at = ?', 'is_dirty = 1', 'dirty_updated_at = ?');
      bookParams.push(nowIso, nowIso);
      await db.runAsync(
        `UPDATE books SET ${bookAssignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        ...bookParams,
        existing.ub_book_id
      );
    }
  });

  const updated = await getLocalLibraryEntryById(db, userId, userBookId, false);
  if (!updated) {
    throw new Error('Aktualisierter Bibliothekseintrag nicht gefunden.');
  }
  return updated;
}

/**
 * Entfernt ein Buch ausschließlich per Soft Delete (deleted_at) aus dem Index des Benutzers.
 * Die globale books-Zeile bleibt unangetastet.
 */
export async function softDeleteLocalLibraryEntry(
  db: SqlExecutor,
  userId: string,
  userBookId: string,
  now: () => Date = () => new Date()
): Promise<SoftDeleteResponse> {
  const nowIso = toCanonicalIsoUtc(now());

  const result = await db.runAsync(
    `UPDATE user_books
     SET deleted_at = ?, updated_at = ?, is_dirty = 1, dirty_updated_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    nowIso,
    nowIso,
    nowIso,
    userBookId,
    userId
  );

  if (result.changes === 0) {
    throw new Error('Bibliothekseintrag nicht gefunden.');
  }

  return {
    id: userBookId,
    deletedAt: nowIso,
  };
}

/**
 * Stellt einen per Soft Delete entfernten user_books-Eintrag offline wieder her.
 */
export async function restoreLocalLibraryEntry(
  db: SqlExecutor,
  userId: string,
  userBookId: string,
  now: () => Date = () => new Date()
): Promise<LocalLibraryEntry> {
  const nowIso = toCanonicalIsoUtc(now());

  await db.withTransactionAsync(async () => {
    const existing = await getEntryRowForUser(db, userId, userBookId, true);
    if (!existing) {
      throw new Error('Bibliothekseintrag nicht gefunden.');
    }

    if (existing.ub_deleted_at === null) {
      return;
    }

    const conflictingActive = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM user_books
       WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL AND id != ?`,
      userId,
      existing.ub_book_id,
      userBookId
    );
    if (conflictingActive) {
      throw new Error('Ein aktiver Eintrag für dieses Buch existiert bereits.');
    }

    await db.runAsync(
      `UPDATE user_books
       SET deleted_at = NULL, updated_at = ?, is_dirty = 1, dirty_updated_at = ?
       WHERE id = ? AND user_id = ?`,
      nowIso,
      nowIso,
      userBookId,
      userId
    );
  });

  const restored = await getLocalLibraryEntryById(db, userId, userBookId, false);
  if (!restored) {
    throw new Error('Wiederhergestellter Bibliothekseintrag nicht gefunden.');
  }
  return restored;
}
