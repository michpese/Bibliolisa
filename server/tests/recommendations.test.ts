import {
  RecommendationResultSchema,
  type RecommendationResult,
} from '@bibliolisa/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

function allRecommendedTitles(result: RecommendationResult): string[] {
  return [
    ...result.categories.continue_series,
    ...result.categories.affinity,
    ...result.categories.quick_read,
    ...result.categories.dust_collector,
    ...result.categories.surprise_me,
  ]
    .map((item) => item.entry?.book.title)
    .filter((title): title is string => typeof title === 'string');
}

const BASE_ENV = parseEnv({
  DATA_DIR: './tmp-recs-test',
  JWT_SECRET: 'recommendations-test-secret-at-least-32-chars',
  LOG_LEVEL: 'silent',
});

describe('Empfehlungs-Endpunkt (GET /api/recommendations)', () => {
  it('schützt /api/recommendations per Auth, isoliert Benutzer und priorisiert begonnene Reihen mit Dezimalband', async () => {
    const fixedNow = new Date('2026-11-21T12:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => fixedNow,
      logger: false,
    });

    try {
      const unauth = await app.inject({
        method: 'GET',
        url: '/api/recommendations',
      });
      expect(unauth.statusCode).toBe(401);

      const regA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'readerA',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenA = regA.json().accessToken as string;

      const regB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'readerB',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenB = regB.json().accessToken as string;

      const booksToSeed = [
        {
          status: 'read',
          rating: 5,
          addedAt: '2026-01-01T10:00:00.000Z',
          finishedAt: '2026-02-01T10:00:00.000Z',
          book: {
            title: 'Sturmlicht 1',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 1,
            genres: ['High Fantasy'],
            pageCount: 1000,
          },
        },
        {
          status: 'unread',
          addedAt: '2026-03-01T10:00:00.000Z',
          book: {
            title: 'Sturmlicht 2',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 2,
            genres: ['High Fantasy'],
            pageCount: 950,
          },
        },
        {
          status: 'unread',
          addedAt: '2026-03-05T10:00:00.000Z',
          book: {
            title: 'Sturmlicht 1.5 (Edgedancer)',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 1.5,
            genres: ['High Fantasy'],
            pageCount: 220,
          },
        },
        {
          status: 'unread',
          addedAt: '2025-01-01T10:00:00.000Z',
          book: {
            title: 'Elantris',
            authors: ['Brandon Sanderson'],
            genres: ['High Fantasy'],
            pageCount: 260,
          },
        },
      ];

      for (const payload of booksToSeed) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/library',
          headers: { authorization: `Bearer ${tokenA}` },
          payload,
        });
        expect(res.statusCode).toBe(201);
      }

      const recA1 = await app.inject({
        method: 'GET',
        url: '/api/recommendations?seed=42&limitPerCategory=5',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(recA1.statusCode).toBe(200);
      const parsedA = RecommendationResultSchema.parse(recA1.json());
      expect(parsedA.seed).toBe(42);

      // Stufe 1: Band 1.5 muss vor Band 2 als nächster Reihenband empfohlen werden
      expect(parsedA.categories.continue_series).toHaveLength(1);
      expect(parsedA.categories.continue_series[0]?.entry?.book.title).toBe(
        'Sturmlicht 1.5 (Edgedancer)'
      );
      expect(parsedA.categories.continue_series[0]?.reasonText).toContain('#1.5');
      expect(parsedA.categories.continue_series[0]?.reasonText).toContain(
        'Sturmlicht'
      );

      // Stufe 2: Affinität empfiehlt Elantris (Sanderson + High Fantasy)
      expect(parsedA.categories.affinity[0]?.entry?.book.title).toBe('Elantris');

      // Stufe 3a: Schneller Read (< 300 Seiten)
      expect(
        parsedA.categories.quick_read.map((item) => item.entry?.book.pageCount)
      ).toEqual([220, 260]);

      // Stufe 3b: Staubfänger (ältester addedAt zuerst)
      expect(parsedA.categories.dust_collector[0]?.entry?.book.title).toBe(
        'Elantris'
      );

      // Solange Band 1.5 noch offen ist, darf Band 2 in keiner Kategorie erscheinen
      expect(allRecommendedTitles(parsedA)).not.toContain('Sturmlicht 2');

      // Deterministisches Überrasch mich bei identischem Seed
      const recA2 = await app.inject({
        method: 'GET',
        url: '/api/recommendations?seed=42&limitPerCategory=5',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(
        recA2.json().categories.surprise_me.map(
          (i: { userBookId: string }) => i.userBookId
        )
      ).toEqual(parsedA.categories.surprise_me.map((i) => i.userBookId));

      // User B mit leerer Bibliothek bekommt komplett leere Empfehlungen
      const recB = await app.inject({
        method: 'GET',
        url: '/api/recommendations',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(recB.statusCode).toBe(200);
      const parsedB = RecommendationResultSchema.parse(recB.json());
      expect(parsedB.categories.continue_series).toEqual([]);
      expect(parsedB.categories.affinity).toEqual([]);
      expect(parsedB.categories.quick_read).toEqual([]);
      expect(parsedB.categories.dust_collector).toEqual([]);
      expect(parsedB.categories.surprise_me).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('blockiert spätere Folgebände bei unbegonnenen Reihen, Lücken und begonnenen Reihen über GET /api/recommendations in allen Kategorien', async () => {
    const fixedNow = new Date('2026-11-21T12:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => fixedNow,
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'seriesGuardUser',
          password: 'Password123!',
          clientType: 'web',
        },
      });
      const token = reg.json().accessToken as string;

      const seedBooks = [
        // 1. Unbegonnene Reihe mit Band 4 (ohne 1–3, kurz & alt) -> nirgends erlaubt
        {
          status: 'unread',
          addedAt: '2020-01-01T10:00:00.000Z',
          book: {
            title: 'Unbegonnen Band 4',
            authors: ['Autor A'],
            seriesName: 'Unbegonnene Reihe',
            seriesNumber: 4,
            genres: ['Fantasy'],
            pageCount: 95,
          },
        },
        // 2. Begonnene Reihe mit fehlenden Zwischenbänden (Band 1 read, Band 2–3 fehlen, Band 4 unread)
        {
          status: 'read',
          rating: 5,
          addedAt: '2026-01-01T10:00:00.000Z',
          finishedAt: '2026-02-01T10:00:00.000Z',
          book: {
            title: 'Lücke Band 1',
            authors: ['Autor B'],
            seriesName: 'Lücken-Saga',
            seriesNumber: 1,
            genres: ['Fantasy'],
            pageCount: 320,
          },
        },
        {
          status: 'unread',
          addedAt: '2020-02-01T10:00:00.000Z',
          book: {
            title: 'Lücke Band 4',
            authors: ['Autor B'],
            seriesName: 'Lücken-Saga',
            seriesNumber: 4,
            genres: ['Fantasy'],
            pageCount: 100,
          },
        },
        // 3. Begonnene Reihe mit Bänden 1–4 -> maximal Band 2, niemals Band 3 oder 4
        {
          status: 'read',
          rating: 5,
          addedAt: '2026-03-01T10:00:00.000Z',
          finishedAt: '2026-04-01T10:00:00.000Z',
          book: {
            title: 'Komplett Band 1',
            authors: ['Autor C'],
            seriesName: 'Komplette Reihe',
            seriesNumber: 1,
            genres: ['Sci-Fi'],
            pageCount: 350,
          },
        },
        {
          status: 'unread',
          addedAt: '2026-05-01T10:00:00.000Z',
          book: {
            title: 'Komplett Band 2',
            authors: ['Autor C'],
            seriesName: 'Komplette Reihe',
            seriesNumber: 2,
            genres: ['Sci-Fi'],
            pageCount: 220,
          },
        },
        {
          status: 'unread',
          addedAt: '2021-01-01T10:00:00.000Z',
          book: {
            title: 'Komplett Band 3',
            authors: ['Autor C'],
            seriesName: 'Komplette Reihe',
            seriesNumber: 3,
            genres: ['Sci-Fi'],
            pageCount: 110,
          },
        },
        {
          status: 'unread',
          addedAt: '2020-03-01T10:00:00.000Z',
          book: {
            title: 'Komplett Band 4',
            authors: ['Autor C'],
            seriesName: 'Komplette Reihe',
            seriesNumber: 4,
            genres: ['Sci-Fi'],
            pageCount: 90,
          },
        },
      ];

      for (const payload of seedBooks) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/library',
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        expect(res.statusCode).toBe(201);
      }

      const recRes = await app.inject({
        method: 'GET',
        url: '/api/recommendations?seed=77&limitPerCategory=10',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(recRes.statusCode).toBe(200);
      const parsed = RecommendationResultSchema.parse(recRes.json());
      const titles = allRecommendedTitles(parsed);

      expect(titles).not.toContain('Unbegonnen Band 4');
      expect(titles).not.toContain('Lücke Band 4');
      expect(titles).not.toContain('Komplett Band 3');
      expect(titles).not.toContain('Komplett Band 4');

      expect(
        parsed.categories.continue_series.map((i) => i.entry?.book.title)
      ).toEqual(['Komplett Band 2']);
      expect(
        parsed.categories.quick_read.map((i) => i.entry?.book.title)
      ).toEqual(['Komplett Band 2']);
      expect(
        parsed.categories.dust_collector.map((i) => i.entry?.book.title)
      ).toEqual(['Komplett Band 2']);
      expect(
        parsed.categories.surprise_me.map((i) => i.entry?.book.title)
      ).toEqual(['Komplett Band 2']);
      expect(parsed.categories.affinity).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
