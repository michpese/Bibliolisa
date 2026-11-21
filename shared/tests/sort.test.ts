import { describe, expect, it } from 'vitest';
import { sortLibraryEntries, type LibraryEntry } from '../src/index.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeEntry(
  suffix: string,
  overrides: {
    title?: string;
    authors?: string[];
    seriesName?: string | null;
    seriesNumber?: number | null;
    publishedYear?: number | null;
    status?: LibraryEntry['status'];
    rating?: number | null;
    addedAt?: string;
    updatedAt?: string;
  } = {}
): LibraryEntry {
  const bookId = `22222222-2222-4222-8222-${suffix.padStart(12, '0')}`;
  const entryId = `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`;
  const ts = overrides.addedAt ?? '2026-11-01T10:00:00.000Z';

  return {
    id: entryId,
    userId: USER_ID,
    bookId,
    status: overrides.status ?? 'unread',
    rating: overrides.rating === undefined ? null : overrides.rating,
    notes: null,
    addedAt: ts,
    startedAt: null,
    finishedAt: null,
    createdAt: ts,
    updatedAt: overrides.updatedAt ?? ts,
    deletedAt: null,
    book: {
      id: bookId,
      title: overrides.title ?? `Book ${suffix}`,
      subtitle: null,
      authors: overrides.authors ?? [],
      seriesName: overrides.seriesName === undefined ? null : overrides.seriesName,
      seriesNumber:
        overrides.seriesNumber === undefined ? null : overrides.seriesNumber,
      isbn10: null,
      isbn13: null,
      pageCount: 300,
      publishedYear:
        overrides.publishedYear === undefined ? null : overrides.publishedYear,
      genres: [],
      description: null,
      coverKey: null,
      coverSourceUrl: null,
      language: 'de',
      publisher: null,
      metadataSource: 'manual',
      metadataExternalId: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    },
  };
}

describe('Sortier-Utilities', () => {
  it('sortiert Buchreihen numerisch inkl. Dezimalbänden (1, 1.5, 2, 10) und hält Einzelbände am Ende', () => {
    const entries = [
      makeEntry('1', { title: 'Einzelband Alpha', seriesName: null, seriesNumber: null }),
      makeEntry('2', { title: 'Band 10', seriesName: 'Sturmlicht', seriesNumber: 10 }),
      makeEntry('3', { title: 'Band 2', seriesName: 'Sturmlicht', seriesNumber: 2 }),
      makeEntry('4', { title: 'Band 1.5', seriesName: 'sturmlicht', seriesNumber: 1.5 }),
      makeEntry('5', { title: 'Band 1', seriesName: 'Sturmlicht', seriesNumber: 1 }),
      makeEntry('6', { title: 'Ohne Nummer', seriesName: 'Sturmlicht', seriesNumber: null }),
      makeEntry('7', { title: 'Andere Reihe', seriesName: 'Arcanum', seriesNumber: 1 }),
    ];

    const asc = sortLibraryEntries(entries, 'series', 'asc').map(
      (e) => e.book.title
    );
    expect(asc).toEqual([
      'Andere Reihe',
      'Band 1',
      'Band 1.5',
      'Band 2',
      'Band 10',
      'Ohne Nummer',
      'Einzelband Alpha',
    ]);

    const desc = sortLibraryEntries(entries, 'series', 'desc').map(
      (e) => e.book.title
    );
    expect(desc).toEqual([
      'Band 10',
      'Band 2',
      'Band 1.5',
      'Band 1',
      'Ohne Nummer',
      'Andere Reihe',
      'Einzelband Alpha',
    ]);
  });

  it('sortiert nach Autor und hält fehlende Autoren stets am Ende', () => {
    const entries = [
      makeEntry('1', { title: 'Ohne Autor', authors: [] }),
      makeEntry('2', { title: 'Werk B', authors: ['Zoe'] }),
      makeEntry('3', { title: 'Werk A', authors: ['Anna'] }),
    ];

    expect(sortLibraryEntries(entries, 'author', 'asc').map((e) => e.book.title)).toEqual([
      'Werk A',
      'Werk B',
      'Ohne Autor',
    ]);
    expect(sortLibraryEntries(entries, 'author', 'desc').map((e) => e.book.title)).toEqual([
      'Werk B',
      'Werk A',
      'Ohne Autor',
    ]);
  });

  it('sortiert nach Titel, Status, Hinzufügedatum, Bewertung und Erscheinungsjahr ohne Original-Array zu mutieren', () => {
    const entries = [
      makeEntry('1', {
        title: 'Beta',
        status: 'abandoned',
        rating: null,
        publishedYear: null,
        addedAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      }),
      makeEntry('2', {
        title: 'Alpha',
        status: 'reading',
        rating: 3,
        publishedYear: 2010,
        addedAt: '2026-11-03T10:00:00.000Z',
        updatedAt: '2026-11-03T10:00:00.000Z',
      }),
      makeEntry('3', {
        title: 'Gamma',
        status: 'unread',
        rating: 5,
        publishedYear: 2022,
        addedAt: '2026-11-02T10:00:00.000Z',
        updatedAt: '2026-11-02T10:00:00.000Z',
      }),
      makeEntry('4', {
        title: 'Delta',
        status: 'read',
        rating: 4,
        publishedYear: 2015,
        addedAt: '2026-11-04T10:00:00.000Z',
        updatedAt: '2026-11-04T10:00:00.000Z',
      }),
    ];

    const originalOrder = entries.map((e) => e.book.title);

    expect(sortLibraryEntries(entries, 'title', 'asc').map((e) => e.book.title)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
    expect(sortLibraryEntries(entries, 'status', 'asc').map((e) => e.status)).toEqual([
      'reading',
      'unread',
      'read',
      'abandoned',
    ]);
    expect(sortLibraryEntries(entries, 'added_at').map((e) => e.book.title)).toEqual([
      'Delta',
      'Alpha',
      'Gamma',
      'Beta',
    ]);
    expect(sortLibraryEntries(entries, 'rating').map((e) => e.book.title)).toEqual([
      'Gamma',
      'Delta',
      'Alpha',
      'Beta',
    ]);
    expect(sortLibraryEntries(entries, 'published_year').map((e) => e.book.title)).toEqual([
      'Gamma',
      'Delta',
      'Alpha',
      'Beta',
    ]);
    expect(entries.map((e) => e.book.title)).toEqual(originalOrder);
  });
});
