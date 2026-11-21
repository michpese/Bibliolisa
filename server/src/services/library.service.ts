import crypto from 'node:crypto';
import {
  getDefaultSortOrder,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  toCanonicalIsoUtc,
  type CreateLibraryEntry,
  type FacetCount,
  type LibraryEntry,
  type LibraryFacetsResponse,
  type LibraryListResponse,
  type LibraryQuery,
  type SoftDeleteResponse,
  type StatusCounts,
  type UpdateLibraryEntry,
} from '@bibliolisa/shared';
import type { DatabaseContext } from '../db/client.js';
import { AppError } from '../plugins/error-handler.js';

interface JoinedLibraryRow {
  ub_id: string;
  ub_user_id: string;
  ub_book_id: string;
  ub_status: LibraryEntry['status'];
  ub_rating: number | null;
  ub_notes: string | null;
  ub_added_at: string;
  ub_started_at: string | null;
  ub_finished_at: string | null;
  ub_created_at: string;
  ub_updated_at: string;
  ub_deleted_at: string | null;
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
  b_language: string | null;
  b_publisher: string | null;
  b_metadata_source: LibraryEntry['book']['metadataSource'];
  b_metadata_external_id: string | null;
  b_created_at: string;
  b_updated_at: string;
  b_deleted_at: string | null;
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
  b.language AS b_language,
  b.publisher AS b_publisher,
  b.metadata_source AS b_metadata_source,
  b.metadata_external_id AS b_metadata_external_id,
  b.created_at AS b_created_at,
  b.updated_at AS b_updated_at,
  b.deleted_at AS b_deleted_at
`;

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

function mapJoinedRow(row: JoinedLibraryRow): LibraryEntry {
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

function buildOrderByClause(query: LibraryQuery): string {
  const order = query.order ?? getDefaultSortOrder(query.sort);
  const dir = order === 'desc' ? 'DESC' : 'ASC';

  switch (query.sort) {
    case 'series':
      return `
        (b.series_name IS NULL OR TRIM(b.series_name) = '') ASC,
        LOWER(b.series_name) ${dir},
        (b.series_number IS NULL) ASC,
        b.series_number ${dir},
        LOWER(b.title) ASC,
        ub.id ASC
      `;
    case 'author':
      return `
        (b.primary_author IS NULL OR TRIM(b.primary_author) = '') ASC,
        LOWER(b.primary_author) ${dir},
        LOWER(b.title) ASC,
        ub.id ASC
      `;
    case 'title':
      return `LOWER(b.title) ${dir}, ub.id ASC`;
    case 'status':
      return `
        (CASE ub.status
          WHEN 'reading' THEN 1
          WHEN 'unread' THEN 2
          WHEN 'read' THEN 3
          WHEN 'abandoned' THEN 4
        END) ${dir},
        ub.updated_at DESC,
        LOWER(b.title) ASC,
        ub.id ASC
      `;
    case 'added_at':
      return `ub.added_at ${dir}, LOWER(b.title) ASC, ub.id ASC`;
    case 'rating':
      return `(ub.rating IS NULL) ASC, ub.rating ${dir}, LOWER(b.title) ASC, ub.id ASC`;
    case 'published_year':
      return `(b.published_year IS NULL) ASC, b.published_year ${dir}, LOWER(b.title) ASC, ub.id ASC`;
  }
}

export class LibraryService {
  private readonly dbCtx: DatabaseContext;
  private readonly now: () => Date;

  constructor(dbCtx: DatabaseContext, now?: () => Date) {
    this.dbCtx = dbCtx;
    this.now = now ?? (() => new Date());
  }

  private getEntryRowForUser(
    userId: string,
    userBookId: string,
    includeDeleted = false
  ): JoinedLibraryRow | undefined {
    const deletedClause = includeDeleted ? '' : 'AND ub.deleted_at IS NULL';
    return this.dbCtx.sqlite
      .prepare(
        `SELECT ${JOINED_SELECT}
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id
         WHERE ub.id = ? AND ub.user_id = ? AND b.deleted_at IS NULL ${deletedClause}`
      )
      .get(userBookId, userId) as JoinedLibraryRow | undefined;
  }

  list(userId: string, query: LibraryQuery): LibraryListResponse {
    const conditions: string[] = [
      'ub.user_id = ?',
      'ub.deleted_at IS NULL',
      'b.deleted_at IS NULL',
    ];
    const params: unknown[] = [userId];

    if (query.status !== undefined) {
      conditions.push('ub.status = ?');
      params.push(query.status);
    }

    if (query.minRating !== undefined) {
      conditions.push('ub.rating >= ?');
      params.push(query.minRating);
    }

    if (query.maxRating !== undefined) {
      conditions.push('ub.rating <= ?');
      params.push(query.maxRating);
    }

    if (query.genre !== undefined) {
      conditions.push(
        'EXISTS (SELECT 1 FROM json_each(b.genres) WHERE LOWER(json_each.value) = LOWER(?))'
      );
      params.push(query.genre);
    }

    if (query.author !== undefined) {
      conditions.push(
        '(LOWER(b.primary_author) = LOWER(?) OR EXISTS (SELECT 1 FROM json_each(b.authors) WHERE LOWER(json_each.value) = LOWER(?)))'
      );
      params.push(query.author, query.author);
    }

    if (query.series !== undefined) {
      conditions.push('LOWER(b.series_name) = LOWER(?)');
      params.push(query.series);
    }

    if (query.q !== undefined) {
      const pattern = `%${escapeLikePattern(query.q.toLowerCase())}%`;
      const cleanedIsbnQuery = query.q.replace(/[\s-]+/g, '').toLowerCase();
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

    const whereClause = conditions.join(' AND ');
    const countRow = this.dbCtx.sqlite
      .prepare(
        `SELECT COUNT(*) AS total
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id
         WHERE ${whereClause}`
      )
      .get(...params) as { total: number };

    const total = countRow.total;
    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    const offset = (query.page - 1) * query.limit;
    const orderBy = buildOrderByClause(query);

    const rows = this.dbCtx.sqlite
      .prepare(
        `SELECT ${JOINED_SELECT}
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, offset) as JoinedLibraryRow[];

    return {
      items: rows.map(mapJoinedRow),
      total,
      page: query.page,
      limit: query.limit,
      totalPages,
    };
  }

  getFacets(userId: string): LibraryFacetsResponse {
    const genres = this.dbCtx.sqlite
      .prepare(
        `SELECT json_each.value AS value, COUNT(DISTINCT ub.id) AS count
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id,
         json_each(b.genres)
         WHERE ub.user_id = ? AND ub.deleted_at IS NULL AND b.deleted_at IS NULL
         GROUP BY LOWER(json_each.value)
         ORDER BY count DESC, LOWER(value) ASC`
      )
      .all(userId) as FacetCount[];

    const series = this.dbCtx.sqlite
      .prepare(
        `SELECT b.series_name AS value, COUNT(*) AS count
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id
         WHERE ub.user_id = ?
           AND ub.deleted_at IS NULL
           AND b.deleted_at IS NULL
           AND b.series_name IS NOT NULL
           AND TRIM(b.series_name) != ''
         GROUP BY LOWER(b.series_name)
         ORDER BY count DESC, LOWER(value) ASC`
      )
      .all(userId) as FacetCount[];

    const authors = this.dbCtx.sqlite
      .prepare(
        `SELECT json_each.value AS value, COUNT(DISTINCT ub.id) AS count
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id,
         json_each(b.authors)
         WHERE ub.user_id = ? AND ub.deleted_at IS NULL AND b.deleted_at IS NULL
         GROUP BY LOWER(json_each.value)
         ORDER BY count DESC, LOWER(value) ASC`
      )
      .all(userId) as FacetCount[];

    const statusRows = this.dbCtx.sqlite
      .prepare(
        `SELECT ub.status AS status, COUNT(*) AS count
         FROM user_books ub
         INNER JOIN books b ON b.id = ub.book_id
         WHERE ub.user_id = ? AND ub.deleted_at IS NULL AND b.deleted_at IS NULL
         GROUP BY ub.status`
      )
      .all(userId) as Array<{ status: LibraryEntry['status']; count: number }>;

    const statusCounts: StatusCounts = {
      unread: 0,
      reading: 0,
      read: 0,
      abandoned: 0,
    };
    let total = 0;
    for (const row of statusRows) {
      statusCounts[row.status] = row.count;
      total += row.count;
    }

    return {
      genres,
      series,
      authors,
      statusCounts,
      total,
    };
  }

  getById(userId: string, userBookId: string): LibraryEntry {
    const row = this.getEntryRowForUser(userId, userBookId, false);
    if (!row) {
      throw new AppError(
        404,
        'LIBRARY_ENTRY_NOT_FOUND',
        'Bibliothekseintrag nicht gefunden.'
      );
    }
    return mapJoinedRow(row);
  }

  create(userId: string, input: CreateLibraryEntry): LibraryEntry {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const userBookId = input.id ?? crypto.randomUUID();

    this.dbCtx.sqlite.transaction(() => {
      const existingEntryId = this.dbCtx.sqlite
        .prepare('SELECT id FROM user_books WHERE id = ?')
        .get(userBookId) as { id: string } | undefined;
      if (existingEntryId) {
        throw new AppError(
          409,
          'DUPLICATE_ENTRY_ID',
          'Ein Bibliothekseintrag mit dieser ID existiert bereits.'
        );
      }

      let resolvedBookId: string;

      if (input.bookId !== undefined) {
        const existingBook = this.dbCtx.sqlite
          .prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL')
          .get(input.bookId) as { id: string } | undefined;
        if (!existingBook) {
          throw new AppError(
            404,
            'BOOK_NOT_FOUND',
            'Angegebenes Buch wurde nicht gefunden.'
          );
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
          const existingById = this.dbCtx.sqlite
            .prepare('SELECT id, deleted_at FROM books WHERE id = ?')
            .get(bookInput.id) as
            | { id: string; deleted_at: string | null }
            | undefined;
          if (existingById) {
            if (existingById.deleted_at !== null) {
              throw new AppError(
                409,
                'BOOK_DELETED',
                'Das angegebene Buch wurde gelöscht.'
              );
            }
            matchedBookId = existingById.id;
          }
        } else {
          if (isbn13 !== null) {
            const byIsbn13 = this.dbCtx.sqlite
              .prepare(
                'SELECT id FROM books WHERE isbn_13 = ? AND deleted_at IS NULL LIMIT 1'
              )
              .get(isbn13) as { id: string } | undefined;
            if (byIsbn13) {
              matchedBookId = byIsbn13.id;
            }
          }
          if (matchedBookId === null && isbn10 !== null) {
            const byIsbn10 = this.dbCtx.sqlite
              .prepare(
                'SELECT id FROM books WHERE isbn_10 = ? AND deleted_at IS NULL LIMIT 1'
              )
              .get(isbn10) as { id: string } | undefined;
            if (byIsbn10) {
              matchedBookId = byIsbn10.id;
            }
          }
        }

        if (matchedBookId !== null) {
          resolvedBookId = matchedBookId;
        } else {
          resolvedBookId = bookInput.id ?? crypto.randomUUID();
          const primaryAuthor = bookInput.authors[0]?.trim() || null;
          const bookServerTs = this.dbCtx.nextServerTimestamp(nowDate);

          this.dbCtx.sqlite
            .prepare(
              `INSERT INTO books (
                id, title, subtitle, authors, primary_author,
                series_name, series_number, isbn_10, isbn_13,
                page_count, published_year, genres, description,
                cover_key, cover_source_url, language, publisher,
                metadata_source, metadata_external_id, created_by_user_id,
                created_at, updated_at, server_updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
            )
            .run(
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
              bookInput.language ?? null,
              bookInput.publisher ?? null,
              bookInput.metadataSource,
              bookInput.metadataExternalId ?? null,
              userId,
              nowIso,
              nowIso,
              bookServerTs
            );
        }
      } else {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Entweder bookId oder book muss angegeben werden.'
        );
      }

      const duplicateActive = this.dbCtx.sqlite
        .prepare(
          'SELECT id FROM user_books WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL'
        )
        .get(userId, resolvedBookId) as { id: string } | undefined;

      if (duplicateActive) {
        throw new AppError(
          409,
          'DUPLICATE_LIBRARY_ENTRY',
          'Dieses Buch befindet sich bereits in deinem Index.'
        );
      }

      const entryServerTs = this.dbCtx.nextServerTimestamp(nowDate);
      const addedAt = input.addedAt ?? nowIso;

      this.dbCtx.sqlite
        .prepare(
          `INSERT INTO user_books (
            id, user_id, book_id, status, rating, notes,
            added_at, started_at, finished_at,
            created_at, updated_at, server_updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
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
          entryServerTs
        );
    })();

    return this.getById(userId, userBookId);
  }

  update(
    userId: string,
    userBookId: string,
    input: UpdateLibraryEntry
  ): LibraryEntry {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);

    this.dbCtx.sqlite.transaction(() => {
      const existing = this.getEntryRowForUser(userId, userBookId, false);
      if (!existing) {
        throw new AppError(
          404,
          'LIBRARY_ENTRY_NOT_FOUND',
          'Bibliothekseintrag nicht gefunden.'
        );
      }

      const userAssignments: string[] = [];
      const userParams: unknown[] = [];

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
        userAssignments.push('updated_at = ?', 'server_updated_at = ?');
        userParams.push(nowIso, this.dbCtx.nextServerTimestamp(nowDate));
        this.dbCtx.sqlite
          .prepare(
            `UPDATE user_books SET ${userAssignments.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
          )
          .run(...userParams, userBookId, userId);
      }

      if (input.book !== undefined) {
        const b = input.book;
        const bookAssignments: string[] = [];
        const bookParams: unknown[] = [];

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
          bookParams.push(
            JSON.stringify(b.authors),
            b.authors[0]?.trim() || null
          );
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

        if (bookAssignments.length > 0) {
          bookAssignments.push('updated_at = ?', 'server_updated_at = ?');
          bookParams.push(nowIso, this.dbCtx.nextServerTimestamp(nowDate));
          this.dbCtx.sqlite
            .prepare(
              `UPDATE books SET ${bookAssignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`
            )
            .run(...bookParams, existing.ub_book_id);
        }
      }
    })();

    return this.getById(userId, userBookId);
  }

  softDelete(userId: string, userBookId: string): SoftDeleteResponse {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const serverTs = this.dbCtx.nextServerTimestamp(nowDate);

    const result = this.dbCtx.sqlite
      .prepare(
        `UPDATE user_books
         SET deleted_at = ?, updated_at = ?, server_updated_at = ?
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      )
      .run(nowIso, nowIso, serverTs, userBookId, userId);

    if (result.changes === 0) {
      throw new AppError(
        404,
        'LIBRARY_ENTRY_NOT_FOUND',
        'Bibliothekseintrag nicht gefunden.'
      );
    }

    return {
      id: userBookId,
      deletedAt: nowIso,
    };
  }

  restore(userId: string, userBookId: string): LibraryEntry {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);

    this.dbCtx.sqlite.transaction(() => {
      const existing = this.getEntryRowForUser(userId, userBookId, true);
      if (!existing) {
        throw new AppError(
          404,
          'LIBRARY_ENTRY_NOT_FOUND',
          'Bibliothekseintrag nicht gefunden.'
        );
      }

      if (existing.ub_deleted_at === null) {
        return;
      }

      const conflictingActive = this.dbCtx.sqlite
        .prepare(
          `SELECT id FROM user_books
           WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL AND id != ?`
        )
        .get(userId, existing.ub_book_id, userBookId) as
        | { id: string }
        | undefined;

      if (conflictingActive) {
        throw new AppError(
          409,
          'DUPLICATE_LIBRARY_ENTRY',
          'Ein aktiver Eintrag für dieses Buch existiert bereits in deinem Index.'
        );
      }

      const serverTs = this.dbCtx.nextServerTimestamp(nowDate);
      this.dbCtx.sqlite
        .prepare(
          `UPDATE user_books
           SET deleted_at = NULL, updated_at = ?, server_updated_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(nowIso, serverTs, userBookId, userId);
    })();

    return this.getById(userId, userBookId);
  }
}
