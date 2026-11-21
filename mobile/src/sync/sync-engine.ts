import {
  IsoUtcTimestampSchema,
  toCanonicalIsoUtc,
  type BookCoverResponse,
  type MetadataSource,
  type ReadingStatus,
  type SyncBookPayload,
  type SyncRequest,
  type SyncResponse,
  type SyncUserBookPush,
  type UserBook,
} from '@bibliolisa/shared';
import {
  countPendingChanges,
  getAppSessionState,
  setSyncStateValue,
} from '../db/sync-state.repo';
import type { SqlExecutor } from '../db/types';
import { checkServerHealth } from './health-check';

export type SyncStatus =
  | 'synced'
  | 'syncing'
  | 'pending'
  | 'offline'
  | 'auth_required'
  | 'error';

export type SyncTrigger =
  | 'startup'
  | 'foreground'
  | 'pull_to_refresh'
  | 'local_write'
  | 'manual'
  | 'reconnect';

export interface SyncRunSummary {
  pushedBooks: number;
  pushedUserBooks: number;
  pulledBooks: number;
  pulledUserBooks: number;
  conflictsServerWon: number;
  duplicatesMerged: number;
  coversUploaded: number;
  coversDownloaded: number;
  coversCleanedUp: number;
  completedAt: string;
}

export interface SyncStateSnapshot {
  status: SyncStatus;
  pendingCount: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  clockSkewWarning: boolean;
  clockSkewMs: number | null;
  isSyncing: boolean;
  isConfigured: boolean;
  isAuthenticated: boolean;
  lastSummary: SyncRunSummary | null;
}

export interface CoverSyncAdapter {
  getCachedCoverUri(coverKey: string): Promise<string | null> | string | null;
  downloadCover(params: {
    serverUrl: string;
    coverKey: string;
    accessToken: string;
  }): Promise<string>;
  uploadCover(params: {
    serverUrl: string;
    bookId: string;
    localUri: string;
  }): Promise<BookCoverResponse>;
  fetchRemoteCoverOnServer?(params: {
    serverUrl: string;
    bookId: string;
    url: string;
  }): Promise<BookCoverResponse>;
  cleanupOrphans(activeUris: ReadonlySet<string>): Promise<number>;
}

export interface SyncEngineDeps {
  db: SqlExecutor;
  checkHealth?: typeof checkServerHealth;
  ensureAccessToken: (serverUrl: string) => Promise<string>;
  hasStoredTokens: () => Promise<boolean>;
  syncRequest: (serverUrl: string, payload: SyncRequest) => Promise<SyncResponse>;
  coverAdapter: CoverSyncAdapter;
  isWifiConnected?: () => Promise<boolean>;
  isAuthError?: (error: unknown) => boolean;
  isNetworkError?: (error: unknown) => boolean;
  now?: () => Date;
  healthTimeoutMs?: number;
  pageLimit?: number;
  maxCoverConcurrency?: number;
  maxPagesPerRun?: number;
  onDataChanged?: () => void | Promise<void>;
  onStateChange?: (snapshot: SyncStateSnapshot) => void;
}

interface LocalBookSyncRow {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string;
  series_name: string | null;
  series_number: number | null;
  isbn_10: string | null;
  isbn_13: string | null;
  page_count: number | null;
  published_year: number | null;
  genres: string;
  description: string | null;
  cover_key: string | null;
  cover_source_url: string | null;
  cover_local_uri: string | null;
  cover_pending_upload: number;
  language: string | null;
  publisher: string | null;
  metadata_source: MetadataSource;
  metadata_external_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_dirty: number;
  dirty_updated_at: string | null;
}

interface LocalUserBookSyncRow {
  id: string;
  user_id: string;
  book_id: string;
  status: ReadingStatus;
  rating: number | null;
  notes: string | null;
  added_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_dirty: number;
  dirty_updated_at: string | null;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_COVER_CONCURRENCY = 3;
const DEFAULT_MAX_PAGES_PER_RUN = 200;
const MAX_FOLLOW_UP_RUNS = 3;
const AUTH_EXPIRED_MESSAGE = 'Anmeldung abgelaufen – Bitte neu anmelden';

const TRIGGER_PRIORITY: Record<SyncTrigger, number> = {
  local_write: 1,
  startup: 2,
  foreground: 3,
  reconnect: 4,
  pull_to_refresh: 5,
  manual: 6,
};

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeTimestampOrFallback(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const parsed = IsoUtcTimestampSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

function mapLocalBookRowToPayload(row: LocalBookSyncRow): SyncBookPayload {
  const createdAt = toCanonicalIsoUtc(row.created_at);
  const updatedAt = toCanonicalIsoUtc(row.updated_at);
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    authors: parseStringArray(row.authors),
    seriesName: row.series_name,
    seriesNumber: row.series_number,
    isbn10: row.isbn_10,
    isbn13: row.isbn_13,
    pageCount: row.page_count,
    publishedYear: row.published_year,
    genres: parseStringArray(row.genres),
    description: row.description,
    coverKey: row.cover_key,
    coverSourceUrl: row.cover_source_url,
    language: row.language,
    publisher: row.publisher,
    metadataSource: row.metadata_source,
    metadataExternalId: row.metadata_external_id,
    createdAt,
    updatedAt,
    deletedAt: row.deleted_at ? toCanonicalIsoUtc(row.deleted_at) : null,
  };
}

function mapLocalUserBookRowToPayload(row: LocalUserBookSyncRow): SyncUserBookPush {
  return {
    id: row.id,
    bookId: row.book_id,
    status: row.status,
    rating: row.rating,
    notes: row.notes,
    addedAt: toCanonicalIsoUtc(row.added_at),
    startedAt: row.started_at ? toCanonicalIsoUtc(row.started_at) : null,
    finishedAt: row.finished_at ? toCanonicalIsoUtc(row.finished_at) : null,
    createdAt: toCanonicalIsoUtc(row.created_at),
    updatedAt: toCanonicalIsoUtc(row.updated_at),
    deletedAt: row.deleted_at ? toCanonicalIsoUtc(row.deleted_at) : null,
  };
}

function defaultIsAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { status?: unknown; code?: unknown; message?: unknown };
  if (err.status === 401) return true;
  if (err.code === 'AUTH_REQUIRED' || err.code === 'SESSION_EXPIRED') return true;
  if (typeof err.message === 'string' && /\b401\b/.test(err.message)) return true;
  return false;
}

function defaultIsNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { status?: unknown; code?: unknown; name?: unknown };
  if (err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR') return true;
  if (err.status === 0 && err.code !== 'INVALID_SERVER_URL') return true;
  if (err.name === 'AbortError' || err.name === 'TypeError') return true;
  return false;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error || 'Unbekannter Sync-Fehler');
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) {
          await worker(item);
        }
      }
    })
  );
}

/**
 * Offline-First Delta-Sync-Engine für Android/SQLite.
 * Enthält bewusst keine direkten UI- oder Expo-Native-Imports und ist damit vollständig in Vitest prüfbar.
 */
export class SyncEngine {
  private readonly deps: SyncEngineDeps;
  private readonly checkHealthFn: typeof checkServerHealth;
  private readonly isAuthErrorFn: (error: unknown) => boolean;
  private readonly isNetworkErrorFn: (error: unknown) => boolean;
  private readonly nowFn: () => Date;
  private readonly healthTimeoutMs: number;
  private readonly pageLimit: number;
  private readonly maxCoverConcurrency: number;
  private readonly maxPagesPerRun: number;

  private activeSyncing = false;
  private inFlight: Promise<SyncStateSnapshot> | null = null;
  private followUpRequested = false;
  private followUpTrigger: SyncTrigger | null = null;

  private lastSnapshot: SyncStateSnapshot = {
    status: 'offline',
    pendingCount: 0,
    lastSyncAt: null,
    lastSyncError: null,
    clockSkewWarning: false,
    clockSkewMs: null,
    isSyncing: false,
    isConfigured: false,
    isAuthenticated: false,
    lastSummary: null,
  };

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
    this.checkHealthFn = deps.checkHealth ?? checkServerHealth;
    this.isAuthErrorFn = deps.isAuthError ?? defaultIsAuthError;
    this.isNetworkErrorFn = deps.isNetworkError ?? defaultIsNetworkError;
    this.nowFn = deps.now ?? (() => new Date());
    this.healthTimeoutMs = deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.pageLimit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.maxCoverConcurrency = deps.maxCoverConcurrency ?? DEFAULT_COVER_CONCURRENCY;
    this.maxPagesPerRun = deps.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;
  }

  getSnapshot(): SyncStateSnapshot {
    return { ...this.lastSnapshot };
  }

  private emitSnapshot(partial: Partial<SyncStateSnapshot>): SyncStateSnapshot {
    this.lastSnapshot = {
      ...this.lastSnapshot,
      ...partial,
    };
    this.deps.onStateChange?.(this.getSnapshot());
    return this.getSnapshot();
  }

  async refreshStatus(): Promise<SyncStateSnapshot> {
    const [session, hasTokens] = await Promise.all([
      getAppSessionState(this.deps.db),
      this.deps.hasStoredTokens(),
    ]);
    const pendingCount = await countPendingChanges(this.deps.db, session.userId);
    const isConfigured = Boolean(session.serverUrl);
    const isAuthenticated = isConfigured && !session.isLocalOnlyUser && hasTokens;

    let status: SyncStatus;
    if (!isConfigured || session.isLocalOnlyUser) {
      status = 'offline';
    } else if (!hasTokens) {
      status = 'auth_required';
    } else if (this.activeSyncing) {
      status = 'syncing';
    } else if (session.lastSyncStatus === 'error') {
      status = 'error';
    } else if (pendingCount > 0) {
      status = session.lastSyncStatus === 'offline' ? 'offline' : 'pending';
    } else if (session.lastSyncStatus === 'offline') {
      status = 'offline';
    } else if (session.lastSyncAt) {
      status = 'synced';
    } else {
      status = 'offline';
    }

    return this.emitSnapshot({
      status,
      pendingCount,
      lastSyncAt: session.lastSyncAt,
      lastSyncError:
        status === 'auth_required'
          ? session.lastSyncError ?? AUTH_EXPIRED_MESSAGE
          : session.lastSyncError,
      isSyncing: this.activeSyncing,
      isConfigured,
      isAuthenticated,
    });
  }

  /**
   * Startet einen Single-Flight-Sync-Zyklus. Trifft während eines aktiven Laufs ein weiterer Trigger ein,
   * wird genau ein Folge-Lauf vorgemerkt.
   */
  sync(trigger: SyncTrigger): Promise<SyncStateSnapshot> {
    if (this.inFlight) {
      this.followUpRequested = true;
      if (
        !this.followUpTrigger ||
        TRIGGER_PRIORITY[trigger] > TRIGGER_PRIORITY[this.followUpTrigger]
      ) {
        this.followUpTrigger = trigger;
      }
      return this.inFlight;
    }

    const runner = this.runWithFollowUps(trigger).finally(() => {
      this.inFlight = null;
      this.followUpRequested = false;
      this.followUpTrigger = null;
    });

    this.inFlight = runner;
    return runner;
  }

  private async runWithFollowUps(initialTrigger: SyncTrigger): Promise<SyncStateSnapshot> {
    let currentTrigger = initialTrigger;
    let snapshot = await this.executeSingleSync(currentTrigger);

    for (let followUpCount = 0; followUpCount < MAX_FOLLOW_UP_RUNS; followUpCount += 1) {
      if (!this.followUpRequested) {
        break;
      }

      const nextTrigger = this.followUpTrigger ?? 'local_write';
      this.followUpRequested = false;
      this.followUpTrigger = null;

      const isExplicitRetry =
        nextTrigger === 'manual' || nextTrigger === 'pull_to_refresh';
      if (
        !isExplicitRetry &&
        (snapshot.status === 'offline' ||
          snapshot.status === 'auth_required' ||
          snapshot.status === 'error')
      ) {
        break;
      }

      currentTrigger = nextTrigger;
      snapshot = await this.executeSingleSync(currentTrigger);
    }

    return snapshot;
  }

  private async persistSyncOutcome(
    status: SyncStatus,
    errorMsg: string | null,
    lastSyncAt?: string
  ): Promise<void> {
    await setSyncStateValue(this.deps.db, 'last_sync_status', status);
    await setSyncStateValue(this.deps.db, 'last_sync_error', errorMsg);
    if (lastSyncAt !== undefined) {
      await setSyncStateValue(this.deps.db, 'last_sync_at', lastSyncAt);
    }
  }

  private async executeSingleSync(trigger: SyncTrigger): Promise<SyncStateSnapshot> {
    const db = this.deps.db;
    const session = await getAppSessionState(db);
    const pendingBefore = await countPendingChanges(db, session.userId);
    const isConfigured = Boolean(session.serverUrl);

    if (!session.serverUrl || session.isLocalOnlyUser) {
      return this.emitSnapshot({
        status: 'offline',
        pendingCount: pendingBefore,
        lastSyncAt: session.lastSyncAt,
        lastSyncError: null,
        isSyncing: false,
        isConfigured,
        isAuthenticated: false,
      });
    }

    const hasTokens = await this.deps.hasStoredTokens();
    if (!hasTokens) {
      await this.persistSyncOutcome('auth_required', AUTH_EXPIRED_MESSAGE);
      return this.emitSnapshot({
        status: 'auth_required',
        pendingCount: pendingBefore,
        lastSyncAt: session.lastSyncAt,
        lastSyncError: AUTH_EXPIRED_MESSAGE,
        isSyncing: false,
        isConfigured: true,
        isAuthenticated: false,
      });
    }

    if (trigger === 'local_write' && this.deps.isWifiConnected) {
      const wifiConnected = await this.deps.isWifiConnected();
      if (!wifiConnected) {
        const nextStatus: SyncStatus = pendingBefore > 0 ? 'pending' : 'offline';
        await this.persistSyncOutcome(nextStatus, null);
        return this.emitSnapshot({
          status: nextStatus,
          pendingCount: pendingBefore,
          lastSyncAt: session.lastSyncAt,
          lastSyncError: null,
          isSyncing: false,
          isConfigured: true,
          isAuthenticated: true,
        });
      }
    }

    const serverUrl = session.serverUrl;
    let dbMutated = false;

    const summary: Omit<SyncRunSummary, 'completedAt'> = {
      pushedBooks: 0,
      pushedUserBooks: 0,
      pulledBooks: 0,
      pulledUserBooks: 0,
      conflictsServerWon: 0,
      duplicatesMerged: 0,
      coversUploaded: 0,
      coversDownloaded: 0,
      coversCleanedUp: 0,
    };

    let clockSkewWarning = false;
    let clockSkewMs: number | null = null;

    this.activeSyncing = true;
    this.emitSnapshot({
      status: 'syncing',
      pendingCount: pendingBefore,
      lastSyncAt: session.lastSyncAt,
      lastSyncError: null,
      isSyncing: true,
      isConfigured: true,
      isAuthenticated: true,
    });

    try {
      // 1. Pre-Flight-Check gegen GET /api/health (standardmäßig 1500 ms Timeout)
      const health = await this.checkHealthFn(serverUrl, this.healthTimeoutMs);
      if (!health.ok) {
        if (health.kind === 'timeout' || health.kind === 'network_error') {
          await this.persistSyncOutcome('offline', null);
          return this.emitSnapshot({
            status: 'offline',
            pendingCount: pendingBefore,
            lastSyncAt: session.lastSyncAt,
            lastSyncError: null,
            isSyncing: false,
            isConfigured: true,
            isAuthenticated: true,
          });
        }

        await this.persistSyncOutcome('error', health.message);
        return this.emitSnapshot({
          status: 'error',
          pendingCount: pendingBefore,
          lastSyncAt: session.lastSyncAt,
          lastSyncError: health.message,
          isSyncing: false,
          isConfigured: true,
          isAuthenticated: true,
        });
      }

      // 2. Transparenter Token-Refresh vor dem Sync-Start (< 60 s Restlaufzeit)
      let accessToken = await this.deps.ensureAccessToken(serverUrl);

      // 3. Delta-Push/-Pull Pagination-Loop
      let cursor = session.lastSyncCursor;
      let hasMore = true;
      let pages = 0;

      const attemptedBookStamps = new Map<string, string | null>();
      const attemptedUserBookStamps = new Map<string, string | null>();

      while (pages < this.pageLimitGuard()) {
        const allDirtyBooks = await db.getAllAsync<LocalBookSyncRow>(
          `SELECT * FROM books
           WHERE is_dirty = 1
             AND (
               created_by_user_id = ?
               OR EXISTS (
                 SELECT 1 FROM user_books ub WHERE ub.book_id = books.id AND ub.user_id = ?
               )
             )
           ORDER BY updated_at ASC, id ASC`,
          session.userId,
          session.userId
        );

        const dirtyBookIdsInDb = new Set(allDirtyBooks.map((row) => row.id));
        const unattemptedBooks = allDirtyBooks.filter(
          (row) =>
            !(
              attemptedBookStamps.has(row.id) &&
              attemptedBookStamps.get(row.id) === row.dirty_updated_at
            )
        );
        const booksBatch = unattemptedBooks.slice(0, this.pageLimit);
        const booksBatchIds = new Set(booksBatch.map((row) => row.id));

        const allDirtyUserBooks = await db.getAllAsync<LocalUserBookSyncRow>(
          `SELECT * FROM user_books
           WHERE user_id = ? AND is_dirty = 1
           ORDER BY updated_at ASC, id ASC`,
          session.userId
        );

        const eligibleUserBooks = allDirtyUserBooks.filter(
          (row) =>
            !(
              attemptedUserBookStamps.has(row.id) &&
              attemptedUserBookStamps.get(row.id) === row.dirty_updated_at
            ) &&
            (!dirtyBookIdsInDb.has(row.book_id) || booksBatchIds.has(row.book_id))
        );
        const userBooksBatch = eligibleUserBooks.slice(0, this.pageLimit);

        if (
          pages > 0 &&
          !hasMore &&
          booksBatch.length === 0 &&
          userBooksBatch.length === 0
        ) {
          break;
        }

        const pushedBookStamps = new Map<string, string | null>();
        for (const row of booksBatch) {
          pushedBookStamps.set(row.id, row.dirty_updated_at);
          attemptedBookStamps.set(row.id, row.dirty_updated_at);
        }

        const pushedUserBookStamps = new Map<string, string | null>();
        for (const row of userBooksBatch) {
          pushedUserBookStamps.set(row.id, row.dirty_updated_at);
          attemptedUserBookStamps.set(row.id, row.dirty_updated_at);
        }

        const payload: SyncRequest = {
          deviceId: session.deviceId,
          cursor,
          clientTime: toCanonicalIsoUtc(this.nowFn()),
          limit: this.pageLimit,
          changes: {
            books: booksBatch.map(mapLocalBookRowToPayload),
            userBooks: userBooksBatch.map(mapLocalUserBookRowToPayload),
          },
        };

        const response = await this.deps.syncRequest(serverUrl, payload);
        pages += 1;

        summary.pushedBooks += booksBatch.length;
        summary.pushedUserBooks += userBooksBatch.length;
        summary.pulledBooks += response.pull.books.length;
        summary.pulledUserBooks += response.pull.userBooks.length;
        clockSkewMs = response.clockSkewMs;
        clockSkewWarning = clockSkewWarning || response.clockSkewWarning;

        const applied = await this.applySyncPage({
          userId: session.userId,
          response,
          pushedBookStamps,
          pushedUserBookStamps,
        });

        summary.conflictsServerWon += applied.conflictsServerWon;
        summary.duplicatesMerged += applied.duplicatesMerged;
        if (applied.mutated) {
          dbMutated = true;
        }

        cursor = response.nextCursor;
        hasMore = response.hasMore;

        if (!hasMore) {
          const remainingBooks = await db.getAllAsync<{
            id: string;
            dirty_updated_at: string | null;
          }>(
            `SELECT id, dirty_updated_at FROM books
             WHERE is_dirty = 1
               AND (
                 created_by_user_id = ?
                 OR EXISTS (
                   SELECT 1 FROM user_books ub WHERE ub.book_id = books.id AND ub.user_id = ?
                 )
               )`,
            session.userId,
            session.userId
          );
          const hasMoreBooks = remainingBooks.some(
            (row) =>
              !(
                attemptedBookStamps.has(row.id) &&
                attemptedBookStamps.get(row.id) === row.dirty_updated_at
              )
          );

          const remainingUserBooks = await db.getAllAsync<{
            id: string;
            book_id: string;
            dirty_updated_at: string | null;
          }>(
            `SELECT id, book_id, dirty_updated_at FROM user_books
             WHERE user_id = ? AND is_dirty = 1`,
            session.userId
          );
          const remainingDirtyBookIds = new Set(remainingBooks.map((b) => b.id));
          const hasMoreUserBooks = remainingUserBooks.some(
            (row) =>
              !(
                attemptedUserBookStamps.has(row.id) &&
                attemptedUserBookStamps.get(row.id) === row.dirty_updated_at
              ) && !remainingDirtyBookIds.has(row.book_id)
          );

          if (!hasMoreBooks && !hasMoreUserBooks) {
            break;
          }
        }
      }

      // 4. Cover-Synchronisation (Uploads -> optionale Remote-Fetches -> parallele Downloads -> Cleanup)
      let coverNetworkOffline = false;

      // 4a. Offline ausgewählte/fotografierte Cover hochladen
      const pendingUploads = await db.getAllAsync<{
        id: string;
        cover_local_uri: string;
      }>(
        `SELECT b.id, b.cover_local_uri
         FROM books b
         WHERE b.cover_pending_upload = 1
           AND b.cover_local_uri IS NOT NULL
           AND b.deleted_at IS NULL
           AND b.is_dirty = 0
           AND EXISTS (
             SELECT 1 FROM user_books ub
             WHERE ub.book_id = b.id AND ub.user_id = ? AND ub.deleted_at IS NULL
           )`,
        session.userId
      );

      for (const item of pendingUploads) {
        try {
          const uploaded = await this.deps.coverAdapter.uploadCover({
            serverUrl,
            bookId: item.id,
            localUri: item.cover_local_uri,
          });
          await db.runAsync(
            `UPDATE books
             SET cover_key = ?,
                 cover_pending_upload = 0,
                 updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
             WHERE id = ? AND cover_local_uri = ?`,
            uploaded.coverKey,
            uploaded.updatedAt,
            uploaded.updatedAt,
            item.id,
            item.cover_local_uri
          );
          summary.coversUploaded += 1;
          dbMutated = true;
        } catch (error) {
          if (this.isAuthErrorFn(error)) {
            throw error;
          }
          if (this.isNetworkErrorFn(error)) {
            coverNetworkOffline = true;
            break;
          }
          // Einzelner Upload-Fehler (z. B. gelöschte lokale Temp-Datei) blockiert nicht den übrigen Sync
        }
      }

      // 4b. Optional: Externe Cover-URLs serverseitig cachen lassen (Best-Effort)
      if (!coverNetworkOffline && this.deps.coverAdapter.fetchRemoteCoverOnServer) {
        const fetchCandidates = await db.getAllAsync<{
          id: string;
          cover_source_url: string;
        }>(
          `SELECT b.id, b.cover_source_url
           FROM books b
           WHERE b.cover_key IS NULL
             AND b.cover_source_url IS NOT NULL
             AND b.cover_pending_upload = 0
             AND b.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM user_books ub
               WHERE ub.book_id = b.id AND ub.user_id = ? AND ub.deleted_at IS NULL
             )`,
          session.userId
        );

        await runWithConcurrency(
          fetchCandidates,
          this.maxCoverConcurrency,
          async (item) => {
            if (coverNetworkOffline) return;
            try {
              const fetched = await this.deps.coverAdapter.fetchRemoteCoverOnServer!({
                serverUrl,
                bookId: item.id,
                url: item.cover_source_url,
              });
              await db.runAsync(
                `UPDATE books
                 SET cover_key = ?,
                     updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
                 WHERE id = ? AND cover_key IS NULL AND cover_pending_upload = 0`,
                fetched.coverKey,
                fetched.updatedAt,
                fetched.updatedAt,
                item.id
              );
              dbMutated = true;
            } catch (error) {
              if (this.isAuthErrorFn(error)) {
                throw error;
              }
              if (this.isNetworkErrorFn(error)) {
                coverNetworkOffline = true;
              }
            }
          }
        );
      }

      // 4c. Fehlende WebP-Cover mit maximal 3 parallelen Requests herunterladen
      if (!coverNetworkOffline) {
        const booksNeedingCover = await db.getAllAsync<{
          id: string;
          cover_key: string;
          cover_local_uri: string | null;
        }>(
          `SELECT b.id, b.cover_key, b.cover_local_uri
           FROM books b
           WHERE b.cover_key IS NOT NULL
             AND b.cover_pending_upload = 0
             AND b.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM user_books ub
               WHERE ub.book_id = b.id AND ub.user_id = ? AND ub.deleted_at IS NULL
             )`,
          session.userId
        );

        const rowsByKey = new Map<
          string,
          Array<{ id: string; cover_local_uri: string | null }>
        >();
        for (const row of booksNeedingCover) {
          const list = rowsByKey.get(row.cover_key);
          if (list) {
            list.push({ id: row.id, cover_local_uri: row.cover_local_uri });
          } else {
            rowsByKey.set(row.cover_key, [
              { id: row.id, cover_local_uri: row.cover_local_uri },
            ]);
          }
        }

        const missingKeys: string[] = [];
        for (const [coverKey, refs] of rowsByKey) {
          const cachedUri = await this.deps.coverAdapter.getCachedCoverUri(coverKey);
          if (cachedUri) {
            if (refs.some((r) => r.cover_local_uri !== cachedUri)) {
              await db.runAsync(
                `UPDATE books SET cover_local_uri = ?
                 WHERE cover_key = ? AND cover_pending_upload = 0`,
                cachedUri,
                coverKey
              );
              dbMutated = true;
            }
          } else {
            missingKeys.push(coverKey);
          }
        }

        if (missingKeys.length > 0) {
          accessToken = await this.deps.ensureAccessToken(serverUrl);
          await runWithConcurrency(
            missingKeys,
            this.maxCoverConcurrency,
            async (coverKey) => {
              if (coverNetworkOffline) return;
              try {
                const downloadedUri = await this.deps.coverAdapter.downloadCover({
                  serverUrl,
                  coverKey,
                  accessToken,
                });
                await db.runAsync(
                  `UPDATE books SET cover_local_uri = ?
                   WHERE cover_key = ? AND cover_pending_upload = 0`,
                  downloadedUri,
                  coverKey
                );
                summary.coversDownloaded += 1;
                dbMutated = true;
              } catch (error) {
                if (this.isAuthErrorFn(error)) {
                  throw error;
                }
                if (this.isNetworkErrorFn(error)) {
                  coverNetworkOffline = true;
                }
              }
            }
          );
        }
      }

      // 4d. Orphan-Cleanup nicht mehr referenzierter lokaler Cover (nur nach vollständigem Cover-Lauf)
      if (!coverNetworkOffline) {
        const activeCoverRows = await db.getAllAsync<{ cover_local_uri: string }>(
          `SELECT DISTINCT b.cover_local_uri
           FROM books b
           WHERE b.cover_local_uri IS NOT NULL
             AND b.deleted_at IS NULL
             AND (
               b.cover_pending_upload = 1
               OR EXISTS (
                 SELECT 1 FROM user_books ub
                 WHERE ub.book_id = b.id AND ub.deleted_at IS NULL
               )
             )`
        );
        const activeUris = new Set(activeCoverRows.map((row) => row.cover_local_uri));
        summary.coversCleanedUp = await this.deps.coverAdapter.cleanupOrphans(activeUris);
      }

      const pendingAfter = await countPendingChanges(db, session.userId);
      const completedAt = toCanonicalIsoUtc(this.nowFn());

      if (coverNetworkOffline) {
        await this.persistSyncOutcome('offline', null);
        this.activeSyncing = false;
        if (dbMutated) {
          await this.deps.onDataChanged?.();
        }
        return this.emitSnapshot({
          status: 'offline',
          pendingCount: pendingAfter,
          lastSyncAt: session.lastSyncAt,
          lastSyncError: null,
          clockSkewWarning,
          clockSkewMs,
          isSyncing: false,
          isConfigured: true,
          isAuthenticated: true,
          lastSummary: { ...summary, completedAt },
        });
      }

      const finalStatus: SyncStatus = pendingAfter > 0 ? 'pending' : 'synced';
      await this.persistSyncOutcome(finalStatus, null, completedAt);
      this.activeSyncing = false;

      if (dbMutated) {
        await this.deps.onDataChanged?.();
      }

      return this.emitSnapshot({
        status: finalStatus,
        pendingCount: pendingAfter,
        lastSyncAt: completedAt,
        lastSyncError: null,
        clockSkewWarning,
        clockSkewMs,
        isSyncing: false,
        isConfigured: true,
        isAuthenticated: true,
        lastSummary: { ...summary, completedAt },
      });
    } catch (error) {
      this.activeSyncing = false;
      const pendingAfter = await countPendingChanges(db, session.userId);

      if (this.isAuthErrorFn(error)) {
        await this.persistSyncOutcome('auth_required', AUTH_EXPIRED_MESSAGE);
        if (dbMutated) {
          await this.deps.onDataChanged?.();
        }
        return this.emitSnapshot({
          status: 'auth_required',
          pendingCount: pendingAfter,
          lastSyncAt: session.lastSyncAt,
          lastSyncError: AUTH_EXPIRED_MESSAGE,
          clockSkewWarning,
          clockSkewMs,
          isSyncing: false,
          isConfigured: true,
          isAuthenticated: false,
        });
      }

      if (this.isNetworkErrorFn(error)) {
        await this.persistSyncOutcome('offline', null);
        if (dbMutated) {
          await this.deps.onDataChanged?.();
        }
        return this.emitSnapshot({
          status: 'offline',
          pendingCount: pendingAfter,
          lastSyncAt: session.lastSyncAt,
          lastSyncError: null,
          clockSkewWarning,
          clockSkewMs,
          isSyncing: false,
          isConfigured: true,
          isAuthenticated: true,
        });
      }

      const msg = formatErrorMessage(error);
      await this.persistSyncOutcome('error', msg);
      if (dbMutated) {
        await this.deps.onDataChanged?.();
      }
      return this.emitSnapshot({
        status: 'error',
        pendingCount: pendingAfter,
        lastSyncAt: session.lastSyncAt,
        lastSyncError: msg,
        clockSkewWarning,
        clockSkewMs,
        isSyncing: false,
        isConfigured: true,
        isAuthenticated: true,
      });
    } finally {
      this.activeSyncing = false;
    }
  }

  private pageLimitGuard(): number {
    return this.maxPagesPerRun;
  }

  private async applySyncPage(params: {
    userId: string;
    response: SyncResponse;
    pushedBookStamps: ReadonlyMap<string, string | null>;
    pushedUserBookStamps: ReadonlyMap<string, string | null>;
  }): Promise<{
    conflictsServerWon: number;
    duplicatesMerged: number;
    mutated: boolean;
  }> {
    const { db } = this.deps;
    const { userId, response, pushedBookStamps, pushedUserBookStamps } = params;

    let conflictsServerWon = 0;
    let duplicatesMerged = 0;
    let mutated = false;

    await db.withTransactionAsync(async () => {
      // Phase A: Push-Ergebnisse für books verarbeiten (race-safe Reset)
      for (const item of response.pushResults.books) {
        const pushedStamp = pushedBookStamps.get(item.id) ?? null;

        if (
          item.status === 'accepted' ||
          (item.status === 'rejected' && item.reason === 'book_not_in_user_library')
        ) {
          const res = await db.runAsync(
            `UPDATE books
             SET is_dirty = 0, dirty_updated_at = NULL
             WHERE id = ?
               AND is_dirty = 1
               AND ((? IS NULL AND dirty_updated_at IS NULL) OR dirty_updated_at = ?)`,
            item.id,
            pushedStamp,
            pushedStamp
          );
          if (res.changes > 0) mutated = true;
        } else if (item.status === 'conflict_server_won') {
          conflictsServerWon += 1;
        }
      }

      // Phase B: Push-Ergebnisse für userBooks verarbeiten inkl. Duplikat-Bereinigung
      const remappedInFlightEditsByBookId = new Map<string, LocalUserBookSyncRow>();

      for (const item of response.pushResults.userBooks) {
        const pushedStamp = pushedUserBookStamps.get(item.id) ?? null;

        if (
          item.status === 'accepted' ||
          (item.status === 'rejected' && item.reason === 'forbidden_user_book_id')
        ) {
          const res = await db.runAsync(
            `UPDATE user_books
             SET is_dirty = 0, dirty_updated_at = NULL
             WHERE id = ?
               AND user_id = ?
               AND is_dirty = 1
               AND ((? IS NULL AND dirty_updated_at IS NULL) OR dirty_updated_at = ?)`,
            item.id,
            userId,
            pushedStamp,
            pushedStamp
          );
          if (res.changes > 0) mutated = true;
        } else if (item.status === 'conflict_server_won') {
          conflictsServerWon += 1;
        } else if (
          item.status === 'rejected' &&
          item.reason === 'duplicate_active_user_book_merged'
        ) {
          duplicatesMerged += 1;
          const dupRow = await db.getFirstAsync<LocalUserBookSyncRow>(
            'SELECT * FROM user_books WHERE id = ? AND user_id = ?',
            item.id,
            userId
          );
          if (
            dupRow &&
            dupRow.is_dirty === 1 &&
            dupRow.dirty_updated_at !== pushedStamp
          ) {
            remappedInFlightEditsByBookId.set(dupRow.book_id, dupRow);
          }
          await db.runAsync(
            'DELETE FROM user_books WHERE id = ? AND user_id = ?',
            item.id,
            userId
          );
          mutated = true;
        }
      }

      // Phase C: pull.books ZUERST upserten (FK-Voraussetzung für user_books)
      for (const pulled of response.pull.books) {
        const existing = await db.getFirstAsync<LocalBookSyncRow>(
          'SELECT * FROM books WHERE id = ?',
          pulled.id
        );

        const primaryAuthor = pulled.authors[0]?.trim() || null;

        if (existing) {
          const pushedStamp = pushedBookStamps.get(pulled.id);
          const hasUnpushedInFlightEdit =
            existing.is_dirty === 1 &&
            (pushedStamp === undefined || existing.dirty_updated_at !== pushedStamp);

          if (hasUnpushedInFlightEdit && existing.updated_at > pulled.updatedAt) {
            continue;
          }

          const keepPendingUpload = existing.cover_pending_upload === 1;
          const nextCoverLocalUri = keepPendingUpload
            ? existing.cover_local_uri
            : pulled.coverKey !== null && pulled.coverKey === existing.cover_key
              ? existing.cover_local_uri
              : null;

          await db.runAsync(
            `UPDATE books SET
              title = ?, subtitle = ?, authors = ?, primary_author = ?,
              series_name = ?, series_number = ?, isbn_10 = ?, isbn_13 = ?,
              page_count = ?, published_year = ?, genres = ?, description = ?,
              cover_key = ?, cover_source_url = ?, cover_local_uri = ?, cover_pending_upload = ?,
              language = ?, publisher = ?, metadata_source = ?, metadata_external_id = ?,
              created_at = ?, updated_at = ?, deleted_at = ?,
              is_dirty = 0, dirty_updated_at = NULL
             WHERE id = ?`,
            pulled.title,
            pulled.subtitle,
            JSON.stringify(pulled.authors),
            primaryAuthor,
            pulled.seriesName,
            pulled.seriesNumber,
            pulled.isbn10,
            pulled.isbn13,
            pulled.pageCount,
            pulled.publishedYear,
            JSON.stringify(pulled.genres),
            pulled.description,
            pulled.coverKey,
            pulled.coverSourceUrl,
            nextCoverLocalUri,
            keepPendingUpload ? 1 : 0,
            pulled.language,
            pulled.publisher,
            pulled.metadataSource,
            pulled.metadataExternalId,
            normalizeTimestampOrFallback(pulled.createdAt, existing.created_at),
            normalizeTimestampOrFallback(pulled.updatedAt, existing.updated_at),
            pulled.deletedAt,
            pulled.id
          );
          mutated = true;
        } else {
          await db.runAsync(
            `INSERT INTO books (
              id, title, subtitle, authors, primary_author,
              series_name, series_number, isbn_10, isbn_13,
              page_count, published_year, genres, description,
              cover_key, cover_source_url, cover_local_uri, cover_pending_upload,
              language, publisher, metadata_source, metadata_external_id,
              created_by_user_id, created_at, updated_at, deleted_at,
              is_dirty, dirty_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
            pulled.id,
            pulled.title,
            pulled.subtitle,
            JSON.stringify(pulled.authors),
            primaryAuthor,
            pulled.seriesName,
            pulled.seriesNumber,
            pulled.isbn10,
            pulled.isbn13,
            pulled.pageCount,
            pulled.publishedYear,
            JSON.stringify(pulled.genres),
            pulled.description,
            pulled.coverKey,
            pulled.coverSourceUrl,
            pulled.language,
            pulled.publisher,
            pulled.metadataSource,
            pulled.metadataExternalId,
            userId,
            pulled.createdAt,
            pulled.updatedAt,
            pulled.deletedAt
          );
          mutated = true;
        }
      }

      // Phase D: pull.userBooks strikt mandantenisoliert upserten
      for (const pulledUb of response.pull.userBooks) {
        if (pulledUb.userId !== userId) {
          continue;
        }

        // Schutz für partiellen Unique-Index idx_mobile_user_books_active_unique
        if (pulledUb.deletedAt === null) {
          const conflictingLocals = await db.getAllAsync<LocalUserBookSyncRow>(
            `SELECT * FROM user_books
             WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL AND id != ?`,
            userId,
            pulledUb.bookId,
            pulledUb.id
          );
          for (const conflict of conflictingLocals) {
            const pushedConflictStamp = pushedUserBookStamps.get(conflict.id);
            if (
              conflict.is_dirty === 1 &&
              (pushedConflictStamp === undefined ||
                conflict.dirty_updated_at !== pushedConflictStamp)
            ) {
              const prev = remappedInFlightEditsByBookId.get(conflict.book_id);
              if (!prev || conflict.updated_at > prev.updated_at) {
                remappedInFlightEditsByBookId.set(conflict.book_id, conflict);
              }
            }
            await db.runAsync(
              'DELETE FROM user_books WHERE id = ? AND user_id = ?',
              conflict.id,
              userId
            );
            mutated = true;
          }
        }

        const inFlightRemap =
          pulledUb.deletedAt === null
            ? remappedInFlightEditsByBookId.get(pulledUb.bookId)
            : undefined;

        const effectiveUb: UserBook & {
          isDirty: number;
          dirtyUpdatedAt: string | null;
        } =
          inFlightRemap && inFlightRemap.updated_at > pulledUb.updatedAt
            ? {
                ...pulledUb,
                status: inFlightRemap.status,
                rating: inFlightRemap.rating,
                notes: inFlightRemap.notes,
                addedAt: inFlightRemap.added_at,
                startedAt: inFlightRemap.started_at,
                finishedAt: inFlightRemap.finished_at,
                updatedAt: inFlightRemap.updated_at,
                deletedAt: inFlightRemap.deleted_at,
                isDirty: 1,
                dirtyUpdatedAt: inFlightRemap.dirty_updated_at,
              }
            : {
                ...pulledUb,
                isDirty: 0,
                dirtyUpdatedAt: null,
              };

        if (inFlightRemap) {
          remappedInFlightEditsByBookId.delete(pulledUb.bookId);
        }

        const existingUb = await db.getFirstAsync<LocalUserBookSyncRow>(
          'SELECT * FROM user_books WHERE id = ?',
          pulledUb.id
        );

        if (existingUb) {
          if (existingUb.user_id !== userId) {
            continue;
          }

          const pushedStamp = pushedUserBookStamps.get(pulledUb.id);
          const hasUnpushedInFlightEdit =
            existingUb.is_dirty === 1 &&
            (pushedStamp === undefined || existingUb.dirty_updated_at !== pushedStamp);

          if (
            effectiveUb.isDirty === 0 &&
            hasUnpushedInFlightEdit &&
            existingUb.updated_at > pulledUb.updatedAt
          ) {
            continue;
          }

          await db.runAsync(
            `UPDATE user_books SET
              book_id = ?, status = ?, rating = ?, notes = ?,
              added_at = ?, started_at = ?, finished_at = ?,
              created_at = ?, updated_at = ?, deleted_at = ?,
              is_dirty = ?, dirty_updated_at = ?
             WHERE id = ? AND user_id = ?`,
            effectiveUb.bookId,
            effectiveUb.status,
            effectiveUb.rating,
            effectiveUb.notes,
            effectiveUb.addedAt,
            effectiveUb.startedAt,
            effectiveUb.finishedAt,
            effectiveUb.createdAt,
            effectiveUb.updatedAt,
            effectiveUb.deletedAt,
            effectiveUb.isDirty,
            effectiveUb.dirtyUpdatedAt,
            pulledUb.id,
            userId
          );
          mutated = true;
        } else {
          await db.runAsync(
            `INSERT INTO user_books (
              id, user_id, book_id, status, rating, notes,
              added_at, started_at, finished_at,
              created_at, updated_at, deleted_at,
              is_dirty, dirty_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            effectiveUb.id,
            userId,
            effectiveUb.bookId,
            effectiveUb.status,
            effectiveUb.rating,
            effectiveUb.notes,
            effectiveUb.addedAt,
            effectiveUb.startedAt,
            effectiveUb.finishedAt,
            effectiveUb.createdAt,
            effectiveUb.updatedAt,
            effectiveUb.deletedAt,
            effectiveUb.isDirty,
            effectiveUb.dirtyUpdatedAt
          );
          mutated = true;
        }
      }

      if (response.nextCursor !== null) {
        await setSyncStateValue(db, 'last_sync_cursor', response.nextCursor);
      }
    });

    return {
      conflictsServerWon,
      duplicatesMerged,
      mutated,
    };
  }
}
