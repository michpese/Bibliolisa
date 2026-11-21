import { ExportPayloadSchema, ImportResultSchema } from '@bibliolisa/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

const BASE_ENV = parseEnv({
  DATA_DIR: './tmp-export-test',
  JWT_SECRET: 'export-test-secret-with-at-least-32-characters-12',
  LOG_LEVEL: 'silent',
});

describe('Export (JSON/CSV), Formula-Injection-Schutz & Idempotenter Import', () => {
  it('führt JSON-Export -> Soft-Delete -> Re-Import, Cross-User-Import sowie Idempotenz korrekt aus', async () => {
    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      const regA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'exporterA',
          displayName: 'Exporter A',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenA = regA.json().accessToken as string;

      const regB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'importerB',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenB = regB.json().accessToken as string;

      // 2 Bücher für User A anlegen (eines davon wird später soft-gelöscht, eines bleibt)
      const create1 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          status: 'read',
          rating: 5,
          notes: 'Großartiges Werk',
          book: {
            title: 'Der Weg der Könige',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 1,
            isbn13: '9783453267176',
            genres: ['Fantasy'],
            pageCount: 1344,
          },
        },
      });
      const entry1Id = create1.json().id as string;

      nowMs += 1000;
      const create2 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          status: 'unread',
          book: {
            title: 'Worte des Lichts',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 2,
          },
        },
      });
      const entry2Id = create2.json().id as string;

      // JSON-Export abrufen
      const exportRes = await app.inject({
        method: 'GET',
        url: '/api/export/json',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(exportRes.statusCode).toBe(200);
      expect(exportRes.headers['content-disposition']).toMatch(
        /^attachment; filename="bibliolisa-export-\d{4}-\d{2}-\d{2}\.json"$/
      );
      const exported = ExportPayloadSchema.parse(exportRes.json());
      expect(exported.entries).toHaveLength(2);
      expect(exported.user.username).toBe('exporterA');

      // Beide Einträge bei User A per Soft-Delete entfernen
      nowMs += 5000;
      await app.inject({
        method: 'DELETE',
        url: `/api/library/${entry1Id}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      await app.inject({
        method: 'DELETE',
        url: `/api/library/${entry2Id}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      const listAfterDelete = await app.inject({
        method: 'GET',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(listAfterDelete.json().total).toBe(0);

      // Re-Import in User A -> stellt beide Einträge sauber wieder her
      nowMs += 5000;
      const reimportA = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: exported,
      });
      expect(reimportA.statusCode).toBe(200);
      expect(ImportResultSchema.parse(reimportA.json())).toEqual({
        imported: 2,
        updated: 0,
        skipped: 0,
        errors: [],
      });

      const listAfterReimport = await app.inject({
        method: 'GET',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(listAfterReimport.json().total).toBe(2);

      // Zweiter identischer Import -> vollständig idempotent (skipped: 2)
      const idempotentImport = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: exported,
      });
      expect(idempotentImport.statusCode).toBe(200);
      expect(idempotentImport.json()).toEqual({
        imported: 0,
        updated: 0,
        skipped: 2,
        errors: [],
      });

      // Aktualisierter Import mit neuerem updatedAt -> updated: 1, skipped: 1
      nowMs += 5000;
      const modifiedExport = structuredClone(exported);
      modifiedExport.entries[0]!.notes = 'Aktualisierte Notiz aus Backup';
      modifiedExport.entries[0]!.updatedAt = new Date(nowMs).toISOString();
      const updateImport = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: modifiedExport,
      });
      expect(updateImport.statusCode).toBe(200);
      expect(updateImport.json()).toEqual({
        imported: 0,
        updated: 1,
        skipped: 1,
        errors: [],
      });

      // Cross-User-Import in neuen Benutzer B (ohne PK-Kollision auf user_books.id)
      const importB = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: exported,
      });
      expect(importB.statusCode).toBe(200);
      expect(importB.json()).toEqual({
        imported: 2,
        updated: 0,
        skipped: 0,
        errors: [],
      });

      const listB = await app.inject({
        method: 'GET',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(listB.json().total).toBe(2);

      // Kaputtes Envelope -> 400 VALIDATION_ERROR
      const badEnvelope = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { version: 99, entries: [] },
      });
      expect(badEnvelope.statusCode).toBe(400);
      expect(badEnvelope.json().error.code).toBe('VALIDATION_ERROR');

      // Teilweise fehlerhafte Einzeleinträge werden in errors[] gesammelt
      const partialBadPayload = {
        ...exported,
        entries: [{ invalid: true }],
      };
      const partialRes = await app.inject({
        method: 'POST',
        url: '/api/import/json',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: partialBadPayload,
      });
      expect(partialRes.statusCode).toBe(200);
      expect(partialRes.json().errors).toHaveLength(1);
      expect(partialRes.json().errors[0].index).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('exportiert CSV mit UTF-8 BOM, RFC-4180-Quoting und Formula-Injection-Maskierung (=, +, -, @)', async () => {
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'csvuser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          status: 'read',
          rating: 4,
          notes: '+SUM(A1:A2)',
          book: {
            title: '=HYPERLINK("http://evil.example","Klick")',
            subtitle: '-1+1',
            authors: ['@admin', 'Normaler Autor, Jr.'],
            publisher: 'Heyne "Special"',
          },
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          status: 'unread',
          notes: '  =1+1',
          book: {
            title: 'Zweites Buch',
            authors: ['Autor Zwei'],
          },
        },
      });

      const csvRes = await app.inject({
        method: 'GET',
        url: '/api/export/csv',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      expect(csvRes.headers['content-disposition']).toMatch(
        /^attachment; filename="bibliolisa-export-\d{4}-\d{2}-\d{2}\.csv"$/
      );

      const csvText = csvRes.body;
      // UTF-8 BOM am Anfang prüfen
      expect(csvText.charCodeAt(0)).toBe(0xfeff);
      expect(csvText).toContain('"\'=HYPERLINK(""http://evil.example"",""Klick"")"');
      expect(csvText).toContain("'+SUM(A1:A2)");
      expect(csvText).toContain("'-1+1");
      expect(csvText).toContain("'  =1+1");
      expect(csvText).toContain("'@admin; Normaler Autor, Jr.");
      expect(csvText).toContain('"Heyne ""Special"""');
    } finally {
      await app.close();
    }
  });
});
