import { describe, expect, it } from 'vitest';
import { generateRecommendations, type LibraryEntry } from '../src/index.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function createEntry(
  suffix: string,
  opts: {
    title: string;
    authors?: string[];
    genres?: string[];
    seriesName?: string | null;
    seriesNumber?: number | null;
    pageCount?: number | null;
    status?: LibraryEntry['status'];
    rating?: number | null;
    addedAt?: string;
    updatedAt?: string;
    finishedAt?: string | null;
    deletedAt?: string | null;
  }
): LibraryEntry {
  const bookId = `22222222-2222-4222-8222-${suffix.padStart(12, '0')}`;
  const entryId = `33333333-3333-4333-8333-${suffix.padStart(12, '0')}`;
  const addedAt = opts.addedAt ?? '2026-10-01T10:00:00.000Z';

  return {
    id: entryId,
    userId: USER_ID,
    bookId,
    status: opts.status ?? 'unread',
    rating: opts.rating === undefined ? null : opts.rating,
    notes: null,
    addedAt,
    startedAt: null,
    finishedAt: opts.finishedAt === undefined ? null : opts.finishedAt,
    createdAt: addedAt,
    updatedAt: opts.updatedAt ?? addedAt,
    deletedAt: opts.deletedAt === undefined ? null : opts.deletedAt,
    book: {
      id: bookId,
      title: opts.title,
      subtitle: null,
      authors: opts.authors ?? ['Unbekannt'],
      seriesName: opts.seriesName === undefined ? null : opts.seriesName,
      seriesNumber:
        opts.seriesNumber === undefined ? null : opts.seriesNumber,
      isbn10: null,
      isbn13: null,
      pageCount: opts.pageCount === undefined ? 350 : opts.pageCount,
      publishedYear: 2020,
      genres: opts.genres ?? [],
      description: null,
      coverKey: null,
      coverSourceUrl: null,
      language: 'de',
      publisher: null,
      metadataSource: 'manual',
      metadataExternalId: null,
      createdAt: addedAt,
      updatedAt: opts.updatedAt ?? addedAt,
      deletedAt: null,
    },
  };
}

describe('Empfehlungs-Engine (Stufe 1–3)', () => {
  it('empfiehlt in Stufe 1 den nächsten Dezimal-Band (1 -> 1.5 -> 2) und priorisiert aktiv gelesene Reihen', () => {
    const entries: LibraryEntry[] = [
      // Reihe A: Mistborn, Band 1 gelesen (5 Sterne), Band 1.5 und 2 ungelesen
      createEntry('1', {
        title: 'Mistborn 1',
        authors: ['Brandon Sanderson'],
        seriesName: 'Mistborn',
        seriesNumber: 1,
        status: 'read',
        rating: 5,
        finishedAt: '2026-11-10T10:00:00.000Z',
      }),
      createEntry('2', {
        title: 'Mistborn 1.5',
        authors: ['Brandon Sanderson'],
        seriesName: 'Mistborn',
        seriesNumber: 1.5,
        status: 'unread',
      }),
      createEntry('3', {
        title: 'Mistborn 2',
        authors: ['Brandon Sanderson'],
        seriesName: 'Mistborn',
        seriesNumber: 2,
        status: 'unread',
      }),
      // Reihe B: aktiv gelesen (status = reading), daher noch höher priorisiert
      createEntry('4', {
        title: 'Expanse 1',
        authors: ['James S. A. Corey'],
        seriesName: 'The Expanse',
        seriesNumber: 1,
        status: 'reading',
        rating: 4,
        updatedAt: '2026-11-15T10:00:00.000Z',
      }),
      createEntry('5', {
        title: 'Expanse 2',
        authors: ['James S. A. Corey'],
        seriesName: 'The Expanse',
        seriesNumber: 2,
        status: 'unread',
      }),
    ];

    const result = generateRecommendations(entries, {
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    expect(result.categories.continue_series).toHaveLength(2);
    expect(result.categories.continue_series[0]?.bookId).toBe(entries[4]?.bookId);
    expect(result.categories.continue_series[1]?.bookId).toBe(entries[1]?.bookId);
    expect(result.categories.continue_series[1]?.reasonCode).toBe('next_in_series');
    expect(result.categories.continue_series[1]?.reasonText).toContain('#1.5');
    expect(result.categories.continue_series[1]?.reasonText).toContain('Mistborn');
  });

  it('berechnet Autoren- & Genre-Affinität, schließt Stufe-1-Titel sowie unbegonnene Fortsetzungen aus und ignoriert Soft Deletes', () => {
    const entries: LibraryEntry[] = [
      // Gelesene Referenzbücher (Brandon Sanderson = 5★, High Fantasy)
      createEntry('10', {
        title: 'Elantris',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy', 'Fantasy'],
        status: 'read',
        rating: 5,
      }),
      createEntry('11', {
        title: 'Sturmlicht 1',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy'],
        seriesName: 'Sturmlicht',
        seriesNumber: 1,
        status: 'read',
        rating: 5,
      }),
      // Abgebrochenes Horror-Buch -> negativer Score
      createEntry('12', {
        title: 'Gruselbuch',
        authors: ['Horror Autor'],
        genres: ['Horror'],
        status: 'abandoned',
        rating: 1,
      }),
      // Stufe-1-Pick (soll nicht doppelt in Stufe 2 auftauchen)
      createEntry('13', {
        title: 'Sturmlicht 2',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy'],
        seriesName: 'Sturmlicht',
        seriesNumber: 2,
        status: 'unread',
      }),
      // Erlaubter Einzelband von Sanderson -> Top-Kandidat für Stufe 2
      createEntry('14', {
        title: 'Sturmklänge',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy'],
        status: 'unread',
      }),
      // Genre-Treffer von anderem Autor
      createEntry('15', {
        title: 'Name des Windes',
        authors: ['Patrick Rothfuss'],
        genres: ['High Fantasy'],
        seriesName: 'Königsmörder',
        seriesNumber: 1,
        status: 'unread',
      }),
      // Unbegonnene Reihe Band 2 -> muss durch Reihen-Schutzregel gefiltert werden
      createEntry('16', {
        title: 'Unbekannte Reihe Band 2',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy'],
        seriesName: 'Geheime Saga',
        seriesNumber: 2,
        status: 'unread',
      }),
      // Negatives Genre -> nicht in Stufe 2 empfohlen
      createEntry('17', {
        title: 'Schlechtes Buch',
        authors: ['Horror Autor'],
        genres: ['Horror'],
        status: 'unread',
      }),
      // Soft-gelöschtes Buch -> darf nirgends erscheinen
      createEntry('18', {
        title: 'Gelöschtes Buch',
        authors: ['Brandon Sanderson'],
        genres: ['High Fantasy'],
        pageCount: 120,
        status: 'unread',
        deletedAt: '2026-11-18T10:00:00.000Z',
      }),
    ];

    const result = generateRecommendations(entries, {
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    const affinityBookIds = result.categories.affinity.map((item) => item.bookId);
    expect(affinityBookIds).toEqual([entries[4]?.bookId, entries[5]?.bookId]);
    expect(result.categories.affinity[0]?.reasonText).toContain('Brandon Sanderson');
    expect(result.categories.affinity[1]?.reasonText).toContain('High Fantasy');
    expect(affinityBookIds).not.toContain(entries[3]?.bookId);
    expect(affinityBookIds).not.toContain(entries[6]?.bookId);
    expect(affinityBookIds).not.toContain(entries[7]?.bookId);
    expect(affinityBookIds).not.toContain(entries[8]?.bookId);
  });

  it('liefert Quick-Read (<300 S.), Staubfänger und deterministisches Überrasch-mich über Mulberry32-Seed', () => {
    const entries: LibraryEntry[] = [
      createEntry('20', {
        title: 'Kurzroman',
        pageCount: 180,
        addedAt: '2026-11-10T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('21', {
        title: 'Novelle',
        pageCount: 95,
        addedAt: '2026-11-15T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('22', {
        title: 'Wälzer',
        pageCount: 950,
        addedAt: '2025-11-21T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('23', {
        title: 'Einzelband C',
        pageCount: 310,
        addedAt: '2026-08-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];

    const now = new Date('2026-11-21T10:00:00.000Z');
    const r1 = generateRecommendations(entries, { seed: 42, now });
    const r2 = generateRecommendations([...entries].reverse(), { seed: 42, now });
    const r3 = generateRecommendations(entries, { seed: 99, now });

    expect(r1.categories.quick_read.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
      entries[0]?.bookId,
    ]);
    expect(r1.categories.quick_read[0]?.reasonText).toContain('95 Seiten');

    expect(r1.categories.dust_collector[0]?.bookId).toBe(entries[2]?.bookId);
    expect(r1.categories.dust_collector[0]?.reasonText).toContain('365 Tagen');

    // Gleicher Seed liefert identische Reihenfolge unabhängig von Eingabe-Reihenfolge
    expect(r1.categories.surprise_me.map((x) => x.bookId)).toEqual(
      r2.categories.surprise_me.map((x) => x.bookId)
    );
    expect(r1.categories.surprise_me).toHaveLength(4);
    expect(r3.seed).toBe(99);
  });

  it('schließt unbegonnene Fortsetzungen (> Band 1) auch aus Quick-Read und Staubfänger aus', () => {
    const entries: LibraryEntry[] = [
      createEntry('30', {
        title: 'Unbegonnene Reihe Band 2 (kurz & alt)',
        seriesName: 'Neue Reihe',
        seriesNumber: 2,
        pageCount: 90,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('31', {
        title: 'Unbegonnene Reihe Band 1',
        seriesName: 'Neue Reihe',
        seriesNumber: 1,
        pageCount: 220,
        addedAt: '2026-10-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];

    const result = generateRecommendations(entries, {
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    expect(result.categories.quick_read.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
    expect(result.categories.dust_collector.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
  });
});
