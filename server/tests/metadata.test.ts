import {
  MetadataIsbnResponseSchema,
  MetadataProvidersResponseSchema,
  MetadataSearchResponseSchema,
} from '@bibliolisa/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { MetadataAggregator } from '../src/metadata/aggregator.js';
import { GoogleBooksAdapter } from '../src/metadata/google-books.adapter.js';
import { HardcoverAdapter } from '../src/metadata/hardcover.adapter.js';
import { OpenLibraryAdapter } from '../src/metadata/openlibrary.adapter.js';
import type { FetchLike } from '../src/metadata/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Metadaten-Provider, Aggregator & API-Endpunkte', () => {
  it('normalisiert Open Library, Google Books und Hardcover inklusive Dezimal-Reihen, HTML-Bereinigung und Rausch-Tag-Filterung', async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);

      if (url === 'https://openlibrary.org/isbn/9783453267176.json') {
        expect((init?.headers as Record<string, string>)['User-Agent']).toContain(
          'Bibliolisa'
        );
        return jsonResponse({
          key: '/books/OL999M',
          title: 'Der Weg der Könige',
          series: ['Sturmlicht-Chroniken, Band 1.5'],
          isbn_13: ['9783453267176'],
          number_of_pages: 1344,
          publish_date: 'May 2011',
          publishers: ['Heyne'],
          languages: [{ key: '/languages/ger' }],
          covers: [881234],
          works: [{ key: '/works/OL15358691W' }],
          authors: [{ key: '/authors/OL1394860A' }],
        });
      }

      if (url === 'https://openlibrary.org/works/OL15358691W.json') {
        return jsonResponse({
          description: { value: 'Open Library Beschreibung' },
          subjects: [
            'Protected DAISY',
            'Accessible book',
            'In library',
            'nyt:bestsellers',
            'High Fantasy',
            'Epic Fantasy',
          ],
        });
      }

      if (url === 'https://openlibrary.org/authors/OL1394860A.json') {
        return jsonResponse({ name: 'Brandon Sanderson' });
      }

      if (url.startsWith('https://www.googleapis.com/books/v1/volumes')) {
        expect(url).toContain('key=gbooks-secret-key');
        return jsonResponse({
          items: [
            {
              id: 'gb-vol-1',
              volumeInfo: {
                title: 'Der Weg der Könige (Sturmlicht, Band 99)',
                subtitle: 'Roman',
                authors: ['Brandon Sanderson'],
                publisher: 'Heyne Verlag',
                publishedDate: '2011-05-02',
                description:
                  '<p>Ausführlicher <b>Google Books</b> Klappentext.<br/>Mit Zeilenumbruch &amp; Sonderzeichen.</p>',
                industryIdentifiers: [
                  { type: 'ISBN_13', identifier: '9783453267176' },
                ],
                pageCount: 1350,
                categories: ['Fiction / General', 'Fantasy / Epic'],
                imageLinks: {
                  thumbnail: 'http://books.google.com/books/content?id=gb1&img=1',
                },
                language: 'de-DE',
              },
            },
          ],
        });
      }

      if (url === 'https://api.hardcover.app/v1/graphql') {
        const authHeader = (init?.headers as Record<string, string>)
          .Authorization;
        expect(authHeader).toBe('Bearer hc-secret-token');
        return jsonResponse({
          data: {
            editions: [
              {
                id: 501,
                title: 'The Way of Kings',
                subtitle: 'The Stormlight Archive',
                isbn_13: '9783453267176',
                isbn_10: '3453267176',
                pages: 1344,
                release_year: 2011,
                publisher: { name: 'Tor Books' },
                language: { code2: 'de' },
                image: { url: 'https://assets.hardcover.app/covers/kings.jpg' },
                book: {
                  id: 1001,
                  description: 'Hardcover Beschreibung',
                  contributions: [{ author: { name: 'Brandon Sanderson' } }],
                  book_series: [
                    {
                      position: 1.5,
                      series: { name: 'Die Sturmlicht-Chroniken' },
                    },
                  ],
                  cached_tags: {
                    Genre: [
                      { tag: 'Fantasy' },
                      { tag: 'High Fantasy' },
                      { tag: 'Adventure' },
                      { tag: 'Magic' },
                      { tag: 'Warfare' },
                      { tag: 'Cosmere' },
                      { tag: 'Worldbuilding' },
                      { tag: 'Knights' },
                    ],
                  },
                },
              },
            ],
          },
        });
      }

      return jsonResponse({}, 404);
    });

    const disabledHardcover = new HardcoverAdapter({ fetchImpl: fetchMock });
    expect(disabledHardcover.isEnabled()).toBe(false);
    expect(
      await disabledHardcover.lookupByIsbn(
        '9783453267176',
        '3453267176',
        new AbortController().signal
      )
    ).toBeNull();

    const hardcover = new HardcoverAdapter({
      apiKey: 'Bearer hc-secret-token',
      fetchImpl: fetchMock,
    });
    const googleBooks = new GoogleBooksAdapter({
      apiKey: 'gbooks-secret-key',
      fetchImpl: fetchMock,
    });
    const openLibrary = new OpenLibraryAdapter({ fetchImpl: fetchMock });

    const aggregator = new MetadataAggregator({
      providers: [hardcover, googleBooks, openLibrary],
    });

    const result = await aggregator.lookupByIsbn('9783453267176', '3453267176');

    expect(result.candidates).toHaveLength(3);
    expect(result.providerStatuses.every((s) => s.status === 'ok')).toBe(true);

    // Feldspezifische Merge-Matrix verifizieren:
    // - Titel/Reihe/Cover von Hardcover (höchste Prio)
    // - Beschreibung von Google Books (höchste Prio für description, HTML bereinigt)
    // - Genres rauschgefiltert & auf max 8 gekürzt
    expect(result.merged).not.toBeNull();
    expect(result.merged?.title).toBe('The Way of Kings');
    expect(result.merged?.seriesName).toBe('Die Sturmlicht-Chroniken');
    expect(result.merged?.seriesNumber).toBe(1.5);
    expect(result.merged?.coverUrl).toBe(
      'https://assets.hardcover.app/covers/kings.jpg'
    );
    expect(result.merged?.description).toBe(
      'Ausführlicher Google Books Klappentext.\nMit Zeilenumbruch & Sonderzeichen.'
    );
    expect(result.merged?.genres.length).toBeLessThanOrEqual(8);
    expect(result.merged?.genres).not.toContain('Protected DAISY');
    expect(result.merged?.genres).not.toContain('Accessible book');
    expect(result.merged?.genres).not.toContain('Fiction / General');

    // Google Books Cover-URL Upgrade http -> https prüfen
    const gbCandidate = result.candidates.find((c) => c.source === 'google_books');
    expect(gbCandidate?.coverUrl).toBe(
      'https://books.google.com/books/content?id=gb1&img=1'
    );
  });

  it('fängt Teilausfälle und Timeouts resilient ab und respektiert den 15-Minuten-TTL-Cache', async () => {
    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    let olCalls = 0;
    let shouldFailAll = true;

    const flakyHardcover = new HardcoverAdapter({
      apiKey: 'hc-key',
      fetchImpl: async () => jsonResponse({ error: 'Internal' }, 500),
    });

    const slowGoogle = new GoogleBooksAdapter({
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });

    const openLibrary = new OpenLibraryAdapter({
      fetchImpl: async (input) => {
        olCalls += 1;
        if (shouldFailAll) {
          return jsonResponse({ error: 'down' }, 503);
        }
        const url = String(input);
        if (url.includes('/isbn/')) {
          return jsonResponse({
            key: '/books/OL1M',
            title: 'Elantris',
            series: ['Elantris #1'],
            isbn_13: ['9780765350374'],
            number_of_pages: 638,
            publish_date: '2005',
            by_statement: 'Brandon Sanderson',
          });
        }
        return jsonResponse({}, 404);
      },
    });

    const aggregator = new MetadataAggregator({
      providers: [flakyHardcover, slowGoogle, openLibrary],
      timeoutMs: 40,
      now: () => new Date(nowMs),
    });

    // Totalausfall darf nicht gecacht werden
    const allFailed = await aggregator.lookupByIsbn('9780765350374', '0765350378');
    expect(allFailed.merged).toBeNull();
    expect(
      allFailed.providerStatuses.map((s) => `${s.provider}:${s.status}`)
    ).toEqual([
      'hardcover:error',
      'google_books:timeout',
      'openlibrary:error',
    ]);

    // Jetzt liefert Open Library wieder Daten -> muss erneut abgefragt werden (kein Cache-Hit vom Totalausfall)
    shouldFailAll = false;
    const partialOk = await aggregator.lookupByIsbn('9780765350374', '0765350378');
    expect(partialOk.merged?.title).toBe('Elantris');
    expect(partialOk.merged?.seriesNumber).toBe(1);
    expect(
      partialOk.providerStatuses.find((s) => s.provider === 'google_books')?.status
    ).toBe('timeout');
    expect(
      partialOk.providerStatuses.find((s) => s.provider === 'hardcover')?.status
    ).toBe('error');
    const callsAfterSuccess = olCalls;

    // Innerhalb von 15 Min (t + 10 Min) -> Cache-Hit!
    nowMs += 10 * 60 * 1000;
    const cachedHit = await aggregator.lookupByIsbn('9780765350374', '0765350378');
    expect(cachedHit.merged?.title).toBe('Elantris');
    expect(olCalls).toBe(callsAfterSuccess);

    // Nach > 15 Min (t + 16 Min) -> Cache abgelaufen, erneuter Abruf
    nowMs += 6 * 60 * 1000;
    await aggregator.lookupByIsbn('9780765350374', '0765350378');
    expect(olCalls).toBeGreaterThan(callsAfterSuccess);
  });

  it('schützt /api/metadata/* mit Auth, validiert ISBNs und gibt keine API-Keys preis', async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('openlibrary.org/search.json')) {
        return jsonResponse({
          docs: [
            {
              key: '/works/OL100W',
              title: 'Mistborn: The Final Empire',
              author_name: ['Brandon Sanderson'],
              isbn: ['9780765311788'],
              first_publish_year: 2006,
              subject: ['Fantasy', 'In library'],
            },
          ],
        });
      }
      if (url.includes('googleapis.com/books/v1/volumes')) {
        return jsonResponse({
          items: [
            {
              id: 'gb-mistborn',
              volumeInfo: {
                title: 'The Final Empire',
                authors: ['Brandon Sanderson'],
                industryIdentifiers: [
                  { type: 'ISBN_13', identifier: '9780765311788' },
                ],
                categories: ['Fantasy'],
              },
            },
          ],
        });
      }
      if (url.includes('openlibrary.org/isbn/9780765311788.json')) {
        return jsonResponse({
          key: '/books/OL100M',
          title: 'The Final Empire',
          series: ['Mistborn #1'],
          isbn_13: ['9780765311788'],
          by_statement: 'Brandon Sanderson',
        });
      }
      return jsonResponse({}, 404);
    };

    const env = parseEnv({
      DATA_DIR: './tmp-metadata-test',
      JWT_SECRET: 'metadata-route-test-secret-at-least-32-chars',
      GOOGLE_BOOKS_API_KEY: 'super-secret-google-key',
      LOG_LEVEL: 'silent',
    });

    const { app } = await buildApp({
      env,
      dbPath: ':memory:',
      metadataFetch: fetchMock,
      logger: false,
    });

    try {
      const unauth = await app.inject({
        method: 'GET',
        url: '/api/metadata/providers',
      });
      expect(unauth.statusCode).toBe(401);

      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'metauser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      const providersRes = await app.inject({
        method: 'GET',
        url: '/api/metadata/providers',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(providersRes.statusCode).toBe(200);
      expect(providersRes.body).not.toContain('super-secret-google-key');
      const providersParsed = MetadataProvidersResponseSchema.parse(
        providersRes.json()
      );
      expect(providersParsed.providers).toHaveLength(3);
      expect(
        providersParsed.providers.find((p) => p.id === 'hardcover')?.enabled
      ).toBe(false);

      const badIsbn = await app.inject({
        method: 'GET',
        url: '/api/metadata/isbn/978-0-000-00000-9',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(badIsbn.statusCode).toBe(400);
      expect(badIsbn.json().error.code).toBe('INVALID_ISBN');

      const isbnRes = await app.inject({
        method: 'GET',
        url: '/api/metadata/isbn/978-0-7653-1178-8',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(isbnRes.statusCode).toBe(200);
      const isbnParsed = MetadataIsbnResponseSchema.parse(isbnRes.json());
      expect(isbnParsed.isbn13).toBe('9780765311788');
      expect(isbnParsed.merged?.seriesName).toBe('Mistborn');
      expect(isbnParsed.merged?.seriesNumber).toBe(1);

      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/metadata/search?q=Mistborn&limit=5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(searchRes.statusCode).toBe(200);
      const searchParsed = MetadataSearchResponseSchema.parse(searchRes.json());
      expect(searchParsed.candidates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});
