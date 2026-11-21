import { RecommendationResultSchema } from '@bibliolisa/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

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
});
