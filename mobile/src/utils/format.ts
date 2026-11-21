import type {
  Book,
  LibraryEntry,
  LibrarySortField,
  MetadataProviderId,
  ReadingStatus,
  UpdateLibraryEntry,
} from '@bibliolisa/shared';

export const STATUS_ORDER: ReadingStatus[] = [
  'unread',
  'reading',
  'read',
  'abandoned',
];

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: 'Ungelesen',
  reading: 'Lese ich gerade',
  read: 'Gelesen',
  abandoned: 'Abgebrochen',
};

export const STATUS_SHORT_LABELS: Record<ReadingStatus, string> = {
  unread: 'Ungelesen',
  reading: 'Am Lesen',
  read: 'Gelesen',
  abandoned: 'Abgebrochen',
};

export const SORT_OPTIONS: Array<{ value: LibrarySortField; label: string }> = [
  { value: 'series', label: 'Buchreihe' },
  { value: 'added_at', label: 'Hinzugefügt' },
  { value: 'author', label: 'Autor' },
  { value: 'title', label: 'Titel' },
  { value: 'status', label: 'Lesestatus' },
  { value: 'rating', label: 'Bewertung' },
  { value: 'published_year', label: 'Erscheinungsjahr' },
];

export const PROVIDER_LABELS: Record<MetadataProviderId, string> = {
  hardcover: 'Hardcover',
  google_books: 'Google Books',
  openlibrary: 'Open Library',
};

export function formatSeriesNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

export function formatAuthors(book: Pick<Book, 'authors'>): string {
  return book.authors.length > 0 ? book.authors.join(', ') : 'Unbekannter Autor';
}

export function formatSeriesLabel(
  book: Pick<Book, 'seriesName' | 'seriesNumber'>
): string | null {
  if (!book.seriesName) return null;
  const nr = formatSeriesNumber(book.seriesNumber);
  return nr ? `${book.seriesName} · Band ${nr}` : book.seriesName;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${formatDate(iso)}, ${hh}:${min}`;
}

/**
 * Konvertiert Eingaben wie "1,5" oder "1.5" in number | null (undefined = ungültig).
 */
export function parseDecimal(input: string): number | null | undefined {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export function parseOptionalInt(input: string): number | null | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : undefined;
}

export function splitList(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of input.split(/[,;\n]/)) {
    const value = part.trim();
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      result.push(value);
    }
  }
  return result;
}

/**
 * Leitet startedAt/finishedAt-Zeitstempel für Statuswechsel ab.
 */
export function statusTransitionPatch(
  entry: Pick<LibraryEntry, 'startedAt' | 'finishedAt'>,
  status: ReadingStatus
): Pick<UpdateLibraryEntry, 'status' | 'startedAt' | 'finishedAt'> {
  const now = new Date().toISOString();
  switch (status) {
    case 'unread':
      return { status, startedAt: null, finishedAt: null };
    case 'reading':
      return { status, startedAt: entry.startedAt ?? now, finishedAt: null };
    case 'read':
      return { status, startedAt: entry.startedAt ?? now, finishedAt: now };
    case 'abandoned':
      return { status, startedAt: entry.startedAt ?? now, finishedAt: null };
  }
}
