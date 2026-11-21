import type { Book, ReadingStatus } from '@bibliolisa/shared';

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

/** Tailwind-Klassen je Status (Hintergrund / Text) – funktionieren in Light & Dark Mode. */
export const STATUS_STYLES: Record<
  ReadingStatus,
  { badge: string; dot: string; bar: string; active: string }
> = {
  unread: {
    badge: 'bg-secondary text-secondary-foreground',
    dot: 'bg-muted-foreground/50',
    bar: 'bg-muted-foreground/25',
    active: 'bg-card text-foreground shadow-sm ring-1 ring-border',
  },
  reading: {
    badge: 'bg-primary/15 text-primary',
    dot: 'bg-primary',
    bar: 'bg-primary',
    active: 'bg-primary text-primary-foreground',
  },
  read: {
    badge: 'bg-success/15 text-success',
    dot: 'bg-success',
    bar: 'bg-success',
    active: 'bg-success text-success-foreground',
  },
  abandoned: {
    badge: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive/70',
    bar: 'bg-destructive/60',
    active: 'bg-destructive text-destructive-foreground',
  },
};

export const SORT_OPTIONS = [
  { value: 'series', label: 'Buchreihe' },
  { value: 'author', label: 'Autor' },
  { value: 'title', label: 'Titel' },
  { value: 'status', label: 'Lesestatus' },
  { value: 'added_at', label: 'Hinzugefügt' },
  { value: 'rating', label: 'Bewertung' },
  { value: 'published_year', label: 'Erscheinungsjahr' },
] as const;

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

const dateFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : dateFormatter.format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : dateTimeFormatter.format(date);
}

/** "1,5" / "1.5" / "" -> number | null (NaN -> undefined = ungültig). */
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
