import { describe, expect, it } from 'vitest';
import {
  generateRecommendations,
  type LibraryEntry,
  type RecommendationResult,
} from '../src/index.js';

function allRecommendedBookIds(result: RecommendationResult): string[] {
  return [
    ...result.categories.continue_series,
    ...result.categories.affinity,
    ...result.categories.quick_read,
    ...result.categories.dust_collector,
    ...result.categories.surprise_me,
  ].map((item) => item.bookId);
}

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

  it('empfiehlt bei unbegonnener Reihe (Bände 1–4) niemals Band 2–4 in irgendeiner Kategorie', () => {
    const entries: LibraryEntry[] = [
      // Referenz für Autoren- & Genre-Affinität
      createEntry('40', {
        title: 'Standalone Favorit',
        authors: ['Lieblingsautor'],
        genres: ['Fantasy'],
        status: 'read',
        rating: 5,
      }),
      createEntry('41', {
        title: 'Saga Band 1',
        authors: ['Lieblingsautor'],
        genres: ['Fantasy'],
        seriesName: 'Epische Saga',
        seriesNumber: 1,
        pageCount: 250,
        addedAt: '2026-10-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('42', {
        title: 'Saga Band 2',
        authors: ['Lieblingsautor'],
        genres: ['Fantasy'],
        seriesName: 'Epische Saga',
        seriesNumber: 2,
        pageCount: 150,
        addedAt: '2021-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('43', {
        title: 'Saga Band 3',
        authors: ['Lieblingsautor'],
        genres: ['Fantasy'],
        seriesName: 'Epische Saga',
        seriesNumber: 3,
        pageCount: 120,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('44', {
        title: 'Saga Band 4',
        authors: ['Lieblingsautor'],
        genres: ['Fantasy'],
        seriesName: 'Epische Saga',
        seriesNumber: 4,
        pageCount: 85,
        addedAt: '2019-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];

    const result = generateRecommendations(entries, {
      seed: 7,
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    const recommended = allRecommendedBookIds(result);
    expect(result.categories.continue_series).toEqual([]);
    expect(recommended).not.toContain(entries[2]?.bookId);
    expect(recommended).not.toContain(entries[3]?.bookId);
    expect(recommended).not.toContain(entries[4]?.bookId);

    expect(result.categories.affinity.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
    expect(result.categories.quick_read.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
    expect(result.categories.dust_collector.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
    expect(result.categories.surprise_me.map((x) => x.bookId)).toEqual([
      entries[1]?.bookId,
    ]);
  });

  it('liefert bei ausschließlich unbegonnenen Folgebänden (Band 2–4 ohne Band 1) auch in surprise_me keine Treffer', () => {
    const entries: LibraryEntry[] = [
      createEntry('50', {
        title: 'Reihe Band 2',
        seriesName: 'Ohne Startband',
        seriesNumber: 2,
        pageCount: 100,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('51', {
        title: 'Reihe Band 3',
        seriesName: 'Ohne Startband',
        seriesNumber: 3,
        pageCount: 120,
        addedAt: '2020-02-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('52', {
        title: 'Reihe Band 4',
        seriesName: 'Ohne Startband',
        seriesNumber: 4,
        pageCount: 90,
        addedAt: '2019-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];

    const result = generateRecommendations(entries, {
      seed: 123,
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    expect(result.categories.continue_series).toEqual([]);
    expect(result.categories.affinity).toEqual([]);
    expect(result.categories.quick_read).toEqual([]);
    expect(result.categories.dust_collector).toEqual([]);
    expect(result.categories.surprise_me).toEqual([]);
  });

  it('empfiehlt bei begonnener Reihe mit Bänden 1–4 höchstens Band 2 und niemals Band 3 oder 4', () => {
    const entries: LibraryEntry[] = [
      createEntry('60', {
        title: 'Chronik Band 1',
        authors: ['Top Autor'],
        genres: ['Sci-Fi'],
        seriesName: 'Sternenchronik',
        seriesNumber: 1,
        status: 'read',
        rating: 5,
      }),
      createEntry('61', {
        title: 'Chronik Band 2',
        authors: ['Top Autor'],
        genres: ['Sci-Fi'],
        seriesName: 'Sternenchronik',
        seriesNumber: 2,
        pageCount: 250,
        addedAt: '2026-05-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('62', {
        title: 'Chronik Band 3',
        authors: ['Top Autor'],
        genres: ['Sci-Fi'],
        seriesName: 'Sternenchronik',
        seriesNumber: 3,
        pageCount: 110,
        addedAt: '2021-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('63', {
        title: 'Chronik Band 4',
        authors: ['Top Autor'],
        genres: ['Sci-Fi'],
        seriesName: 'Sternenchronik',
        seriesNumber: 4,
        pageCount: 80,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];

    const result = generateRecommendations(entries, {
      seed: 42,
      now: new Date('2026-11-21T10:00:00.000Z'),
    });

    const band2Id = entries[1]!.bookId;
    const band3Id = entries[2]!.bookId;
    const band4Id = entries[3]!.bookId;

    expect(result.categories.continue_series.map((x) => x.bookId)).toEqual([
      band2Id,
    ]);
    // Band 2 bleibt wegen Stufe-1-Deduplizierung aus affinity draußen, Band 3 & 4 sind global gesperrt
    expect(result.categories.affinity).toEqual([]);
    expect(result.categories.quick_read.map((x) => x.bookId)).toEqual([band2Id]);
    expect(result.categories.dust_collector.map((x) => x.bookId)).toEqual([
      band2Id,
    ]);
    expect(result.categories.surprise_me.map((x) => x.bookId)).toEqual([band2Id]);

    const recommended = allRecommendedBookIds(result);
    expect(recommended).not.toContain(band3Id);
    expect(recommended).not.toContain(band4Id);
  });

  it('behandelt Dezimalbände in begonnenen Reihen korrekt (0.5 -> 1 -> 1.5 -> 2 -> 2.5 -> 3)', () => {
    const now = new Date('2026-11-21T10:00:00.000Z');

    // Fall A: Band 1 gelesen, 1.5, 2 und 3 ungelesen (2 & 3 kurz & alt) -> maximal 1.5
    const caseA: LibraryEntry[] = [
      createEntry('70', {
        title: 'Reihe 1',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1,
        status: 'read',
      }),
      createEntry('71', {
        title: 'Reihe 1.5',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1.5,
        pageCount: 240,
        addedAt: '2026-10-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('72', {
        title: 'Reihe 2',
        seriesName: 'Dezimalreihe',
        seriesNumber: 2,
        pageCount: 100,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('73', {
        title: 'Reihe 3',
        seriesName: 'Dezimalreihe',
        seriesNumber: 3,
        pageCount: 90,
        addedAt: '2019-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];
    const resA = generateRecommendations(caseA, { now, seed: 1 });
    expect(resA.categories.continue_series.map((x) => x.bookId)).toEqual([
      caseA[1]!.bookId,
    ]);
    expect(resA.categories.quick_read.map((x) => x.bookId)).toEqual([
      caseA[1]!.bookId,
    ]);
    expect(resA.categories.dust_collector.map((x) => x.bookId)).toEqual([
      caseA[1]!.bookId,
    ]);
    expect(resA.categories.surprise_me.map((x) => x.bookId)).toEqual([
      caseA[1]!.bookId,
    ]);
    expect(allRecommendedBookIds(resA)).not.toContain(caseA[2]!.bookId);
    expect(allRecommendedBookIds(resA)).not.toContain(caseA[3]!.bookId);

    // Fall B: Band 1 + 1.5 gelesen, 2, 2.5, 3 ungelesen -> maximal 2
    const caseB: LibraryEntry[] = [
      createEntry('74', {
        title: 'Reihe 1',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1,
        status: 'read',
      }),
      createEntry('75', {
        title: 'Reihe 1.5',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1.5,
        status: 'read',
      }),
      createEntry('76', {
        title: 'Reihe 2',
        seriesName: 'Dezimalreihe',
        seriesNumber: 2,
        pageCount: 250,
        status: 'unread',
      }),
      createEntry('77', {
        title: 'Reihe 2.5',
        seriesName: 'Dezimalreihe',
        seriesNumber: 2.5,
        pageCount: 95,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('78', {
        title: 'Reihe 3',
        seriesName: 'Dezimalreihe',
        seriesNumber: 3,
        pageCount: 85,
        addedAt: '2019-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];
    const resB = generateRecommendations(caseB, { now, seed: 1 });
    expect(resB.categories.continue_series.map((x) => x.bookId)).toEqual([
      caseB[2]!.bookId,
    ]);
    expect(resB.categories.quick_read.map((x) => x.bookId)).toEqual([
      caseB[2]!.bookId,
    ]);
    expect(allRecommendedBookIds(resB)).not.toContain(caseB[3]!.bookId);
    expect(allRecommendedBookIds(resB)).not.toContain(caseB[4]!.bookId);

    // Fall C: Prequel 0.5 gelesen, 1, 1.5, 2 ungelesen -> maximal 1
    const caseC: LibraryEntry[] = [
      createEntry('79', {
        title: 'Reihe 0.5',
        seriesName: 'Dezimalreihe',
        seriesNumber: 0.5,
        status: 'read',
      }),
      createEntry('80', {
        title: 'Reihe 1',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1,
        pageCount: 250,
        status: 'unread',
      }),
      createEntry('81', {
        title: 'Reihe 1.5',
        seriesName: 'Dezimalreihe',
        seriesNumber: 1.5,
        pageCount: 90,
        addedAt: '2020-01-01T10:00:00.000Z',
        status: 'unread',
      }),
      createEntry('82', {
        title: 'Reihe 2',
        seriesName: 'Dezimalreihe',
        seriesNumber: 2,
        pageCount: 80,
        addedAt: '2019-01-01T10:00:00.000Z',
        status: 'unread',
      }),
    ];
    const resC = generateRecommendations(caseC, { now, seed: 1 });
    expect(resC.categories.continue_series.map((x) => x.bookId)).toEqual([
      caseC[1]!.bookId,
    ]);
    expect(allRecommendedBookIds(resC)).not.toContain(caseC[2]!.bookId);
    expect(allRecommendedBookIds(resC)).not.toContain(caseC[3]!.bookId);
  });

  it('überspringt keine fehlenden ganzen Zwischenbände (z. B. Band 1 gelesen, 2–3 fehlen, 4 vorhanden)', () => {
    const now = new Date('2026-11-21T10:00:00.000Z');

    // Fall 1: Band 1 read, Band 2–3 fehlen, Band 4 unread (kurz, alt, Lieblingsautor)
    const gap4 = generateRecommendations(
      [
        createEntry('90', {
          title: 'Lücke 1',
          authors: ['Lieblingsautor'],
          genres: ['Fantasy'],
          seriesName: 'Lückenreihe',
          seriesNumber: 1,
          status: 'read',
          rating: 5,
        }),
        createEntry('91', {
          title: 'Lücke 4',
          authors: ['Lieblingsautor'],
          genres: ['Fantasy'],
          seriesName: 'Lückenreihe',
          seriesNumber: 4,
          pageCount: 90,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 5 }
    );
    expect(allRecommendedBookIds(gap4)).toEqual([]);

    // Fall 2: Band 1 read, Band 2 fehlt, Band 2.5 unread -> darf nicht empfohlen werden
    const gap25 = generateRecommendations(
      [
        createEntry('92', {
          title: 'Lücke 1',
          seriesName: 'Lückenreihe',
          seriesNumber: 1,
          status: 'read',
        }),
        createEntry('93', {
          title: 'Lücke 2.5',
          seriesName: 'Lückenreihe',
          seriesNumber: 2.5,
          pageCount: 100,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 5 }
    );
    expect(allRecommendedBookIds(gap25)).toEqual([]);

    // Fall 3: Band 1 + 1.5 read, Band 2 fehlt, Band 3 unread -> darf nicht empfohlen werden
    const gap3 = generateRecommendations(
      [
        createEntry('94', {
          title: 'Lücke 1',
          seriesName: 'Lückenreihe',
          seriesNumber: 1,
          status: 'read',
        }),
        createEntry('95', {
          title: 'Lücke 1.5',
          seriesName: 'Lückenreihe',
          seriesNumber: 1.5,
          status: 'read',
        }),
        createEntry('96', {
          title: 'Lücke 3',
          seriesName: 'Lückenreihe',
          seriesNumber: 3,
          pageCount: 100,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 5 }
    );
    expect(allRecommendedBookIds(gap3)).toEqual([]);
  });

  it('wertet abgebrochene (abandoned) Bücher nicht als begonnenen Reihenfortschritt', () => {
    const now = new Date('2026-11-21T10:00:00.000Z');

    // Fall 1: Band 1 abandoned, Band 2 & 3 unread -> Reihe gilt als unbegonnen
    const onlyAbandoned = generateRecommendations(
      [
        createEntry('100', {
          title: 'Abgebrochen 1',
          seriesName: 'Abbruchreihe',
          seriesNumber: 1,
          status: 'abandoned',
        }),
        createEntry('101', {
          title: 'Abgebrochen 2',
          seriesName: 'Abbruchreihe',
          seriesNumber: 2,
          pageCount: 120,
          addedAt: '2020-01-01T10:00:00.000Z',
          status: 'unread',
        }),
        createEntry('102', {
          title: 'Abgebrochen 3',
          seriesName: 'Abbruchreihe',
          seriesNumber: 3,
          pageCount: 90,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 11 }
    );
    expect(allRecommendedBookIds(onlyAbandoned)).toEqual([]);

    // Fall 2: Band 1 read, Band 2 abandoned, Band 3 & 4 unread -> maxProgress bleibt 1, Band 3 & 4 gesperrt
    const readThenAbandoned = generateRecommendations(
      [
        createEntry('103', {
          title: 'Reihe 1',
          seriesName: 'Abbruchreihe B',
          seriesNumber: 1,
          status: 'read',
        }),
        createEntry('104', {
          title: 'Reihe 2',
          seriesName: 'Abbruchreihe B',
          seriesNumber: 2,
          status: 'abandoned',
        }),
        createEntry('105', {
          title: 'Reihe 3',
          seriesName: 'Abbruchreihe B',
          seriesNumber: 3,
          pageCount: 110,
          addedAt: '2020-01-01T10:00:00.000Z',
          status: 'unread',
        }),
        createEntry('106', {
          title: 'Reihe 4',
          seriesName: 'Abbruchreihe B',
          seriesNumber: 4,
          pageCount: 90,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 11 }
    );
    expect(allRecommendedBookIds(readThenAbandoned)).toEqual([]);

    // Fall 3: Band 1 read, Band 2 abandoned, Band 1.5 unread, Band 3 unread -> 1.5 zulässig, 3 gesperrt
    const entry15 = createEntry('109', {
      title: 'Reihe 1.5',
      seriesName: 'Abbruchreihe C',
      seriesNumber: 1.5,
      pageCount: 180,
      status: 'unread',
    });
    const entry3 = createEntry('110', {
      title: 'Reihe 3',
      seriesName: 'Abbruchreihe C',
      seriesNumber: 3,
      pageCount: 90,
      addedAt: '2019-01-01T10:00:00.000Z',
      status: 'unread',
    });
    const withNovella = generateRecommendations(
      [
        createEntry('107', {
          title: 'Reihe 1',
          seriesName: 'Abbruchreihe C',
          seriesNumber: 1,
          status: 'read',
        }),
        createEntry('108', {
          title: 'Reihe 2',
          seriesName: 'Abbruchreihe C',
          seriesNumber: 2,
          status: 'abandoned',
        }),
        entry15,
        entry3,
      ],
      { now, seed: 11 }
    );
    expect(withNovella.categories.continue_series.map((x) => x.bookId)).toEqual([
      entry15.bookId,
    ]);
    expect(withNovella.categories.quick_read.map((x) => x.bookId)).toEqual([
      entry15.bookId,
    ]);
    expect(allRecommendedBookIds(withNovella)).not.toContain(entry3.bookId);
  });

  it('behandelt seriesNumber === null konsistent in unbegonnenen und begonnenen Reihen', () => {
    const now = new Date('2026-11-21T10:00:00.000Z');

    // Fall 1: Unbegonnene Reihe mit seriesNumber: null -> erlaubt in affinity, quick_read, dust_collector, surprise_me
    const unstartedUnnumbered = [
      createEntry('111', {
        title: 'Favorit',
        authors: ['Autor X'],
        genres: ['Drama'],
        status: 'read',
        rating: 5,
      }),
      createEntry('112', {
        title: 'Anthologie Ohne Nummer',
        authors: ['Autor X'],
        genres: ['Drama'],
        seriesName: 'Anthologie-Reihe',
        seriesNumber: null,
        pageCount: 180,
        status: 'unread',
      }),
    ];
    const res1 = generateRecommendations(unstartedUnnumbered, { now, seed: 3 });
    expect(res1.categories.continue_series).toEqual([]);
    expect(res1.categories.affinity.map((x) => x.bookId)).toEqual([
      unstartedUnnumbered[1]!.bookId,
    ]);
    expect(res1.categories.quick_read.map((x) => x.bookId)).toEqual([
      unstartedUnnumbered[1]!.bookId,
    ]);
    expect(res1.categories.dust_collector.map((x) => x.bookId)).toEqual([
      unstartedUnnumbered[1]!.bookId,
    ]);
    expect(res1.categories.surprise_me.map((x) => x.bookId)).toEqual([
      unstartedUnnumbered[1]!.bookId,
    ]);

    // Fall 2: Begonnene Reihe mit nur unnummeriertem read-Band + Band 4 unread -> Band 4 gesperrt
    const res2 = generateRecommendations(
      [
        createEntry('113', {
          title: 'Start Ohne Nummer',
          seriesName: 'Unnummerierte Reihe',
          seriesNumber: null,
          status: 'read',
        }),
        createEntry('114', {
          title: 'Folgeband 4',
          seriesName: 'Unnummerierte Reihe',
          seriesNumber: 4,
          pageCount: 95,
          addedAt: '2019-01-01T10:00:00.000Z',
          status: 'unread',
        }),
      ],
      { now, seed: 3 }
    );
    expect(allRecommendedBookIds(res2)).toEqual([]);

    // Fall 3: Unnummerierter read-Band + zwei unnummerierte unread-Bände -> höchstens ein Band zulässig
    const uA = createEntry('116', {
      title: 'Alpha Teil',
      seriesName: 'Zwei Unnummerierte',
      seriesNumber: null,
      pageCount: 120,
      status: 'unread',
    });
    const uB = createEntry('117', {
      title: 'Beta Teil',
      seriesName: 'Zwei Unnummerierte',
      seriesNumber: null,
      pageCount: 150,
      status: 'unread',
    });
    const res3 = generateRecommendations(
      [
        createEntry('115', {
          title: 'Prolog',
          seriesName: 'Zwei Unnummerierte',
          seriesNumber: null,
          status: 'read',
        }),
        uA,
        uB,
      ],
      { now, seed: 3 }
    );
    expect(res3.categories.continue_series).toHaveLength(1);
    expect(res3.categories.continue_series[0]?.reasonCode).toBe(
      'series_unnumbered'
    );
    expect(res3.categories.continue_series[0]?.bookId).toBe(uA.bookId);
    expect(allRecommendedBookIds(res3)).not.toContain(uB.bookId);

    // Fall 4: Band 1 read, Band 2–3 fehlen, Band 4 unread + unnummerierter Begleitband unread
    const companion = createEntry('119', {
      title: 'Begleitband',
      seriesName: 'Gemischte Reihe',
      seriesNumber: null,
      pageCount: 160,
      status: 'unread',
    });
    const vol4 = createEntry('120', {
      title: 'Gemischt Band 4',
      seriesName: 'Gemischte Reihe',
      seriesNumber: 4,
      pageCount: 80,
      addedAt: '2019-01-01T10:00:00.000Z',
      status: 'unread',
    });
    const res4 = generateRecommendations(
      [
        createEntry('118', {
          title: 'Gemischt Band 1',
          seriesName: 'Gemischte Reihe',
          seriesNumber: 1,
          status: 'read',
        }),
        companion,
        vol4,
      ],
      { now, seed: 3 }
    );
    expect(res4.categories.continue_series).toHaveLength(1);
    expect(res4.categories.continue_series[0]?.bookId).toBe(companion.bookId);
    expect(res4.categories.continue_series[0]?.reasonCode).toBe(
      'series_unnumbered'
    );
    expect(allRecommendedBookIds(res4)).not.toContain(vol4.bookId);
  });

  it('normalisiert leere, Whitespace- und unterschiedlich geschriebene seriesName-Werte konsistent', () => {
    const now = new Date('2026-11-21T10:00:00.000Z');

    const blankSeriesSpaces = createEntry('121', {
      title: 'Leerzeichen-Reihe Band 4',
      seriesName: '   ',
      seriesNumber: 4,
      pageCount: 120,
      addedAt: '2026-01-01T10:00:00.000Z',
      status: 'unread',
    });
    const blankSeriesEmpty = createEntry('122', {
      title: 'Leerstring-Reihe Band 4',
      seriesName: '',
      seriesNumber: 4,
      pageCount: 140,
      addedAt: '2026-02-01T10:00:00.000Z',
      status: 'unread',
    });
    const storm1 = createEntry('123', {
      title: 'Sturmlicht 1',
      seriesName: '  Sturmlicht  ',
      seriesNumber: 1,
      status: 'read',
    });
    const storm2 = createEntry('124', {
      title: 'Sturmlicht 2',
      seriesName: 'sturmlicht',
      seriesNumber: 2,
      pageCount: 200,
      addedAt: '2026-03-01T10:00:00.000Z',
      status: 'unread',
    });
    const storm3 = createEntry('125', {
      title: 'Sturmlicht 3',
      seriesName: 'STURMLICHT ',
      seriesNumber: 3,
      pageCount: 90,
      addedAt: '2019-01-01T10:00:00.000Z',
      status: 'unread',
    });

    const result = generateRecommendations(
      [blankSeriesSpaces, blankSeriesEmpty, storm1, storm2, storm3],
      { now, seed: 9 }
    );

    expect(result.categories.continue_series.map((x) => x.bookId)).toEqual([
      storm2.bookId,
    ]);
    expect(result.categories.quick_read.map((x) => x.bookId)).toEqual([
      blankSeriesSpaces.bookId,
      blankSeriesEmpty.bookId,
      storm2.bookId,
    ]);
    expect(result.categories.dust_collector.map((x) => x.bookId)).toEqual([
      blankSeriesSpaces.bookId,
      blankSeriesEmpty.bookId,
      storm2.bookId,
    ]);
    expect(result.categories.surprise_me.map((x) => x.bookId)).toEqual(
      expect.arrayContaining([
        blankSeriesSpaces.bookId,
        blankSeriesEmpty.bookId,
        storm2.bookId,
      ])
    );
    expect(allRecommendedBookIds(result)).not.toContain(storm3.bookId);
  });
});
