import crypto from 'node:crypto';
import {
  ExportEntrySchema,
  ExportImportEnvelopeSchema,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  toCanonicalIsoUtc,
  type ExportEntry,
  type ExportPayload,
  type ImportResult,
} from '@bibliolisa/shared';
import type { DatabaseContext } from '../db/client.js';
import { AppError } from '../plugins/error-handler.js';
import type { LibraryService } from './library.service.js';

interface UserIdentityRow {
  id: string;
  username: string;
  display_name: string | null;
}

interface ExistingBookMetaRow {
  id: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ExistingUserBookRow {
  id: string;
  user_id: string;
  book_id: string;
  status: ExportEntry['status'];
  rating: number | null;
  notes: string | null;
  added_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

const CSV_HEADERS = [
  'title',
  'subtitle',
  'authors',
  'series_name',
  'series_number',
  'isbn_10',
  'isbn_13',
  'page_count',
  'published_year',
  'genres',
  'language',
  'publisher',
  'status',
  'rating',
  'notes',
  'added_at',
  'started_at',
  'finished_at',
  'metadata_source',
] as const;

export function formatCsvCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : '';
  }

  let value = raw;
  // CSV-Formula-Injection-Schutz für Excel / LibreOffice / Google Sheets
  if (/^[=+\-@\t\r]/.test(value) || /^[ \t]+[=+\-@]/.test(value)) {
    value = `'${value}`;
  }

  if (/[",;\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export class ExportService {
  private readonly dbCtx: DatabaseContext;
  private readonly libraryService: LibraryService;
  private readonly now: () => Date;

  constructor(
    dbCtx: DatabaseContext,
    libraryService: LibraryService,
    now?: () => Date
  ) {
    this.dbCtx = dbCtx;
    this.libraryService = libraryService;
    this.now = now ?? (() => new Date());
  }

  exportJson(userId: string): { filename: string; payload: ExportPayload } {
    const userRow = this.dbCtx.sqlite
      .prepare('SELECT id, username, display_name FROM users WHERE id = ?')
      .get(userId) as UserIdentityRow | undefined;

    if (!userRow) {
      throw new AppError(401, 'UNAUTHORIZED', 'Benutzerkonto nicht gefunden.');
    }

    const entries = this.libraryService.listAllActiveForUser(userId);
    const nowIso = toCanonicalIsoUtc(this.now());

    const exportEntries: ExportEntry[] = entries.map((entry) => ({
      userBookId: entry.id,
      status: entry.status,
      rating: entry.rating,
      notes: entry.notes,
      addedAt: entry.addedAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      book: entry.book,
    }));

    return {
      filename: `bibliolisa-export-${nowIso.slice(0, 10)}.json`,
      payload: {
        version: 1,
        exportedAt: nowIso,
        user: {
          id: userRow.id,
          username: userRow.username,
          displayName: userRow.display_name,
        },
        entries: exportEntries,
      },
    };
  }

  exportCsv(userId: string): { filename: string; csv: string } {
    const entries = this.libraryService.listAllActiveForUser(userId);
    const nowIso = toCanonicalIsoUtc(this.now());

    const lines: string[] = [CSV_HEADERS.join(',')];

    for (const entry of entries) {
      const b = entry.book;
      const row = [
        formatCsvCell(b.title),
        formatCsvCell(b.subtitle),
        formatCsvCell(b.authors.join('; ')),
        formatCsvCell(b.seriesName),
        formatCsvCell(b.seriesNumber),
        formatCsvCell(b.isbn10),
        formatCsvCell(b.isbn13),
        formatCsvCell(b.pageCount),
        formatCsvCell(b.publishedYear),
        formatCsvCell(b.genres.join('; ')),
        formatCsvCell(b.language),
        formatCsvCell(b.publisher),
        formatCsvCell(entry.status),
        formatCsvCell(entry.rating),
        formatCsvCell(entry.notes),
        formatCsvCell(entry.addedAt),
        formatCsvCell(entry.startedAt),
        formatCsvCell(entry.finishedAt),
        formatCsvCell(b.metadataSource),
      ];
      lines.push(row.join(','));
    }

    // UTF-8 BOM für nahtloses Öffnen in Excel inkl. Umlauten
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    return {
      filename: `bibliolisa-export-${nowIso.slice(0, 10)}.csv`,
      csv,
    };
  }

  importJson(userId: string, rawBody: unknown): ImportResult {
    const envelope = ExportImportEnvelopeSchema.parse(rawBody);
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);

    return this.dbCtx.sqlite.transaction((): ImportResult => {
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ index: number; message: string }> = [];

      const selectBookByIdStmt = this.dbCtx.sqlite.prepare(
        'SELECT id, updated_at, deleted_at FROM books WHERE id = ?'
      );
      const selectBookByIsbn13Stmt = this.dbCtx.sqlite.prepare(
        'SELECT id, updated_at, deleted_at FROM books WHERE isbn_13 = ? AND deleted_at IS NULL LIMIT 1'
      );
      const selectBookByIsbn10Stmt = this.dbCtx.sqlite.prepare(
        'SELECT id, updated_at, deleted_at FROM books WHERE isbn_10 = ? AND deleted_at IS NULL LIMIT 1'
      );
      const insertBookStmt = this.dbCtx.sqlite.prepare(
        `INSERT INTO books (
          id, title, subtitle, authors, primary_author,
          series_name, series_number, isbn_10, isbn_13,
          page_count, published_year, genres, description,
          cover_key, cover_source_url, language, publisher,
          metadata_source, metadata_external_id, created_by_user_id,
          created_at, updated_at, server_updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      );
      const updateBookStmt = this.dbCtx.sqlite.prepare(
        `UPDATE books SET
          title = ?, subtitle = ?, authors = ?, primary_author = ?,
          series_name = ?, series_number = ?, isbn_10 = ?, isbn_13 = ?,
          page_count = ?, published_year = ?, genres = ?, description = ?,
          cover_key = COALESCE(?, cover_key),
          cover_source_url = COALESCE(?, cover_source_url),
          language = ?, publisher = ?,
          metadata_source = ?, metadata_external_id = ?,
          updated_at = ?, server_updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`
      );

      const selectActiveUserBookStmt = this.dbCtx.sqlite.prepare(
        `SELECT id, user_id, book_id, status, rating, notes,
                added_at, started_at, finished_at, updated_at, deleted_at
         FROM user_books
         WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL
         LIMIT 1`
      );
      const selectDeletedUserBookByIdStmt = this.dbCtx.sqlite.prepare(
        `SELECT id, user_id, book_id, status, rating, notes,
                added_at, started_at, finished_at, updated_at, deleted_at
         FROM user_books
         WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`
      );
      const selectDeletedUserBookByBookStmt = this.dbCtx.sqlite.prepare(
        `SELECT id, user_id, book_id, status, rating, notes,
                added_at, started_at, finished_at, updated_at, deleted_at
         FROM user_books
         WHERE user_id = ? AND book_id = ? AND deleted_at IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      );
      const userBookIdExistsStmt = this.dbCtx.sqlite.prepare(
        'SELECT 1 FROM user_books WHERE id = ?'
      );
      const insertUserBookStmt = this.dbCtx.sqlite.prepare(
        `INSERT INTO user_books (
          id, user_id, book_id, status, rating, notes,
          added_at, started_at, finished_at,
          created_at, updated_at, server_updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      );
      const updateUserBookStmt = this.dbCtx.sqlite.prepare(
        `UPDATE user_books SET
          status = ?, rating = ?, notes = ?,
          added_at = ?, started_at = ?, finished_at = ?,
          deleted_at = NULL, updated_at = ?, server_updated_at = ?
        WHERE id = ? AND user_id = ?`
      );

      for (let i = 0; i < envelope.entries.length; i++) {
        const parsed = ExportEntrySchema.safeParse(envelope.entries[i]);
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
            .join('; ');
          errors.push({ index: i, message });
          continue;
        }

        const entry = parsed.data;
        const book = entry.book;

        let isbn10 = book.isbn10;
        let isbn13 = book.isbn13;
        if (isbn13 !== null && isbn10 === null) {
          isbn10 = isbn13ToIsbn10(isbn13);
        } else if (isbn10 !== null && isbn13 === null) {
          isbn13 = isbn10ToIsbn13(isbn10);
        }
        const primaryAuthor = book.authors[0]?.trim() || null;

        let matchedBook = selectBookByIdStmt.get(book.id) as
          | ExistingBookMetaRow
          | undefined;

        if (matchedBook && matchedBook.deleted_at !== null) {
          matchedBook = undefined;
        }

        if (!matchedBook && isbn13 !== null) {
          matchedBook = selectBookByIsbn13Stmt.get(isbn13) as
            | ExistingBookMetaRow
            | undefined;
        }
        if (!matchedBook && isbn10 !== null) {
          matchedBook = selectBookByIsbn10Stmt.get(isbn10) as
            | ExistingBookMetaRow
            | undefined;
        }

        let resolvedBookId: string;
        if (matchedBook) {
          resolvedBookId = matchedBook.id;
          if (book.updatedAt > matchedBook.updated_at) {
            updateBookStmt.run(
              book.title,
              book.subtitle,
              JSON.stringify(book.authors),
              primaryAuthor,
              book.seriesName,
              book.seriesNumber,
              isbn10,
              isbn13,
              book.pageCount,
              book.publishedYear,
              JSON.stringify(book.genres),
              book.description,
              book.coverKey,
              book.coverSourceUrl,
              book.language,
              book.publisher,
              book.metadataSource,
              book.metadataExternalId,
              book.updatedAt,
              this.dbCtx.nextServerTimestamp(nowDate),
              resolvedBookId
            );
          }
        } else {
          const idTaken = selectBookByIdStmt.get(book.id) as
            | ExistingBookMetaRow
            | undefined;
          resolvedBookId = idTaken ? crypto.randomUUID() : book.id;
          insertBookStmt.run(
            resolvedBookId,
            book.title,
            book.subtitle,
            JSON.stringify(book.authors),
            primaryAuthor,
            book.seriesName,
            book.seriesNumber,
            isbn10,
            isbn13,
            book.pageCount,
            book.publishedYear,
            JSON.stringify(book.genres),
            book.description,
            book.coverKey,
            book.coverSourceUrl,
            book.language,
            book.publisher,
            book.metadataSource,
            book.metadataExternalId,
            userId,
            book.createdAt,
            book.updatedAt,
            this.dbCtx.nextServerTimestamp(nowDate)
          );
        }

        const activeUb = selectActiveUserBookStmt.get(
          userId,
          resolvedBookId
        ) as ExistingUserBookRow | undefined;

        if (activeUb) {
          const isSameContent =
            activeUb.status === entry.status &&
            activeUb.rating === entry.rating &&
            activeUb.notes === entry.notes &&
            activeUb.added_at === entry.addedAt &&
            activeUb.started_at === entry.startedAt &&
            activeUb.finished_at === entry.finishedAt;

          if (!isSameContent && entry.updatedAt > activeUb.updated_at) {
            updateUserBookStmt.run(
              entry.status,
              entry.rating,
              entry.notes,
              entry.addedAt,
              entry.startedAt,
              entry.finishedAt,
              entry.updatedAt,
              this.dbCtx.nextServerTimestamp(nowDate),
              activeUb.id,
              userId
            );
            updated += 1;
          } else {
            skipped += 1;
          }
          continue;
        }

        const deletedUb =
          (selectDeletedUserBookByIdStmt.get(entry.userBookId, userId) as
            | ExistingUserBookRow
            | undefined) ??
          (selectDeletedUserBookByBookStmt.get(userId, resolvedBookId) as
            | ExistingUserBookRow
            | undefined);

        if (deletedUb) {
          const restoredUpdatedAt =
            entry.updatedAt > nowIso ? entry.updatedAt : nowIso;
          updateUserBookStmt.run(
            entry.status,
            entry.rating,
            entry.notes,
            entry.addedAt,
            entry.startedAt,
            entry.finishedAt,
            restoredUpdatedAt,
            this.dbCtx.nextServerTimestamp(nowDate),
            deletedUb.id,
            userId
          );
          imported += 1;
          continue;
        }

        const idOccupied = Boolean(userBookIdExistsStmt.get(entry.userBookId));
        const targetUserBookId = idOccupied
          ? crypto.randomUUID()
          : entry.userBookId;

        insertUserBookStmt.run(
          targetUserBookId,
          userId,
          resolvedBookId,
          entry.status,
          entry.rating,
          entry.notes,
          entry.addedAt,
          entry.startedAt,
          entry.finishedAt,
          entry.createdAt,
          entry.updatedAt,
          this.dbCtx.nextServerTimestamp(nowDate)
        );
        imported += 1;
      }

      return {
        imported,
        updated,
        skipped,
        errors,
      };
    })();
  }
}
