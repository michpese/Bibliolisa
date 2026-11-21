import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

const tempDirs: string[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('SQLite (WAL), Bibliothek-CRUD, Mandantentrennung, Sortierung & Soft-Delete', () => {
  it('konfiguriert SQLite im WAL-Modus mit Foreign Keys und persistiert nach Shutdown-Checkpoint', async () => {
    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'library-test-secret-minimum-32-characters-long',
      LOG_LEVEL: 'silent',
    });

    const first = await buildApp({ env, logger: false });
    let entryId: string;
    let tokenA: string;

    try {
      const journalMode = first.dbCtx.sqlite.pragma('journal_mode', {
        simple: true,
      });
      const fkEnabled = first.dbCtx.sqlite.pragma('foreign_keys', {
        simple: true,
      });
      const busyTimeout = first.dbCtx.sqlite.pragma('busy_timeout', {
        simple: true,
      });

      expect(String(journalMode).toLowerCase()).toBe('wal');
      expect(fkEnabled).toBe(1);
      expect(busyTimeout).toBe(5000);

      const indexRow = first.dbCtx.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_books_active_unique'"
        )
        .get() as { name: string } | undefined;
      expect(indexRow?.name).toBe('idx_user_books_active_unique');

      const regA = await first.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'reader1',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      tokenA = regA.json().accessToken as string;

      const createRes = await first.app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          status: 'reading',
          rating: 5,
          book: {
            title: 'Der Weg der Könige',
            authors: ['Brandon Sanderson'],
            isbn13: '978-3-453-26717-6',
            seriesName: 'Die Sturmlicht-Chroniken',
            seriesNumber: 1,
            genres: ['High Fantasy', 'Fantasy'],
            pageCount: 1344,
            publishedYear: 2011,
          },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      entryId = created.id as string;
      expect(created.book.isbn10).toBe('3453267176');
      expect(created.book.isbn13).toBe('9783453267176');
    } finally {
      await first.app.close();
    }

    // Erneut öffnen und Persistenz nach Shutdown-Checkpoint verifizieren
    const second = await buildApp({ env, logger: false });
    try {
      const loginRes = await second.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'reader1',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const freshToken = loginRes.json().accessToken as string;
      const getRes = await second.app.inject({
        method: 'GET',
        url: `/api/library/${entryId}`,
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().book.title).toBe('Der Weg der Könige');
    } finally {
      await second.app.close();
    }
  });

  it('trennt Benutzer-Indizes strikt (User B sieht niemals Daten von User A) und teilt globale Books via ISBN', async () => {
    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'isolation-test-secret-minimum-32-chars-12345',
      LOG_LEVEL: 'silent',
    });

    const { app, dbCtx } = await buildApp({
      env,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      const regA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'userA',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenA = regA.json().accessToken as string;

      const regB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'userB',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenB = regB.json().accessToken as string;

      const createA = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          status: 'read',
          rating: 5,
          notes: 'Geheime Notiz von A',
          book: {
            title: 'Mistborn',
            authors: ['Brandon Sanderson'],
            isbn10: '0-8044-2957-X',
            genres: ['Fantasy'],
            seriesName: 'Mistborn',
            seriesNumber: 1,
          },
        },
      });
      expect(createA.statusCode).toBe(201);
      const entryA = createA.json();

      // Duplikat für denselben User A muss 409 liefern
      const dupA = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          bookId: entryA.bookId,
        },
      });
      expect(dupA.statusCode).toBe(409);

      // User B legt dasselbe Buch per ISBN-13 an -> verknüpft dieselbe book_id
      const createB = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          status: 'unread',
          book: {
            title: 'Mistborn',
            authors: ['Brandon Sanderson'],
            isbn13: '9780804429573',
            genres: ['Sci-Fi'],
          },
        },
      });
      expect(createB.statusCode).toBe(201);
      const entryB = createB.json();
      expect(entryB.bookId).toBe(entryA.bookId);

      // User B darf in Liste & Facetten nur seine eigenen Daten sehen
      const listB = await app.inject({
        method: 'GET',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(listB.statusCode).toBe(200);
      expect(listB.json().total).toBe(1);
      expect(listB.json().items[0].id).toBe(entryB.id);

      const facetsB = await app.inject({
        method: 'GET',
        url: '/api/library/facets',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(facetsB.statusCode).toBe(200);
      expect(facetsB.json().total).toBe(1);
      expect(facetsB.json().statusCounts).toEqual({
        unread: 1,
        reading: 0,
        read: 0,
        abandoned: 0,
      });

      // Direkter Zugriff / Mutation von User B auf User As Eintrag -> strikt 404
      const getAbyB = await app.inject({
        method: 'GET',
        url: `/api/library/${entryA.id}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(getAbyB.statusCode).toBe(404);

      const patchAbyB = await app.inject({
        method: 'PATCH',
        url: `/api/library/${entryA.id}`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { rating: 1 },
      });
      expect(patchAbyB.statusCode).toBe(404);

      const deleteAbyB = await app.inject({
        method: 'DELETE',
        url: `/api/library/${entryA.id}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(deleteAbyB.statusCode).toBe(404);

      const restoreAbyB = await app.inject({
        method: 'POST',
        url: `/api/library/${entryA.id}/restore`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(restoreAbyB.statusCode).toBe(404);

      // Gesamtanzahl Bücher in globaler Tabelle = 1
      const booksCount = dbCtx.sqlite
        .prepare('SELECT COUNT(*) AS count FROM books')
        .get() as { count: number };
      expect(booksCount.count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('sortiert Buchreihen exakt (1, 1.5, 2, 10; Einzelbände am Ende), filtert umfassend und führt Soft-Delete + Restore korrekt aus', async () => {
    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'sorting-softdelete-secret-minimum-32-chars-12',
      LOG_LEVEL: 'silent',
    });

    const { app, dbCtx } = await buildApp({
      env,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'sorter',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      const booksToCreate = [
        {
          status: 'unread',
          rating: null,
          notes: 'Steht noch auf dem Stapel',
          addedAt: '2026-11-01T10:00:00.000Z',
          book: {
            title: 'Einzelband ohne Reihe',
            authors: ['Zoe Autorin'],
            genres: ['Krimi'],
            pageCount: 240,
            publishedYear: 2018,
          },
        },
        {
          status: 'read',
          rating: 5,
          notes: 'Fantastisches Finale',
          addedAt: '2026-11-02T10:00:00.000Z',
          book: {
            title: 'Sturmlicht Band 10',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 10,
            genres: ['Fantasy', 'High Fantasy'],
            pageCount: 1100,
            publishedYear: 2024,
          },
        },
        {
          status: 'read',
          rating: 4,
          addedAt: '2026-11-03T10:00:00.000Z',
          book: {
            title: 'Sturmlicht Band 2',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 2,
            genres: ['Fantasy'],
            pageCount: 950,
            publishedYear: 2014,
          },
        },
        {
          status: 'reading',
          rating: 5,
          addedAt: '2026-11-04T10:00:00.000Z',
          book: {
            title: 'Sturmlicht Band 1.5',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 1.5,
            genres: ['Fantasy'],
            pageCount: 180,
            publishedYear: 2016,
          },
        },
        {
          status: 'read',
          rating: 5,
          addedAt: '2026-11-05T10:00:00.000Z',
          book: {
            title: 'Sturmlicht Band 1',
            authors: ['Brandon Sanderson'],
            seriesName: 'Sturmlicht',
            seriesNumber: 1,
            genres: ['Fantasy'],
            pageCount: 1000,
            publishedYear: 2010,
          },
        },
      ];

      const createdIds: string[] = [];
      for (const payload of booksToCreate) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/library',
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        expect(res.statusCode).toBe(201);
        createdIds.push(res.json().id as string);
      }

      // Reihen-Sortierung ASC: 1, 1.5, 2, 10, Einzelband
      const seriesAsc = await app.inject({
        method: 'GET',
        url: '/api/library?sort=series&order=asc',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(seriesAsc.statusCode).toBe(200);
      expect(
        seriesAsc.json().items.map((item: { book: { title: string } }) => item.book.title)
      ).toEqual([
        'Sturmlicht Band 1',
        'Sturmlicht Band 1.5',
        'Sturmlicht Band 2',
        'Sturmlicht Band 10',
        'Einzelband ohne Reihe',
      ]);

      // Reihen-Sortierung DESC: 10, 2, 1.5, 1, Einzelband (NULL bleibt am Ende!)
      const seriesDesc = await app.inject({
        method: 'GET',
        url: '/api/library?sort=series&order=desc',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(
        seriesDesc.json().items.map((item: { book: { title: string } }) => item.book.title)
      ).toEqual([
        'Sturmlicht Band 10',
        'Sturmlicht Band 2',
        'Sturmlicht Band 1.5',
        'Sturmlicht Band 1',
        'Einzelband ohne Reihe',
      ]);

      // Alle weiteren Sortiermodi prüfen
      const sortRating = await app.inject({
        method: 'GET',
        url: '/api/library?sort=rating',
        headers: { authorization: `Bearer ${token}` },
      });
      const ratingItems = sortRating.json().items as Array<{
        rating: number | null;
        book: { title: string };
      }>;
      expect(ratingItems[ratingItems.length - 1]?.rating).toBeNull();
      expect(ratingItems[0]?.rating).toBe(5);

      const sortStatus = await app.inject({
        method: 'GET',
        url: '/api/library?sort=status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sortStatus.json().items[0].status).toBe('reading');

      const sortYear = await app.inject({
        method: 'GET',
        url: '/api/library?sort=published_year',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sortYear.json().items[0].book.publishedYear).toBe(2024);

      const sortAuthor = await app.inject({
        method: 'GET',
        url: '/api/library?sort=author',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sortAuthor.json().items[0].book.authors[0]).toBe('Brandon Sanderson');

      // Filter & Suche prüfen
      const filteredGenre = await app.inject({
        method: 'GET',
        url: '/api/library?genre=high%20fantasy&minRating=5',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(filteredGenre.json().total).toBe(1);
      expect(filteredGenre.json().items[0].book.title).toBe('Sturmlicht Band 10');

      const searchedNotes = await app.inject({
        method: 'GET',
        url: '/api/library?q=Stapel',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(searchedNotes.json().total).toBe(1);
      expect(searchedNotes.json().items[0].book.title).toBe('Einzelband ohne Reihe');

      // PATCH aktualisiert persönliche Felder & Buch-Metadaten
      const targetId = createdIds[0]!;
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/library/${targetId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          status: 'read',
          rating: 4,
          book: {
            subtitle: 'Erweiterte Ausgabe',
          },
        },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().status).toBe('read');
      expect(patchRes.json().rating).toBe(4);
      expect(patchRes.json().book.subtitle).toBe('Erweiterte Ausgabe');

      // Soft Delete setzt deleted_at auf user_books, löscht nicht physisch und lässt books.deleted_at unberührt
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/library/${targetId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().id).toBe(targetId);
      expect(typeof deleteRes.json().deletedAt).toBe('string');

      const dbRowAfterDelete = dbCtx.sqlite
        .prepare(
          `SELECT ub.deleted_at AS ub_deleted, b.deleted_at AS b_deleted
           FROM user_books ub JOIN books b ON b.id = ub.book_id
           WHERE ub.id = ?`
        )
        .get(targetId) as { ub_deleted: string | null; b_deleted: string | null };
      expect(dbRowAfterDelete.ub_deleted).not.toBeNull();
      expect(dbRowAfterDelete.b_deleted).toBeNull();

      const getDeleted = await app.inject({
        method: 'GET',
        url: `/api/library/${targetId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(getDeleted.statusCode).toBe(404);

      const facetsAfterDelete = await app.inject({
        method: 'GET',
        url: '/api/library/facets',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(facetsAfterDelete.json().total).toBe(4);

      // Restore stellt Eintrag wieder aktiv her
      const restoreRes = await app.inject({
        method: 'POST',
        url: `/api/library/${targetId}/restore`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(restoreRes.statusCode).toBe(200);
      expect(restoreRes.json().deletedAt).toBeNull();
      expect(restoreRes.json().book.title).toBe('Einzelband ohne Reihe');

      const facetsAfterRestore = await app.inject({
        method: 'GET',
        url: '/api/library/facets',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(facetsAfterRestore.json().total).toBe(5);
    } finally {
      await app.close();
    }
  });
});
