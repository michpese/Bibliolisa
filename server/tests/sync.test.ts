import crypto from 'node:crypto';
import { SyncResponseSchema } from '@bibliolisa/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

const BASE_ENV = parseEnv({
  DATA_DIR: './tmp-sync-test',
  JWT_SECRET: 'sync-test-secret-with-at-least-32-characters-1234',
  LOG_LEVEL: 'silent',
});

function makeBookPayload(overrides: Partial<Record<string, unknown>> = {}) {
  const id = (overrides.id as string | undefined) ?? crypto.randomUUID();
  const ts =
    (overrides.updatedAt as string | undefined) ?? '2026-11-21T10:00:00.000Z';
  return {
    id,
    title: 'Standard Buch',
    subtitle: null,
    authors: ['Autor Eins'],
    seriesName: null,
    seriesNumber: null,
    isbn10: null,
    isbn13: null,
    pageCount: 320,
    publishedYear: 2020,
    genres: ['Fantasy'],
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
    ...overrides,
  };
}

function makeUserBookPayload(
  bookId: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  const id = (overrides.id as string | undefined) ?? crypto.randomUUID();
  const ts =
    (overrides.updatedAt as string | undefined) ?? '2026-11-21T10:00:00.000Z';
  return {
    id,
    bookId,
    status: 'unread',
    rating: null,
    notes: null,
    addedAt: ts,
    startedAt: null,
    finishedAt: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

describe('Delta-Sync (POST /api/sync), LWW-Konflikte, Pagination & Mandantentrennung', () => {
  it('schützt /api/sync per Auth, prüft Cursor-Format und paginiert Initial-Pull lückenlos über hasMore', async () => {
    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      const unauth = await app.inject({
        method: 'POST',
        url: '/api/sync',
        payload: {
          deviceId: 'dev-1',
          cursor: null,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(unauth.statusCode).toBe(401);

      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'syncpager',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      const badCursor = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-1',
          cursor: 'not-valid-base64-cursor',
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(badCursor.statusCode).toBe(400);
      expect(badCursor.json().error.code).toBe('INVALID_SYNC_CURSOR');

      // 3 Bücher via Web-API anlegen (ergibt 6 synchronisierbare Zeilen: 3 books + 3 user_books)
      const createdBookIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        nowMs += 1000;
        const res = await app.inject({
          method: 'POST',
          url: '/api/library',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            book: { title: `Paginated Buch ${i}`, authors: ['Autor'] },
          },
        });
        expect(res.statusCode).toBe(201);
        createdBookIds.push(res.json().bookId as string);
      }

      // Initial-Pull mit limit=2 durchpaginieren
      let cursor: string | null = null;
      let hasMore = true;
      let pages = 0;
      const pulledBookIds = new Set<string>();
      const pulledUserBookIds = new Set<string>();

      while (hasMore) {
        pages += 1;
        const syncRes = await app.inject({
          method: 'POST',
          url: '/api/sync',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            deviceId: 'android-1',
            cursor,
            clientTime: new Date(nowMs).toISOString(),
            limit: 2,
            changes: { books: [], userBooks: [] },
          },
        });
        expect(syncRes.statusCode).toBe(200);
        const body = SyncResponseSchema.parse(syncRes.json());
        for (const b of body.pull.books) pulledBookIds.add(b.id);
        for (const ub of body.pull.userBooks) pulledUserBookIds.add(ub.id);
        cursor = body.nextCursor;
        hasMore = body.hasMore;
      }

      expect(pages).toBe(3);
      expect(pulledBookIds.size).toBe(3);
      expect(pulledUserBookIds.size).toBe(3);
      for (const id of createdBookIds) {
        expect(pulledBookIds.has(id)).toBe(true);
      }
      expect(cursor).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('liefert in pull.books ausschließlich vom authentifizierten Benutzer referenzierte Bücher (keine Leaks) und isoliert Schreibzugriffe', async () => {
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

      // User A legt privates Buch A1 und ein später geteiltes Buch SharedBook (mit ISBN) an
      const resA1 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          notes: 'Nur für User A',
          book: { title: 'Geheimes Buch A', authors: ['Autor A'] },
        },
      });
      const bookA1Id = resA1.json().bookId as string;
      const ubA1Id = resA1.json().id as string;

      nowMs += 1000;
      const resSharedA = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          book: {
            title: 'Geteiltes Buch',
            authors: ['Brandon Sanderson'],
            isbn13: '9783453267176',
          },
        },
      });
      const sharedBookId = resSharedA.json().bookId as string;

      // User B legt eigenes Buch B1 an (noch keine Referenz auf SharedBook oder A1)
      nowMs += 1000;
      const resB1 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          book: { title: 'Buch B', authors: ['Autor B'] },
        },
      });
      const bookB1Id = resB1.json().bookId as string;

      // Initialer Pull von User B: darf NUR Buch B enthalten (NICHT Geheimes Buch A, NICHT SharedBook!)
      nowMs += 1000;
      const pullB1 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          deviceId: 'phone-b',
          cursor: null,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(pullB1.statusCode).toBe(200);
      const bodyB1 = SyncResponseSchema.parse(pullB1.json());
      expect(bodyB1.pull.books.map((b) => b.id)).toEqual([bookB1Id]);
      expect(bodyB1.pull.userBooks).toHaveLength(1);
      const cursorB = bodyB1.nextCursor;

      // Jetzt fügt User B dasselbe Buch (SharedBook via ISBN-Match) im Web hinzu -> books.server_updated_at bleibt ALT!
      nowMs += 1000;
      const resSharedB = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          status: 'reading',
          book: {
            title: 'Geteiltes Buch',
            authors: ['Brandon Sanderson'],
            isbn13: '9783453267176',
          },
        },
      });
      expect(resSharedB.json().bookId).toBe(sharedBookId);

      // Inkrementeller Pull von User B: muss neuen user_books-Eintrag UND zugehöriges SharedBook liefern (trotz altem books.server_updated_at), weiterhin OHNE bookA1Id
      nowMs += 1000;
      const pullB2 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          deviceId: 'phone-b',
          cursor: cursorB,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(pullB2.statusCode).toBe(200);
      const bodyB2 = SyncResponseSchema.parse(pullB2.json());
      expect(bodyB2.pull.userBooks).toHaveLength(1);
      expect(bodyB2.pull.userBooks[0]?.bookId).toBe(sharedBookId);
      expect(bodyB2.pull.books.map((b) => b.id)).toEqual([sharedBookId]);
      expect(bodyB2.pull.books.some((b) => b.id === bookA1Id)).toBe(false);

      // User B versucht fremde Datensätze von User A per Push zu überschreiben -> rejected
      nowMs += 1000;
      const hijackAttempt = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          deviceId: 'phone-b',
          cursor: bodyB2.nextCursor,
          clientTime: new Date(nowMs).toISOString(),
          changes: {
            books: [
              makeBookPayload({
                id: bookA1Id,
                title: 'Gehackt',
                updatedAt: new Date(nowMs).toISOString(),
              }),
            ],
            userBooks: [
              makeUserBookPayload(bookA1Id, {
                id: ubA1Id,
                notes: 'Gehackte Notiz',
                updatedAt: new Date(nowMs).toISOString(),
              }),
            ],
          },
        },
      });
      expect(hijackAttempt.statusCode).toBe(200);
      const hijackBody = hijackAttempt.json();
      expect(hijackBody.pushResults.books[0]).toEqual({
        id: bookA1Id,
        status: 'rejected',
        reason: 'book_not_in_user_library',
      });
      expect(hijackBody.pushResults.userBooks[0]).toEqual({
        id: ubA1Id,
        status: 'rejected',
        reason: 'forbidden_user_book_id',
      });
      expect(hijackBody.pull.books).toEqual([]);
      expect(hijackBody.pull.userBooks).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('löst LWW-Konflikte (Client-Wins, Server-Wins) sowie verzögerten Offline-Push bei zwischenzeitlichem Cursor deterministisch auf', async () => {
    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'conflictuser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      // 10:00: Buch 1 initial auf Gerät A angelegt und gesynct
      const book1Id = crypto.randomUUID();
      const ub1Id = crypto.randomUUID();
      const t1000 = new Date(nowMs).toISOString();

      const pushA1 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-a',
          cursor: null,
          clientTime: t1000,
          changes: {
            books: [makeBookPayload({ id: book1Id, title: 'Originaltitel', createdAt: t1000, updatedAt: t1000 })],
            userBooks: [makeUserBookPayload(book1Id, { id: ub1Id, status: 'unread', createdAt: t1000, updatedAt: t1000 })],
          },
        },
      });
      expect(pushA1.statusCode).toBe(200);

      // 10:01: Gerät B führt Initial-Pull durch
      nowMs = Date.parse('2026-11-21T10:01:00.000Z');
      const syncB1 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-b',
          cursor: null,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      let cursorB = syncB1.json().nextCursor as string;
      expect(syncB1.json().pull.userBooks).toHaveLength(1);

      // 10:02: Gerät A bearbeitet Buch 1 OFFLINE (updatedAt = 10:02)
      const t1002 = '2026-11-21T10:02:00.000Z';

      // 10:03: Gerät B legt neues Buch 2 an und synct -> cursorB liegt nun bei Server-Zeit 10:03 (NACH 10:02!)
      nowMs = Date.parse('2026-11-21T10:03:00.000Z');
      const book2Id = crypto.randomUUID();
      const ub2Id = crypto.randomUUID();
      const t1003 = new Date(nowMs).toISOString();
      const syncB2 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-b',
          cursor: cursorB,
          clientTime: t1003,
          changes: {
            books: [makeBookPayload({ id: book2Id, title: 'Buch 2 von B', createdAt: t1003, updatedAt: t1003 })],
            userBooks: [makeUserBookPayload(book2Id, { id: ub2Id, createdAt: t1003, updatedAt: t1003 })],
          },
        },
      });
      cursorB = syncB2.json().nextCursor as string;

      // 10:04: Gerät A kommt wieder online und pusht seine 10:02-Änderung -> akzeptiert mit server_updated_at = 10:04
      nowMs = Date.parse('2026-11-21T10:04:00.000Z');
      const syncA2 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-a',
          cursor: pushA1.json().nextCursor,
          clientTime: new Date(nowMs).toISOString(),
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(book1Id, {
                id: ub1Id,
                status: 'reading',
                notes: 'Montag-Notiz offline',
                createdAt: t1000,
                updatedAt: t1002,
              }),
            ],
          },
        },
      });
      expect(syncA2.statusCode).toBe(200);
      expect(syncA2.json().pushResults.userBooks[0]).toEqual({
        id: ub1Id,
        status: 'accepted',
      });
      // Gerät A bekommt dabei auch Buch 2 von Gerät B
      expect(syncA2.json().pull.books.map((b: { id: string }) => b.id)).toEqual([
        book2Id,
      ]);

      // 10:05: Gerät B synct mit seinem 10:03-Cursor -> muss die 10:02-Offline-Änderung dank server_updated_at (10:04) zuverlässig erhalten!
      nowMs = Date.parse('2026-11-21T10:05:00.000Z');
      const syncB3 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-b',
          cursor: cursorB,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(syncB3.statusCode).toBe(200);
      expect(syncB3.json().pull.userBooks).toHaveLength(1);
      expect(syncB3.json().pull.userBooks[0].id).toBe(ub1Id);
      expect(syncB3.json().pull.userBooks[0].notes).toBe('Montag-Notiz offline');
      // Zugehöriges Buch 1 wird für FK-Sicherheit oder Konsistenz ebenfalls gepullt bzw. bei unverändertem Buch geladen
      expect(syncB3.json().pull.books.some((b: { id: string }) => b.id === book1Id)).toBe(true);

      // LWW Server-Wins Test: Gerät A schickt veraltetes Update (10:01 < 10:02)
      nowMs = Date.parse('2026-11-21T10:06:00.000Z');
      const stalePush = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'device-a',
          cursor: syncA2.json().nextCursor,
          clientTime: new Date(nowMs).toISOString(),
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(book1Id, {
                id: ub1Id,
                status: 'abandoned',
                notes: 'Veraltete Notiz',
                createdAt: t1000,
                updatedAt: '2026-11-21T10:01:00.000Z',
              }),
            ],
          },
        },
      });
      expect(stalePush.statusCode).toBe(200);
      expect(stalePush.json().pushResults.userBooks[0].status).toBe(
        'conflict_server_won'
      );
      expect(stalePush.json().pull.userBooks[0].id).toBe(ub1Id);
      expect(stalePush.json().pull.userBooks[0].status).toBe('reading');
      expect(stalePush.json().pull.userBooks[0].notes).toBe('Montag-Notiz offline');
    } finally {
      await app.close();
    }
  });

  it('behandelt Soft-Delete-/Restore-Konflikte, doppelte aktive (user_id, book_id)-Einträge und Clock-Skew-Kappung', async () => {
    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app, dbCtx } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'edgeuser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const token = reg.json().accessToken as string;

      const bookId = crypto.randomUUID();
      const ubCanonicalId = crypto.randomUUID();
      const ubDuplicateId = crypto.randomUUID();
      const t0 = new Date(nowMs).toISOString();

      // Gerät 1 legt Buch + UserBook ubCanonicalId an
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-1',
          cursor: null,
          clientTime: t0,
          changes: {
            books: [makeBookPayload({ id: bookId, title: 'Duplikat-Test', createdAt: t0, updatedAt: t0 })],
            userBooks: [makeUserBookPayload(bookId, { id: ubCanonicalId, status: 'unread', createdAt: t0, updatedAt: t0 })],
          },
        },
      });
      expect(res1.statusCode).toBe(200);

      // Gerät 2 hat offline dasselbe Buch (bookId) unter neuer UUID ubDuplicateId mit neuerem updatedAt angelegt
      nowMs += 60_000;
      const t1 = new Date(nowMs).toISOString();
      const dupPush = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-2',
          cursor: null,
          clientTime: t1,
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(bookId, {
                id: ubDuplicateId,
                status: 'read',
                rating: 5,
                notes: 'Vom zweiten Gerät gemergt',
                createdAt: t1,
                updatedAt: t1,
              }),
            ],
          },
        },
      });
      expect(dupPush.statusCode).toBe(200);
      expect(dupPush.json().pushResults.userBooks[0]).toEqual({
        id: ubDuplicateId,
        status: 'rejected',
        reason: 'duplicate_active_user_book_merged',
      });
      expect(dupPush.json().pull.userBooks).toHaveLength(1);
      expect(dupPush.json().pull.userBooks[0].id).toBe(ubCanonicalId);
      expect(dupPush.json().pull.userBooks[0].status).toBe('read');
      expect(dupPush.json().pull.userBooks[0].rating).toBe(5);

      // Soft Delete auf ubCanonicalId
      nowMs += 60_000;
      const tDelete = new Date(nowMs).toISOString();
      const deletePush = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-1',
          cursor: res1.json().nextCursor,
          clientTime: tDelete,
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(bookId, {
                id: ubCanonicalId,
                status: 'read',
                rating: 5,
                createdAt: t0,
                updatedAt: tDelete,
                deletedAt: tDelete,
              }),
            ],
          },
        },
      });
      expect(deletePush.json().pushResults.userBooks[0].status).toBe('accepted');

      // books.deleted_at darf NICHT gesetzt sein
      const bookRow = dbCtx.sqlite
        .prepare('SELECT deleted_at FROM books WHERE id = ?')
        .get(bookId) as { deleted_at: string | null };
      expect(bookRow.deleted_at).toBeNull();

      // Späterer Restore gewinnt gegen älteren Soft Delete
      nowMs += 60_000;
      const tRestore = new Date(nowMs).toISOString();
      const restorePush = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-2',
          cursor: dupPush.json().nextCursor,
          clientTime: tRestore,
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(bookId, {
                id: ubCanonicalId,
                status: 'reading',
                createdAt: t0,
                updatedAt: tRestore,
                deletedAt: null,
              }),
            ],
          },
        },
      });
      expect(restorePush.json().pushResults.userBooks[0].status).toBe('accepted');

      // Clock-Skew-Kappung (> serverNow + 5 Min wird gekappt und im pull zurückgeliefert)
      nowMs += 60_000;
      const wayInFuture = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
      const expectedClamped = new Date(nowMs + 5 * 60 * 1000).toISOString();
      const skewPush = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: 'dev-skew',
          cursor: restorePush.json().nextCursor,
          clientTime: wayInFuture,
          changes: {
            books: [],
            userBooks: [
              makeUserBookPayload(bookId, {
                id: ubCanonicalId,
                status: 'read',
                notes: 'Verstellte Uhr',
                createdAt: t0,
                updatedAt: wayInFuture,
                deletedAt: null,
              }),
            ],
          },
        },
      });
      expect(skewPush.statusCode).toBe(200);
      const skewBody = SyncResponseSchema.parse(skewPush.json());
      expect(skewBody.clockSkewWarning).toBe(true);
      expect(skewBody.pushResults.userBooks[0]?.status).toBe('accepted');
      expect(skewBody.pull.userBooks).toHaveLength(1);
      expect(skewBody.pull.userBooks[0]?.updatedAt).toBe(expectedClamped);
    } finally {
      await app.close();
    }
  });
});
