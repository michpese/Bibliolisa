import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuthUser,
  type Book,
  type SyncRequest,
  type SyncResponse,
  type UserBook,
} from '@bibliolisa/shared';
import {
  createLocalLibraryEntry,
  getLocalLibraryEntryById,
  listLocalLibraryEntries,
  updateLocalLibraryEntry,
} from '../src/db/library.repo';
import { runMigrations } from '../src/db/migrations';
import {
  adoptLocalDataForUser,
  countPendingChanges,
  getAppSessionState,
  setSyncStateValue,
} from '../src/db/sync-state.repo';
import type { SqlBindValue, SqlExecutor } from '../src/db/types';
import { SyncEngine, type CoverSyncAdapter } from '../src/sync/sync-engine';

function createMemorySqlExecutor(): { db: SqlExecutor; raw: Database.Database } {
  const raw = new Database(':memory:');
  const db: SqlExecutor = {
    async execAsync(sql: string) {
      raw.exec(sql);
    },
    async runAsync(sql: string, ...params: SqlBindValue[]) {
      const info = raw.prepare(sql).run(...params);
      return {
        changes: info.changes,
        lastInsertRowId: Number(info.lastInsertRowid),
      };
    },
    async getFirstAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T | null> {
      const row = raw.prepare(sql).get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: SqlBindValue[]): Promise<T[]> {
      return raw.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await task();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, raw };
}

function createNoopCoverAdapter(overrides: Partial<CoverSyncAdapter> = {}): CoverSyncAdapter {
  return {
    getCachedCoverUri: () => null,
    downloadCover: async ({ coverKey }) => `file:///app/covers/${coverKey}`,
    uploadCover: async ({ bookId }) => ({
      bookId,
      coverKey: 'aabbccddeeff001122334455.webp',
      coverSourceUrl: null,
      updatedAt: '2026-11-21T12:00:00.000Z',
    }),
    cleanupOrphans: async () => 0,
    ...overrides,
  };
}

function makeBookDto(overrides: Partial<Book> & { id: string }): Book {
  const ts = '2026-11-21T10:00:00.000Z';
  return {
    title: 'Server Buch',
    subtitle: null,
    authors: ['Server Autor'],
    seriesName: null,
    seriesNumber: null,
    isbn10: null,
    isbn13: null,
    pageCount: 250,
    publishedYear: 2024,
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

function makeUserBookDto(
  overrides: Partial<UserBook> & { id: string; userId: string; bookId: string }
): UserBook {
  const ts = '2026-11-21T10:00:00.000Z';
  return {
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

describe('Mobile SyncEngine (Unit & Contract)', () => {
  let raw: Database.Database;
  let db: SqlExecutor;
  let userId: string;
  const nextUuid = () => crypto.randomUUID();

  const authUser: AuthUser = {
    id: crypto.randomUUID(),
    username: 'syncer',
    displayName: 'Syncer',
    email: null,
    role: 'admin',
    createdAt: '2026-11-21T09:00:00.000Z',
  };

  beforeEach(async () => {
    const ctx = createMemorySqlExecutor();
    raw = ctx.raw;
    db = ctx.db;
    await runMigrations(db, nextUuid);
    await adoptLocalDataForUser(db, authUser);
    await setSyncStateValue(db, 'server_url', 'http://192.168.1.50:3000');
    userId = authUser.id;
  });

  afterEach(() => {
    raw.close();
  });

  it('bricht bei Health-Timeout sauber auf offline ab und bewahrt is_dirty = 1', async () => {
    const entry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: { title: 'Flugmodus-Buch', authors: ['Autor'], genres: [], metadataSource: 'manual' },
        status: 'reading',
      },
      { generateUuid: nextUuid }
    );

    let syncCalled = false;
    const engine = new SyncEngine({
      db,
      checkHealth: async (url) => ({
        ok: false,
        url,
        latencyMs: 1500,
        kind: 'timeout',
        message: 'Zeitüberschreitung nach 1500 ms',
      }),
      ensureAccessToken: async () => 'token',
      hasStoredTokens: async () => true,
      syncRequest: async () => {
        syncCalled = true;
        throw new Error('darf nicht aufgerufen werden');
      },
      coverAdapter: createNoopCoverAdapter(),
    });

    const snapshot = await engine.sync('manual');
    expect(syncCalled).toBe(false);
    expect(snapshot.status).toBe('offline');
    expect(snapshot.pendingCount).toBe(2); // book + user_book
    const loaded = await getLocalLibraryEntryById(db, userId, entry.id);
    expect(loaded?.isDirty).toBe(true);
  });

  it('setzt auth_required bei abgelaufener Session ohne Datenverlust und nutzt ensureAccessToken vor Sync', async () => {
    const entry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: { title: 'Wichtige Notizen', authors: ['Autorin'], genres: [], metadataSource: 'manual' },
        status: 'read',
        rating: 5,
        notes: 'Darf niemals verloren gehen',
      },
      { generateUuid: nextUuid }
    );

    let tokenRefreshed = false;
    const engineNoToken = new SyncEngine({
      db,
      checkHealth: async (url) => ({
        ok: true,
        url,
        latencyMs: 5,
        health: {
          status: 'ok',
          version: '0.1.0',
          serverTime: '2026-11-21T10:00:00.000Z',
          allowRegistration: true,
          providers: { openLibrary: true, googleBooks: true, hardcover: false },
        },
      }),
      ensureAccessToken: async () => {
        tokenRefreshed = true;
        const err = new Error('Anmeldung abgelaufen') as Error & { status: number };
        err.status = 401;
        throw err;
      },
      hasStoredTokens: async () => true,
      syncRequest: async () => {
        throw new Error('darf nicht aufgerufen werden');
      },
      coverAdapter: createNoopCoverAdapter(),
    });

    const snap = await engineNoToken.sync('startup');
    expect(tokenRefreshed).toBe(true);
    expect(snap.status).toBe('auth_required');
    expect(snap.isAuthenticated).toBe(false);
    expect(snap.pendingCount).toBe(2);

    const preserved = await getLocalLibraryEntryById(db, userId, entry.id);
    expect(preserved?.notes).toBe('Darf niemals verloren gehen');
    expect(preserved?.isDirty).toBe(true);
  });

  it('serialisiert über Single-Flight-Mutex, schützt laufende lokale Edits race-safe und stößt Follow-Up an', async () => {
    let clockMs = Date.parse('2026-11-21T10:00:00.000Z');
    const entry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: { title: 'Race-Test-Buch', authors: ['Autor'], genres: [], metadataSource: 'manual' },
        status: 'unread',
      },
      { generateUuid: nextUuid, now: () => new Date(clockMs) }
    );

    let activeRequests = 0;
    let maxActiveRequests = 0;
    const pushedNotes: Array<string | null> = [];
    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let firstRequestStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });

    const engine = new SyncEngine({
      db,
      now: () => new Date(clockMs),
      checkHealth: async (url) => ({
        ok: true,
        url,
        latencyMs: 3,
        health: {
          status: 'ok',
          version: '0.1.0',
          serverTime: new Date(clockMs).toISOString(),
          allowRegistration: true,
          providers: { openLibrary: true, googleBooks: true, hardcover: false },
        },
      }),
      ensureAccessToken: async () => 'valid-token',
      hasStoredTokens: async () => true,
      syncRequest: async (_url, payload): Promise<SyncResponse> => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        try {
          for (const ub of payload.changes.userBooks) {
            pushedNotes.push(ub.notes);
          }
          if (pushedNotes.length === 1) {
            firstRequestStarted();
            await firstRequestGate;
          }
          return {
            serverTime: new Date(clockMs).toISOString(),
            nextCursor: `cursor-${pushedNotes.length}`,
            hasMore: false,
            clockSkewMs: 0,
            clockSkewWarning: false,
            pushResults: {
              books: payload.changes.books.map((b) => ({ id: b.id, status: 'accepted' })),
              userBooks: payload.changes.userBooks.map((ub) => ({
                id: ub.id,
                status: 'accepted',
              })),
            },
            pull: { books: [], userBooks: [] },
          };
        } finally {
          activeRequests -= 1;
        }
      },
      coverAdapter: createNoopCoverAdapter(),
    });

    const p1 = engine.sync('manual');
    const p2 = engine.sync('local_write'); // Triggert Vormerkung für genau 1 Follow-Up
    await firstStartedPromise;

    // Während Request 1 im Flug ist, bearbeitet der Benutzer denselben Eintrag lokal
    clockMs += 5000;
    await updateLocalLibraryEntry(
      db,
      userId,
      entry.id,
      { status: 'reading', notes: 'Während Sync bearbeitet' },
      { now: () => new Date(clockMs) }
    );

    releaseFirstRequest();
    const [res1, res2] = await Promise.all([p1, p2]);

    expect(maxActiveRequests).toBe(1);
    expect(res1.status).toBe('synced');
    expect(res2.status).toBe('synced');
    expect(pushedNotes).toEqual([null, 'Während Sync bearbeitet']);
    expect(await countPendingChanges(db, userId)).toBe(0);
  });

  it('paginiert FK-sicher bei mehr als pageLimit Offline-Büchern und über Pull-hasMore', async () => {
    const clock = () => new Date('2026-11-21T10:00:00.000Z');
    for (let i = 1; i <= 5; i++) {
      await createLocalLibraryEntry(
        db,
        userId,
        {
          book: { title: `Batch-Buch ${i}`, authors: ['Autor'], genres: [], metadataSource: 'manual' },
          status: 'unread',
        },
        { generateUuid: nextUuid, now: clock }
      );
    }

    const pagesReceived: SyncRequest[] = [];
    const serverBookId = nextUuid();
    const serverUbId = nextUuid();

    const engine = new SyncEngine({
      db,
      pageLimit: 2,
      checkHealth: async (url) => ({
        ok: true,
        url,
        latencyMs: 2,
        health: {
          status: 'ok',
          version: '0.1.0',
          serverTime: '2026-11-21T10:00:00.000Z',
          allowRegistration: true,
          providers: { openLibrary: true, googleBooks: true, hardcover: false },
        },
      }),
      ensureAccessToken: async () => 'token',
      hasStoredTokens: async () => true,
      syncRequest: async (_url, payload): Promise<SyncResponse> => {
        pagesReceived.push(payload);
        // FK-Invariante prüfen: Jeder gepushte userBook muss sein Buch im selben Batch oder schon auf dem Server haben
        const bookIdsInBatch = new Set(payload.changes.books.map((b) => b.id));
        for (const ub of payload.changes.userBooks) {
          expect(bookIdsInBatch.has(ub.bookId)).toBe(true);
        }

        const pageIdx = pagesReceived.length;
        return {
          serverTime: '2026-11-21T10:01:00.000Z',
          nextCursor: `c-${pageIdx}`,
          hasMore: pageIdx < 3,
          clockSkewMs: 0,
          clockSkewWarning: false,
          pushResults: {
            books: payload.changes.books.map((b) => ({ id: b.id, status: 'accepted' })),
            userBooks: payload.changes.userBooks.map((ub) => ({
              id: ub.id,
              status: 'accepted',
            })),
          },
          pull:
            pageIdx === 3
              ? {
                  books: [makeBookDto({ id: serverBookId, title: 'Gepulltes Server-Buch' })],
                  userBooks: [makeUserBookDto({ id: serverUbId, userId, bookId: serverBookId })],
                }
              : { books: [], userBooks: [] },
        };
      },
      coverAdapter: createNoopCoverAdapter(),
    });

    const snap = await engine.sync('startup');
    expect(snap.status).toBe('synced');
    expect(pagesReceived).toHaveLength(3);
    expect(await countPendingChanges(db, userId)).toBe(0);
    const all = await listLocalLibraryEntries(db, userId);
    expect(all).toHaveLength(6);
    expect((await getAppSessionState(db)).lastSyncCursor).toBe('c-3');
  });

  it('konvergiert bei conflict_server_won und merged duplicate_active_user_book_merged ohne Unique-Fehler', async () => {
    const sharedBookId = nextUuid();
    const conflictEntry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          id: sharedBookId,
          title: 'Konflikt-Buch',
          authors: ['Autor'],
          genres: [],
          metadataSource: 'manual',
        },
        status: 'unread',
        notes: 'Veralteter Offline-Stand',
      },
      { generateUuid: nextUuid, now: () => new Date('2026-11-21T09:00:00.000Z') }
    );

    const dupBookId = nextUuid();
    const dupEntry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          id: dupBookId,
          title: 'Duplikat-Buch',
          authors: ['Autor'],
          genres: [],
          metadataSource: 'manual',
        },
        status: 'reading',
      },
      { generateUuid: nextUuid, now: () => new Date('2026-11-21T09:30:00.000Z') }
    );
    const canonicalUbId = nextUuid();

    const engine = new SyncEngine({
      db,
      checkHealth: async (url) => ({
        ok: true,
        url,
        latencyMs: 2,
        health: {
          status: 'ok',
          version: '0.1.0',
          serverTime: '2026-11-21T10:00:00.000Z',
          allowRegistration: true,
          providers: { openLibrary: true, googleBooks: true, hardcover: false },
        },
      }),
      ensureAccessToken: async () => 'token',
      hasStoredTokens: async () => true,
      syncRequest: async (): Promise<SyncResponse> => ({
        serverTime: '2026-11-21T10:00:00.000Z',
        nextCursor: 'cursor-merged',
        hasMore: false,
        clockSkewMs: 0,
        clockSkewWarning: false,
        pushResults: {
          books: [
            { id: sharedBookId, status: 'accepted' },
            { id: dupBookId, status: 'accepted' },
          ],
          userBooks: [
            {
              id: conflictEntry.id,
              status: 'conflict_server_won',
              reason: 'Server besitzt neueres updatedAt',
            },
            {
              id: dupEntry.id,
              status: 'rejected',
              reason: 'duplicate_active_user_book_merged',
            },
          ],
        },
        pull: {
          books: [
            makeBookDto({
              id: sharedBookId,
              title: 'Konflikt-Buch (Server)',
              updatedAt: '2026-11-21T09:50:00.000Z',
            }),
          ],
          userBooks: [
            makeUserBookDto({
              id: conflictEntry.id,
              userId,
              bookId: sharedBookId,
              status: 'read',
              rating: 5,
              notes: 'Autoritativer Server-Stand',
              updatedAt: '2026-11-21T09:50:00.000Z',
            }),
            makeUserBookDto({
              id: canonicalUbId,
              userId,
              bookId: dupBookId,
              status: 'read',
              rating: 4,
              notes: 'Kanonische ID vom Server',
              updatedAt: '2026-11-21T09:55:00.000Z',
            }),
          ],
        },
      }),
      coverAdapter: createNoopCoverAdapter(),
    });

    const snap = await engine.sync('manual');
    expect(snap.status).toBe('synced');
    expect(snap.lastSummary?.conflictsServerWon).toBe(1);
    expect(snap.lastSummary?.duplicatesMerged).toBe(1);
    expect(await countPendingChanges(db, userId)).toBe(0);

    const converged = await getLocalLibraryEntryById(db, userId, conflictEntry.id);
    expect(converged?.status).toBe('read');
    expect(converged?.rating).toBe(5);
    expect(converged?.notes).toBe('Autoritativer Server-Stand');
    expect(converged?.book.title).toBe('Konflikt-Buch (Server)');

    expect(await getLocalLibraryEntryById(db, userId, dupEntry.id)).toBeNull();
    const canonical = await getLocalLibraryEntryById(db, userId, canonicalUbId);
    expect(canonical?.notes).toBe('Kanonische ID vom Server');
  });

  it('überspringt local_write-Sync ohne WLAN und synchronisiert mit WLAN', async () => {
    await createLocalLibraryEntry(
      db,
      userId,
      {
        book: { title: 'WLAN-Guard-Buch', authors: ['Autor'], genres: [], metadataSource: 'manual' },
        status: 'unread',
      },
      { generateUuid: nextUuid }
    );

    let wifi = false;
    let healthCalls = 0;

    const engine = new SyncEngine({
      db,
      isWifiConnected: async () => wifi,
      checkHealth: async (url) => {
        healthCalls += 1;
        return {
          ok: true,
          url,
          latencyMs: 2,
          health: {
            status: 'ok',
            version: '0.1.0',
            serverTime: '2026-11-21T10:00:00.000Z',
            allowRegistration: true,
            providers: { openLibrary: true, googleBooks: true, hardcover: false },
          },
        };
      },
      ensureAccessToken: async () => 'token',
      hasStoredTokens: async () => true,
      syncRequest: async (_url, payload) => ({
        serverTime: '2026-11-21T10:00:00.000Z',
        nextCursor: 'c-wifi',
        hasMore: false,
        clockSkewMs: 0,
        clockSkewWarning: false,
        pushResults: {
          books: payload.changes.books.map((b) => ({ id: b.id, status: 'accepted' })),
          userBooks: payload.changes.userBooks.map((ub) => ({
            id: ub.id,
            status: 'accepted',
          })),
        },
        pull: { books: [], userBooks: [] },
      }),
      coverAdapter: createNoopCoverAdapter(),
    });

    const cellularSnap = await engine.sync('local_write');
    expect(cellularSnap.status).toBe('pending');
    expect(cellularSnap.pendingCount).toBe(2);
    expect(healthCalls).toBe(0);

    wifi = true;
    const wifiSnap = await engine.sync('local_write');
    expect(wifiSnap.status).toBe('synced');
    expect(healthCalls).toBe(1);
    expect(wifiSnap.pendingCount).toBe(0);
  });

  it('lädt offline gewählte Cover hoch, lädt fehlende Cover mit max. 3 Parallelität herunter und räumt Orphans auf', async () => {
    const uploadEntry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: { title: 'Foto-Cover-Buch', authors: ['Autor'], genres: [], metadataSource: 'manual' },
        status: 'unread',
      },
      {
        generateUuid: nextUuid,
        coverLocalUri: 'file:///app/covers/local-photo.jpg',
        coverPendingUpload: true,
      }
    );

    const serverBooks: Book[] = [];
    const serverUbs: UserBook[] = [];
    for (let i = 0; i < 7; i++) {
      const bId = nextUuid();
      const hex = String(i).repeat(24).slice(0, 24);
      serverBooks.push(makeBookDto({ id: bId, title: `Cover Buch ${i}`, coverKey: `${hex}.webp` }));
      serverUbs.push(makeUserBookDto({ id: nextUuid(), userId, bookId: bId }));
    }

    let currentDownloads = 0;
    let maxConcurrentDownloads = 0;
    let cleanedOrphansInput: string[] = [];
    const uploadedKey = '11223344556677889900aabb.webp';

    const engine = new SyncEngine({
      db,
      maxCoverConcurrency: 3,
      checkHealth: async (url) => ({
        ok: true,
        url,
        latencyMs: 2,
        health: {
          status: 'ok',
          version: '0.1.0',
          serverTime: '2026-11-21T10:00:00.000Z',
          allowRegistration: true,
          providers: { openLibrary: true, googleBooks: true, hardcover: false },
        },
      }),
      ensureAccessToken: async () => 'token-123',
      hasStoredTokens: async () => true,
      syncRequest: async (_url, payload): Promise<SyncResponse> => ({
        serverTime: '2026-11-21T10:00:00.000Z',
        nextCursor: 'c-covers',
        hasMore: false,
        clockSkewMs: 0,
        clockSkewWarning: false,
        pushResults: {
          books: payload.changes.books.map((b) => ({ id: b.id, status: 'accepted' })),
          userBooks: payload.changes.userBooks.map((ub) => ({
            id: ub.id,
            status: 'accepted',
          })),
        },
        pull: {
          books: serverBooks,
          userBooks: serverUbs,
        },
      }),
      coverAdapter: {
        getCachedCoverUri: () => null,
        uploadCover: async ({ bookId }) => {
          expect(bookId).toBe(uploadEntry.bookId);
          return {
            bookId,
            coverKey: uploadedKey,
            coverSourceUrl: null,
            updatedAt: '2026-11-21T10:05:00.000Z',
          };
        },
        downloadCover: async ({ coverKey, accessToken }) => {
          expect(accessToken).toBe('token-123');
          currentDownloads += 1;
          maxConcurrentDownloads = Math.max(maxConcurrentDownloads, currentDownloads);
          await new Promise((r) => setTimeout(r, 15));
          currentDownloads -= 1;
          return `file:///app/covers/${coverKey}`;
        },
        cleanupOrphans: async (activeUris) => {
          cleanedOrphansInput = [...activeUris];
          return 1;
        },
      },
    });

    const snap = await engine.sync('manual');
    expect(snap.status).toBe('synced');
    expect(snap.lastSummary?.coversUploaded).toBe(1);
    expect(snap.lastSummary?.coversDownloaded).toBe(8); // 1 hochgeladenes + 7 Server-Bücher
    expect(snap.lastSummary?.coversCleanedUp).toBe(1);
    expect(maxConcurrentDownloads).toBeGreaterThan(1);
    expect(maxConcurrentDownloads).toBeLessThanOrEqual(3);

    const updatedUploadEntry = await getLocalLibraryEntryById(db, userId, uploadEntry.id);
    expect(updatedUploadEntry?.book.coverKey).toBe(uploadedKey);
    expect(updatedUploadEntry?.coverPendingUpload).toBe(false);
    expect(updatedUploadEntry?.coverLocalUri).toBe(`file:///app/covers/${uploadedKey}`);
    expect(cleanedOrphansInput).toContain(`file:///app/covers/${uploadedKey}`);
    expect(cleanedOrphansInput).not.toContain('file:///app/covers/local-photo.jpg');
  });
});
