import crypto from 'node:crypto';
import {
  SyncResponseSchema,
  SyncStatusResponseSchema,
} from '@bibliolisa/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
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

  it('liefert über GET /api/sync/status einen authentifizierten, mandantenisolierten Gesamtstatus für Web & Mobile', async () => {
    let nowMs = Date.parse('2026-11-24T10:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      // 1. Ohne Auth -> 401
      const unauth = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
      });
      expect(unauth.statusCode).toBe(401);

      // 2. User A registriert nur Web-Session -> no_mobile_device
      const regWebA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'webuserA',
          password: 'Password123!',
          clientType: 'web',
          deviceName: 'Firefox auf Windows',
        },
      });
      expect(regWebA.statusCode).toBe(201);
      const tokenWebA = regWebA.json().accessToken as string;

      const statusNoMobile = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      expect(statusNoMobile.statusCode).toBe(200);
      const parsedNoMobile = SyncStatusResponseSchema.parse(
        statusNoMobile.json()
      );
      expect(parsedNoMobile.status).toBe('no_mobile_device');
      expect(parsedNoMobile.totalBooks).toBe(0);
      expect(parsedNoMobile.deletedBooks).toBe(0);
      expect(parsedNoMobile.pendingForMobileCount).toBe(0);
      expect(parsedNoMobile.devices).toEqual([]);

      // 3. Mobile-Session für User A anmelden (noch ohne POST /api/sync) -> never_synced
      nowMs += 1000;
      const mobileDeviceId = 'android-device-a';
      const loginMobA = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'webuserA',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: mobileDeviceId,
          deviceName: 'Pixel 9',
        },
      });
      expect(loginMobA.statusCode).toBe(200);
      const tokenMobA = loginMobA.json().accessToken as string;

      const statusNeverSynced = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      expect(statusNeverSynced.statusCode).toBe(200);
      const parsedNeverSynced = SyncStatusResponseSchema.parse(
        statusNeverSynced.json()
      );
      expect(parsedNeverSynced.status).toBe('never_synced');
      expect(parsedNeverSynced.devices).toHaveLength(1);
      expect(parsedNeverSynced.devices[0]).toMatchObject({
        deviceId: mobileDeviceId,
        deviceName: 'Pixel 9',
        lastSyncAt: null,
        lastSyncCompleted: false,
        isUpToDate: false,
        sessionActive: true,
      });

      // 4. Buch via Web-API anlegen und danach vollständigen Mobile-Sync ausführen -> synced
      nowMs += 1000;
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenWebA}` },
        payload: {
          status: 'unread',
          book: { title: 'Sync Status Buch', authors: ['Autor X'] },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const createdUserBookId = createRes.json().id as string;

      // Vor Mobile-Sync mit bereits angelegtem Buch weiterhin never_synced + pendingForMobileCount = 2 (book + user_book)
      const statusBeforeFirstSync = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      const parsedBeforeFirstSync = SyncStatusResponseSchema.parse(
        statusBeforeFirstSync.json()
      );
      expect(parsedBeforeFirstSync.status).toBe('never_synced');
      expect(parsedBeforeFirstSync.totalBooks).toBe(1);
      expect(parsedBeforeFirstSync.pendingForMobileCount).toBe(2);

      // Unvollständiger paginated Sync (hasMore: true) hält lastSyncCompleted: false -> never_synced
      nowMs += 1000;
      const partialSync = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenMobA}` },
        payload: {
          deviceId: mobileDeviceId,
          deviceName: 'Pixel 9 Pro',
          cursor: null,
          clientTime: new Date(nowMs).toISOString(),
          limit: 1,
          changes: { books: [], userBooks: [] },
        },
      });
      expect(partialSync.statusCode).toBe(200);
      expect(partialSync.json().hasMore).toBe(true);

      const statusAfterPartial = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      expect(statusAfterPartial.json().status).toBe('never_synced');
      expect(statusAfterPartial.json().devices[0].lastSyncCompleted).toBe(false);
      expect(statusAfterPartial.json().devices[0].deviceName).toBe('Pixel 9 Pro');

      // Zweite Seite abschließen (hasMore: false) -> synced
      nowMs += 1000;
      const finalSync = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenMobA}` },
        payload: {
          deviceId: mobileDeviceId,
          cursor: partialSync.json().nextCursor,
          clientTime: new Date(nowMs).toISOString(),
          limit: 100,
          changes: { books: [], userBooks: [] },
        },
      });
      expect(finalSync.statusCode).toBe(200);
      expect(finalSync.json().hasMore).toBe(false);

      const statusSynced = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      const parsedSynced = SyncStatusResponseSchema.parse(statusSynced.json());
      expect(parsedSynced.status).toBe('synced');
      expect(parsedSynced.totalBooks).toBe(1);
      expect(parsedSynced.pendingForMobileCount).toBe(0);
      expect(parsedSynced.devices[0]).toMatchObject({
        deviceId: mobileDeviceId,
        deviceName: 'Pixel 9 Pro',
        lastSyncCompleted: true,
        isUpToDate: true,
        pendingServerChanges: 0,
        lastPulledCount: 2,
        sessionActive: true,
      });

      // 5. Bearbeitung in der Webapp -> server_ahead mit präziser Zählung
      nowMs += 1000;
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/library/${createdUserBookId}`,
        headers: { authorization: `Bearer ${tokenWebA}` },
        payload: { status: 'reading', rating: 5 },
      });
      expect(patchRes.statusCode).toBe(200);

      const statusAhead = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      const parsedAhead = SyncStatusResponseSchema.parse(statusAhead.json());
      expect(parsedAhead.status).toBe('server_ahead');
      expect(parsedAhead.pendingForMobileCount).toBe(1);
      expect(parsedAhead.devices[0]?.isUpToDate).toBe(false);
      expect(parsedAhead.devices[0]?.pendingServerChanges).toBe(1);

      // Erneuter Mobile-Sync -> zurück auf synced
      nowMs += 1000;
      const catchUpSync = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${tokenMobA}` },
        payload: {
          deviceId: mobileDeviceId,
          cursor: finalSync.json().nextCursor,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(catchUpSync.statusCode).toBe(200);
      expect(catchUpSync.json().pull.userBooks).toHaveLength(1);

      const statusRecovered = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenWebA}` },
      });
      const parsedRecovered = SyncStatusResponseSchema.parse(
        statusRecovered.json()
      );
      expect(parsedRecovered.status).toBe('synced');
      expect(parsedRecovered.pendingForMobileCount).toBe(0);

      // 6. Strikte Multi-User-Isolation: User B sieht niemals Geräte oder Bücher von User A
      nowMs += 1000;
      const regUserB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'userB_iso',
          password: 'Password123!',
          clientType: 'web',
        },
      });
      const tokenB = regUserB.json().accessToken as string;
      const statusB = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(statusB.statusCode).toBe(200);
      const parsedB = SyncStatusResponseSchema.parse(statusB.json());
      expect(parsedB.status).toBe('no_mobile_device');
      expect(parsedB.totalBooks).toBe(0);
      expect(parsedB.libraryLastModifiedAt).toBeNull();
      expect(parsedB.devices).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('migriert sync_devices automatisch über Drizzle-Migrationen auf einer bestehenden SQLite-Datenbank', () => {
    const dbCtx = createDatabase({
      dataDir: './tmp-sync-test',
      dbPath: ':memory:',
      autoMigrate: true,
    });
    try {
      const table = dbCtx.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_devices'"
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe('sync_devices');

      const indexes = dbCtx.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_devices'"
        )
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((idx) => idx.name);
      expect(indexNames).toContain('idx_sync_devices_user_device');
      expect(indexNames).toContain('idx_sync_devices_user_last_sync');
    } finally {
      dbCtx.checkpointAndClose();
    }
  });

  it('ignoriert rotierte/widerrufene Alt-Sessions im Sync-Status und erlaubt das Entfernen von Geräten via DELETE /api/sync/devices/:deviceId', async () => {
    let nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(nowMs),
      logger: false,
    });

    try {
      // Ohne Auth -> 401
      const unauthDel = await app.inject({
        method: 'DELETE',
        url: '/api/sync/devices/any-device',
      });
      expect(unauthDel.statusCode).toBe(401);

      // Web-User registrieren
      const regWeb = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'cleanupuser',
          password: 'Password123!',
          clientType: 'web',
          deviceName: 'Firefox auf Windows',
        },
      });
      expect(regWeb.statusCode).toBe(201);
      const webToken = regWeb.json().accessToken as string;

      // Altes Handy (v0.1.0) loggt ein und rotiert sein Refresh-Token
      nowMs += 1000;
      const oldDeviceId = 'old-phone-v010';
      const loginOld = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'cleanupuser',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: oldDeviceId,
          deviceName: 'Bibliolisa Android',
        },
      });
      expect(loginOld.statusCode).toBe(200);
      const oldRefresh1 = loginOld.json().refreshToken as string;

      nowMs += 1000;
      const refreshOld = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: {
          refreshToken: oldRefresh1,
          clientType: 'mobile',
        },
      });
      expect(refreshOld.statusCode).toBe(200);

      // Während aktiver Rotation darf die alte (ersetzte) Refresh-Zeile keinen zweiten Eintrag erzeugen
      const statusWithRotated = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusWithRotated.statusCode).toBe(200);
      expect(statusWithRotated.json().devices).toHaveLength(1);
      expect(statusWithRotated.json().status).toBe('never_synced');

      // Alte Session über DELETE /api/auth/sessions/:id abmelden -> muss auch Vorgänger-Tokens bereinigen
      const sessionsBefore = await app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: { authorization: `Bearer ${webToken}` },
      });
      const oldSession = (
        sessionsBefore.json().sessions as Array<{
          id: string;
          deviceId: string | null;
        }>
      ).find((s) => s.deviceId === oldDeviceId);
      expect(oldSession).toBeDefined();

      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${oldSession!.id}`,
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(revokeRes.statusCode).toBe(204);

      const statusAfterRevoke = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusAfterRevoke.statusCode).toBe(200);
      expect(statusAfterRevoke.json().status).toBe('no_mobile_device');
      expect(statusAfterRevoke.json().devices).toEqual([]);

      // Jetzt: Zwei aktive Handy-Sessions (neues Gerät synct, altes ungesynctes Gerät blockiert Gesamtstatus)
      nowMs += 1000;
      const staleDeviceId = 'stale-reinstall-phone';
      const activeDeviceId = 'current-phone-v030';

      const loginStale = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'cleanupuser',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: staleDeviceId,
          deviceName: 'Bibliolisa Android',
        },
      });
      expect(loginStale.statusCode).toBe(200);

      nowMs += 1000;
      const loginActive = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'cleanupuser',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: activeDeviceId,
          deviceName: 'Bibliolisa Android',
        },
      });
      expect(loginActive.statusCode).toBe(200);
      const activeMobileToken = loginActive.json().accessToken as string;

      nowMs += 1000;
      const syncActive = await app.inject({
        method: 'POST',
        url: '/api/sync',
        headers: { authorization: `Bearer ${activeMobileToken}` },
        payload: {
          deviceId: activeDeviceId,
          deviceName: 'Bibliolisa Android',
          cursor: null,
          clientTime: new Date(nowMs).toISOString(),
        },
      });
      expect(syncActive.statusCode).toBe(200);

      const statusBlocked = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusBlocked.json().status).toBe('never_synced');
      expect(statusBlocked.json().devices).toHaveLength(2);

      // Verwaistes Gerät über DELETE /api/sync/devices/:deviceId entfernen -> Gesamtstatus wird sofort 'synced'
      const delStale = await app.inject({
        method: 'DELETE',
        url: `/api/sync/devices/${encodeURIComponent(staleDeviceId)}`,
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(delStale.statusCode).toBe(204);

      const statusNowSynced = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusNowSynced.json().status).toBe('synced');
      expect(statusNowSynced.json().devices).toHaveLength(1);
      expect(statusNowSynced.json().devices[0].deviceId).toBe(activeDeviceId);

      // Auch in /api/auth/sessions ist das verwaiste Gerät verschwunden
      const sessionsAfterDel = await app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(
        (
          sessionsAfterDel.json().sessions as Array<{ deviceId: string | null }>
        ).some((s) => s.deviceId === staleDeviceId)
      ).toBe(false);

      // Multi-User-Isolation: User B kann User As Gerät nicht löschen (404)
      nowMs += 1000;
      const regOther = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'other_cleanup_user',
          password: 'Password123!',
          clientType: 'web',
        },
      });
      const otherToken = regOther.json().accessToken as string;

      const crossUserDel = await app.inject({
        method: 'DELETE',
        url: `/api/sync/devices/${encodeURIComponent(activeDeviceId)}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(crossUserDel.statusCode).toBe(404);
      expect(crossUserDel.json().error.code).toBe('SYNC_DEVICE_NOT_FOUND');

      // Nicht existierendes Gerät -> 404
      const missingDel = await app.inject({
        method: 'DELETE',
        url: '/api/sync/devices/does-not-exist',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(missingDel.statusCode).toBe(404);

      // User A hat weiterhin sein aktives Gerät; abgemeldetes sync_devices-Gerät lässt sich danach ebenfalls löschen
      const sessionsStillThere = await app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: { authorization: `Bearer ${webToken}` },
      });
      const activeSession = (
        sessionsStillThere.json().sessions as Array<{
          id: string;
          deviceId: string | null;
        }>
      ).find((s) => s.deviceId === activeDeviceId);
      expect(activeSession).toBeDefined();

      await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${activeSession!.id}`,
        headers: { authorization: `Bearer ${webToken}` },
      });
      // Abgemeldetes sync_devices-Gerät bleibt zunächst als sessionActive: false sichtbar und kann per DELETE entfernt werden
      const statusLoggedOut = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusLoggedOut.json().status).toBe('no_mobile_device');
      expect(statusLoggedOut.json().devices).toHaveLength(1);
      expect(statusLoggedOut.json().devices[0].sessionActive).toBe(false);

      const delHistorical = await app.inject({
        method: 'DELETE',
        url: `/api/sync/devices/${encodeURIComponent(activeDeviceId)}`,
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(delHistorical.statusCode).toBe(204);

      const statusEmpty = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
        headers: { authorization: `Bearer ${webToken}` },
      });
      expect(statusEmpty.json().devices).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
