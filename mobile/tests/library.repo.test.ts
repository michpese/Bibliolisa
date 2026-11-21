import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateRecommendations, type AuthUser } from '@bibliolisa/shared';
import {
  createLocalLibraryEntry,
  findActiveLocalEntryByIsbn,
  getLocalLibraryEntryById,
  getLocalLibraryFacets,
  listAllActiveLocalEntries,
  listLocalLibraryEntries,
  restoreLocalLibraryEntry,
  softDeleteLocalLibraryEntry,
  updateLocalLibraryEntry,
} from '../src/db/library.repo';
import { runMigrations } from '../src/db/migrations';
import {
  adoptLocalDataForUser,
  countPendingChanges,
  getAppSessionState,
  resetLocalLibraryData,
} from '../src/db/sync-state.repo';
import type { SqlBindValue, SqlExecutor } from '../src/db/types';

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

describe('Mobile Offline SQLite Repository', () => {
  let raw: Database.Database;
  let db: SqlExecutor;
  let userId: string;

  const nextUuid = () => crypto.randomUUID();

  beforeEach(async () => {
    const ctx = createMemorySqlExecutor();
    raw = ctx.raw;
    db = ctx.db;
    await runMigrations(db, nextUuid);
    const session = await getAppSessionState(db);
    userId = session.userId;
  });

  afterEach(() => {
    raw.close();
  });

  it('initialisiert Schema und Standard-sync_state idempotent', async () => {
    const session = await getAppSessionState(db);
    expect(session.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.isLocalOnlyUser).toBe(true);
    expect(session.lastSyncStatus).toBe('offline');

    // Zweiter Migrationslauf darf bestehende IDs nicht überschreiben
    await runMigrations(db, nextUuid);
    const after = await getAppSessionState(db);
    expect(after.deviceId).toBe(session.deviceId);
    expect(after.userId).toBe(session.userId);
  });

  it('erstellt, aktualisiert, sucht, filtert und sortiert Reihen inklusive Dezimalbänden (1, 1.5, 2, 10) komplett offline', async () => {
    const clock = () => new Date('2026-11-21T10:00:00.000Z');

    const vol10 = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Sturmlicht 10',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 10,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: nextUuid, now: clock }
    );

    const vol2 = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Sturmlicht 2',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 2,
          isbn13: '9783453267176',
          genres: ['Fantasy', 'High Fantasy'],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      {
        generateUuid: nextUuid,
        now: clock,
        coverLocalUri: 'file:///covers/local-2.jpg',
        coverPendingUpload: true,
      }
    );

    const vol15 = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Edgedancer',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 1.5,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'unread',
        notes: 'Novelle zwischen Band 1 und 2',
      },
      { generateUuid: nextUuid, now: clock }
    );

    const vol1 = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Der Weg der Könige',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 1,
          genres: ['Fantasy', 'High Fantasy'],
          metadataSource: 'manual',
        },
        status: 'read',
        rating: 5,
      },
      { generateUuid: nextUuid, now: clock }
    );

    const standalone = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Der Hobbit',
          authors: ['J.R.R. Tolkien'],
          genres: ['Klassiker', 'Fantasy'],
          pageCount: 280,
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: nextUuid, now: clock }
    );

    expect(vol2.book.isbn10).toBe('3453267176');
    expect(vol2.coverLocalUri).toBe('file:///covers/local-2.jpg');
    expect(vol2.coverPendingUpload).toBe(true);
    expect(vol2.isDirty).toBe(true);

    // Buchreihen-Sortierung ASC: 1 -> 1.5 -> 2 -> 10 -> Einzelband ohne Reihe am Ende
    const sortedAsc = await listLocalLibraryEntries(db, userId, {
      sort: 'series',
      order: 'asc',
    });
    expect(sortedAsc.map((e) => e.id)).toEqual([
      vol1.id,
      vol15.id,
      vol2.id,
      vol10.id,
      standalone.id,
    ]);

    // Buchreihen-Sortierung DESC: Einzelband ohne Reihe bleibt am Ende
    const sortedDesc = await listLocalLibraryEntries(db, userId, {
      sort: 'series',
      order: 'desc',
    });
    expect(sortedDesc.map((e) => e.id)).toEqual([
      vol10.id,
      vol2.id,
      vol15.id,
      vol1.id,
      standalone.id,
    ]);

    // Suche über ISBN mit Bindestrichen und über Notizen
    const byIsbn = await listLocalLibraryEntries(db, userId, {
      q: '978-3-453-26717-6',
    });
    expect(byIsbn.map((e) => e.id)).toEqual([vol2.id]);

    const byNote = await listLocalLibraryEntries(db, userId, {
      q: 'Novelle',
    });
    expect(byNote.map((e) => e.id)).toEqual([vol15.id]);

    // Duplikat-Lookup per ISBN
    const foundIsbn = await findActiveLocalEntryByIsbn(
      db,
      userId,
      '9783453267176',
      null
    );
    expect(foundIsbn?.id).toBe(vol2.id);

    // Filter nach Genre + Status + Mindestbewertung
    const highFantasy = await listLocalLibraryEntries(db, userId, {
      genre: 'High Fantasy',
      minRating: 4,
    });
    expect(highFantasy.map((e) => e.id)).toEqual([vol1.id]);

    // Facetten prüfen
    const facets = await getLocalLibraryFacets(db, userId);
    expect(facets.total).toBe(5);
    expect(facets.statusCounts).toEqual({
      unread: 4,
      reading: 0,
      read: 1,
      abandoned: 0,
    });
    expect(facets.series[0]).toEqual({ value: 'Sturmlicht', count: 4 });

    // Offline-Update von Status, Bewertung & Buchmetadaten
    const updated = await updateLocalLibraryEntry(db, userId, vol15.id, {
      status: 'reading',
      rating: 4,
      notes: 'Aktualisiert im Flugmodus',
      book: { pageCount: 240 },
    });
    expect(updated.status).toBe('reading');
    expect(updated.rating).toBe(4);
    expect(updated.book.pageCount).toBe(240);
    expect(updated.isDirty).toBe(true);
  });

  it('führt Soft Delete nur auf user_books aus und erlaubt Wiederherstellung', async () => {
    const entry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Mistborn',
          authors: ['Brandon Sanderson'],
          genres: [],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: nextUuid }
    );

    const deleted = await softDeleteLocalLibraryEntry(db, userId, entry.id);
    expect(deleted.id).toBe(entry.id);
    expect(deleted.deletedAt).toBeTruthy();

    const active = await listLocalLibraryEntries(db, userId);
    expect(active).toHaveLength(0);

    // Physisch in SQLite weiterhin vorhanden, books.deleted_at bleibt NULL
    const ubRow = raw
      .prepare('SELECT deleted_at, is_dirty FROM user_books WHERE id = ?')
      .get(entry.id) as { deleted_at: string | null; is_dirty: number };
    const bRow = raw
      .prepare('SELECT deleted_at FROM books WHERE id = ?')
      .get(entry.bookId) as { deleted_at: string | null };
    expect(ubRow.deleted_at).toBe(deleted.deletedAt);
    expect(ubRow.is_dirty).toBe(1);
    expect(bRow.deleted_at).toBeNull();

    const restored = await restoreLocalLibraryEntry(db, userId, entry.id);
    expect(restored.deletedAt).toBeNull();
    expect((await listLocalLibraryEntries(db, userId)).map((e) => e.id)).toEqual([
      entry.id,
    ]);
  });

  it('berechnet Empfehlungen direkt offline aus SQLite über @bibliolisa/shared', async () => {
    await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Mistborn 1',
          authors: ['Brandon Sanderson'],
          seriesName: 'Mistborn',
          seriesNumber: 1,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'read',
        rating: 5,
      },
      { generateUuid: nextUuid }
    );

    const nextVol = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Mistborn 1.5',
          authors: ['Brandon Sanderson'],
          seriesName: 'Mistborn',
          seriesNumber: 1.5,
          genres: ['Fantasy'],
          pageCount: 190,
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: nextUuid }
    );

    const entries = await listAllActiveLocalEntries(db, userId);
    const recommendations = generateRecommendations(entries, {
      limitPerCategory: 5,
      includeEntry: true,
    });

    expect(recommendations.categories.continue_series[0]?.userBookId).toBe(
      nextVol.id
    );
    expect(recommendations.categories.continue_series[0]?.reasonText).toContain(
      '#1.5'
    );
    expect(recommendations.categories.quick_read[0]?.userBookId).toBe(
      nextVol.id
    );
  });

  it('trennt Mandanten strikt, übernimmt lokale Daten beim ersten Login und leert DB beim Reset', async () => {
    const entry = await createLocalLibraryEntry(
      db,
      userId,
      {
        book: {
          title: 'Offline-Buch',
          authors: ['Autorin'],
          genres: [],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: nextUuid }
    );

    // Fremder Benutzer sieht den Eintrag nicht
    const otherUserId = nextUuid();
    expect(await listLocalLibraryEntries(db, otherUserId)).toHaveLength(0);
    expect(await getLocalLibraryEntryById(db, otherUserId, entry.id)).toBeNull();

    // Erster Login übernimmt lokale Offline-Bücher für das Konto
    const authUser: AuthUser = {
      id: nextUuid(),
      username: 'lisa',
      displayName: 'Lisa',
      email: null,
      role: 'admin',
      createdAt: '2026-11-21T10:00:00.000Z',
    };
    await adoptLocalDataForUser(db, authUser);

    const afterAdopt = await getAppSessionState(db);
    expect(afterAdopt.userId).toBe(authUser.id);
    expect(afterAdopt.isLocalOnlyUser).toBe(false);
    expect(await listLocalLibraryEntries(db, authUser.id)).toHaveLength(1);
    expect(await countPendingChanges(db, authUser.id)).toBe(2);

    // Logout / Instanzwechsel leert lokale Daten vollständig
    await resetLocalLibraryData(db, { keepServerUrl: false }, nextUuid);
    const afterReset = await getAppSessionState(db);
    expect(afterReset.isLocalOnlyUser).toBe(true);
    expect(afterReset.userId).not.toBe(authUser.id);
    expect(await listLocalLibraryEntries(db, authUser.id)).toHaveLength(0);
    expect(
      (raw.prepare('SELECT COUNT(*) AS cnt FROM books').get() as { cnt: number })
        .cnt
    ).toBe(0);
  });
});
