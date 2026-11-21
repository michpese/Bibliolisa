import type { SortOrder } from '../schemas/common.js';
import type { LibraryEntry, LibrarySortField } from '../schemas/user-book.js';

const STATUS_RANK: Record<LibraryEntry['status'], number> = {
  reading: 1,
  unread: 2,
  read: 3,
  abandoned: 4,
};

/**
 * Liefert die Standard-Sortierrichtung für ein Sortierfeld gemäß Spezifikation.
 */
export function getDefaultSortOrder(sort: LibrarySortField): SortOrder {
  switch (sort) {
    case 'added_at':
    case 'rating':
    case 'published_year':
      return 'desc';
    case 'series':
    case 'author':
    case 'title':
    case 'status':
      return 'asc';
  }
}

function compareLowerText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

function compareNullableTextWithNullsLast(
  a: string | null | undefined,
  b: string | null | undefined,
  direction: 1 | -1
): number {
  const aVal = a?.trim() ? a.trim() : null;
  const bVal = b?.trim() ? b.trim() : null;
  if (aVal === null && bVal === null) return 0;
  if (aVal === null) return 1;
  if (bVal === null) return -1;
  return compareLowerText(aVal, bVal) * direction;
}

function compareNullableNumberWithNullsLast(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: 1 | -1
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return (a - b) * direction;
}

function compareTieBreaker(a: LibraryEntry, b: LibraryEntry): number {
  const titleCmp = compareLowerText(a.book.title, b.book.title);
  if (titleCmp !== 0) return titleCmp;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Deterministischer Comparator für Bibliothekseinträge.
 * NULL-Werte (z. B. fehlende Reihe, Autor, Bewertung, Erscheinungsjahr) bleiben
 * sowohl bei `asc` als auch bei `desc` stets am Listenende.
 */
export function compareLibraryEntries(
  a: LibraryEntry,
  b: LibraryEntry,
  sort: LibrarySortField = 'added_at',
  order?: SortOrder
): number {
  const resolvedOrder = order ?? getDefaultSortOrder(sort);
  const dir: 1 | -1 = resolvedOrder === 'asc' ? 1 : -1;

  switch (sort) {
    case 'series': {
      const seriesCmp = compareNullableTextWithNullsLast(
        a.book.seriesName,
        b.book.seriesName,
        dir
      );
      if (seriesCmp !== 0) return seriesCmp;

      const numCmp = compareNullableNumberWithNullsLast(
        a.book.seriesNumber,
        b.book.seriesNumber,
        dir
      );
      if (numCmp !== 0) return numCmp;

      return compareTieBreaker(a, b);
    }

    case 'author': {
      const primaryA = a.book.authors[0] ?? null;
      const primaryB = b.book.authors[0] ?? null;
      const authorCmp = compareNullableTextWithNullsLast(primaryA, primaryB, dir);
      if (authorCmp !== 0) return authorCmp;
      return compareTieBreaker(a, b);
    }

    case 'title': {
      const titleCmp = compareLowerText(a.book.title, b.book.title) * dir;
      if (titleCmp !== 0) return titleCmp;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    }

    case 'status': {
      const statusCmp = (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir;
      if (statusCmp !== 0) return statusCmp;
      if (a.updatedAt > b.updatedAt) return -1;
      if (a.updatedAt < b.updatedAt) return 1;
      return compareTieBreaker(a, b);
    }

    case 'added_at': {
      if (a.addedAt < b.addedAt) return -1 * dir;
      if (a.addedAt > b.addedAt) return 1 * dir;
      return compareTieBreaker(a, b);
    }

    case 'rating': {
      const ratingCmp = compareNullableNumberWithNullsLast(a.rating, b.rating, dir);
      if (ratingCmp !== 0) return ratingCmp;
      return compareTieBreaker(a, b);
    }

    case 'published_year': {
      const yearCmp = compareNullableNumberWithNullsLast(
        a.book.publishedYear,
        b.book.publishedYear,
        dir
      );
      if (yearCmp !== 0) return yearCmp;
      return compareTieBreaker(a, b);
    }
  }
}

/**
 * Sortiert eine Kopie der Bibliothekseinträge deterministisch nach dem gewählten Modus.
 */
export function sortLibraryEntries(
  entries: readonly LibraryEntry[],
  sort: LibrarySortField = 'added_at',
  order?: SortOrder
): LibraryEntry[] {
  return [...entries].sort((a, b) => compareLibraryEntries(a, b, sort, order));
}
