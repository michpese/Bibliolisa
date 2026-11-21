import type { LibraryEntry, ReadingStatus } from '@bibliolisa/shared';

export interface SeriesGroup {
  name: string;
  entries: LibraryEntry[];
  counts: Record<ReadingStatus, number>;
  total: number;
  /** Anteil gelesener Bände in Prozent (0–100). */
  percentRead: number;
  /** Nächster ungelesener Band nach dem aktuellen Fortschritt. */
  next: LibraryEntry | null;
}

function compareVolumes(a: LibraryEntry, b: LibraryEntry): number {
  const an = a.book.seriesNumber;
  const bn = b.book.seriesNumber;
  if (an === null && bn === null) {
    return a.book.title.localeCompare(b.book.title, 'de');
  }
  if (an === null) return 1;
  if (bn === null) return -1;
  if (an !== bn) return an - bn;
  return a.book.title.localeCompare(b.book.title, 'de');
}

export function buildSeriesGroup(name: string, entries: LibraryEntry[]): SeriesGroup {
  const sorted = [...entries].sort(compareVolumes);
  const counts: Record<ReadingStatus, number> = {
    unread: 0,
    reading: 0,
    read: 0,
    abandoned: 0,
  };
  let maxProgress = -Infinity;
  for (const entry of sorted) {
    counts[entry.status] += 1;
    if (
      (entry.status === 'read' || entry.status === 'reading') &&
      entry.book.seriesNumber !== null
    ) {
      maxProgress = Math.max(maxProgress, entry.book.seriesNumber);
    }
  }

  const unread = sorted.filter((entry) => entry.status === 'unread');
  const next =
    unread.find(
      (entry) =>
        entry.book.seriesNumber !== null && entry.book.seriesNumber > maxProgress
    ) ??
    unread[0] ??
    null;

  const total = sorted.length;
  return {
    name,
    entries: sorted,
    counts,
    total,
    percentRead: total === 0 ? 0 : Math.round((counts.read / total) * 100),
    next,
  };
}

/** Gruppiert nach Buchreihe (Groß-/Kleinschreibung ignorierend), Reihenfolge = erstes Auftreten. */
export function groupBySeries(entries: LibraryEntry[]): {
  series: SeriesGroup[];
  standalone: LibraryEntry[];
} {
  const groups = new Map<string, { name: string; entries: LibraryEntry[] }>();
  const standalone: LibraryEntry[] = [];

  for (const entry of entries) {
    const name = entry.book.seriesName?.trim();
    if (!name) {
      standalone.push(entry);
      continue;
    }
    const key = name.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, { name, entries: [entry] });
    }
  }

  return {
    series: Array.from(groups.values()).map((group) =>
      buildSeriesGroup(group.name, group.entries)
    ),
    standalone,
  };
}
