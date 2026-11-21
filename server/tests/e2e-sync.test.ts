import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthTokenResponseSchema,
  BookCoverResponseSchema,
  LibraryListResponseSchema,
  RecommendationResultSchema,
  SyncResponseSchema,
  type AuthUser,
} from '@bibliolisa/shared';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import {
  createLocalLibraryEntry,
  getLocalLibraryEntryById,
  listLocalLibraryEntries,
  softDeleteLocalLibraryEntry,
  updateLocalLibraryEntry,
} from '../../mobile/src/db/library.repo.js';
import { runMigrations } from '../../mobile/src/db/migrations.js';
import {
  adoptLocalDataForUser,
  countPendingChanges,
  getAppSessionState,
  setSyncStateValue,
} from '../../mobile/src/db/sync-state.repo.js';
import type { SqlBindValue, SqlExecutor } from '../../mobile/src/db/types.js';
import { checkServerHealth } from '../../mobile/src/sync/health-check.js';
import { SyncEngine } from '../../mobile/src/sync/sync-engine.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

interface StoredMobileSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

function createMobileSqliteExecutor(): { db: SqlExecutor; raw: Database.Database } {
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

async function createRealMobileClient(params: {
  user: AuthUser;
  tokens: StoredMobileSession;
  serverUrl: string;
  coverDir: string;
  now: () => Date;
}) {
  const { db, raw } = createMobileSqliteExecutor();
  const nextUuid = () => crypto.randomUUID();
  await runMigrations(db, nextUuid);
  await adoptLocalDataForUser(db, params.user);
  await setSyncStateValue(db, 'server_url', params.serverUrl);

  let tokens: StoredMobileSession | null = { ...params.tokens };

  const ensureAccessToken = async (baseUrl: string): Promise<string> => {
    if (!tokens) {
      const err = new Error('AUTH_REQUIRED') as Error & { status: number };
      err.status = 401;
      throw err;
    }
    const expiresMs = Date.parse(tokens.accessTokenExpiresAt);
    if (expiresMs - params.now().getTime() > 60_000) {
      return tokens.accessToken;
    }

    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken, clientType: 'mobile' }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        tokens = null;
      }
      const err = new Error(`Refresh failed (${res.status})`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const parsed = AuthTokenResponseSchema.parse(await res.json());
    tokens = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? tokens.refreshToken,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
    };
    return tokens.accessToken;
  };

  const engine = new SyncEngine({
    db,
    now: params.now,
    healthTimeoutMs: 500,
    checkHealth: checkServerHealth,
    hasStoredTokens: async () => tokens !== null,
    ensureAccessToken,
    syncRequest: async (baseUrl, payload) => {
      const bearer = await ensureAccessToken(baseUrl);
      const res = await fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = new Error(`Sync HTTP ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return SyncResponseSchema.parse(await res.json());
    },
    coverAdapter: {
      getCachedCoverUri: (coverKey) => {
        const target = path.join(params.coverDir, coverKey);
        return fs.existsSync(target) && fs.statSync(target).size > 0
          ? `file://${target}`
          : null;
      },
      uploadCover: async ({ serverUrl: baseUrl, bookId, localUri }) => {
        const bearer = await ensureAccessToken(baseUrl);
        const filePath = localUri.replace(/^file:\/\//, '');
        const bytes = fs.readFileSync(filePath);
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'image/png' }), 'cover.png');
        const res = await fetch(`${baseUrl}/api/books/${bookId}/cover`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: form,
        });
        if (!res.ok) {
          const err = new Error(`Upload HTTP ${res.status}`) as Error & { status: number };
          err.status = res.status;
          throw err;
        }
        return BookCoverResponseSchema.parse(await res.json());
      },
      downloadCover: async ({ serverUrl: baseUrl, coverKey, accessToken }) => {
        const res = await fetch(`${baseUrl}/api/covers/${coverKey}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          const err = new Error(`Download HTTP ${res.status}`) as Error & { status: number };
          err.status = res.status;
          throw err;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const target = path.join(params.coverDir, coverKey);
        fs.mkdirSync(params.coverDir, { recursive: true });
        fs.writeFileSync(target, buf);
        return `file://${target}`;
      },
      cleanupOrphans: async (activeUris) => {
        if (!fs.existsSync(params.coverDir)) return 0;
        let removed = 0;
        for (const entry of fs.readdirSync(params.coverDir)) {
          const full = path.join(params.coverDir, entry);
          const uri = `file://${full}`;
          if (!activeUris.has(uri)) {
            fs.unlinkSync(full);
            removed += 1;
          }
        }
        return removed;
      },
    },
  });

  return {
    db,
    raw,
    engine,
    nextUuid,
    getTokens: () => tokens,
    setTokens: (next: StoredMobileSession | null) => {
      tokens = next;
    },
  };
}

function parseSetCookies(res: Response): Map<string, string> {
  const map = new Map<string, string>();
  const lines = res.headers.getSetCookie?.() ?? [];
  for (const line of lines) {
    const [pair] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq > 0) {
      map.set(pair.slice(0, eq).trim(), line);
    }
  }
  return map;
}

function extractCookieValue(rawLine: string): string {
  const [pair] = rawLine.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  return eq >= 0 && pair ? pair.slice(eq + 1).trim() : '';
}

describe('Phase 5 E2E: Android SyncEngine + SQLite <-> Fastify Server + Web-API + Reverse Proxy', () => {
  const tempDirs: string[] = [];
  const openRawDbs: Database.Database[] = [];
  let activeApp: Awaited<ReturnType<typeof buildApp>>['app'] | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close().catch(() => undefined);
      activeApp = null;
    }
    while (openRawDbs.length > 0) {
      openRawDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('durchläuft alle 5 E2E-Szenarien (Offline->Sync->Web, LWW-Konflikte, Server-Ausfall, 2-User-Isolation, Proxy-Header & Neustart)', async () => {
    const serverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-e2e-srv-'));
    const mobileCoverDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-e2e-covA-'));
    const mobileCoverDirA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-e2e-covA2-'));
    const mobileCoverDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-e2e-covB-'));
    tempDirs.push(serverDataDir, mobileCoverDirA, mobileCoverDirA2, mobileCoverDirB);

    let nowMs = Date.parse('2026-11-21T10:00:00.000Z');
    const now = () => new Date(nowMs);

    const env = parseEnv({
      DATA_DIR: serverDataDir,
      JWT_SECRET: 'e2e-test-secret-with-at-least-32-characters-123456',
      TRUST_PROXY: 'true',
      LOG_LEVEL: 'silent',
    });

    const startServer = async () => {
      const built = await buildApp({
        env,
        now,
        logger: false,
        webDir: null,
      });
      activeApp = built.app;
      const address = await built.app.listen({ host: '127.0.0.1', port: 0 });
      return { app: built.app, baseUrl: address };
    };

    let { baseUrl } = await startServer();

    // User A für Web + Android registrieren
    const regWebA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'web',
      }),
    });
    expect(regWebA.status).toBe(201);
    const webACookies = parseSetCookies(regWebA);
    const webABody = AuthTokenResponseSchema.parse(await regWebA.json());
    const webAToken = webABody.accessToken;
    const mediaCookieA = extractCookieValue(webACookies.get('bibliolisa_media') ?? '');
    expect(mediaCookieA).toBeTruthy();

    const loginMobA = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'mobile',
        deviceId: 'pixel-anna',
        deviceName: 'Pixel Anna',
      }),
    });
    expect(loginMobA.status).toBe(200);
    const mobABody = AuthTokenResponseSchema.parse(await loginMobA.json());

    // Mobile Client A mit kurz vor Ablauf stehendem Access Token (< 60s) initialisieren
    const initialTokensA: StoredMobileSession = {
      accessToken: mobABody.accessToken,
      refreshToken: mobABody.refreshToken!,
      accessTokenExpiresAt: new Date(nowMs + 30_000).toISOString(),
    };
    const mobileA = await createRealMobileClient({
      user: mobABody.user,
      tokens: initialTokensA,
      serverUrl: baseUrl,
      coverDir: mobileCoverDirA,
      now,
    });
    openRawDbs.push(mobileA.raw);

    // =========================================================================
    // SZENARIO 1: Flugmodus-Edits -> WLAN-Sync -> Web-Verifikation
    // =========================================================================
    const localPhotoPath = path.join(mobileCoverDirA, 'local-cam-vol15.png');
    fs.writeFileSync(localPhotoPath, PNG_1X1);

    nowMs += 1000;
    const vol1 = await createLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      {
        book: {
          title: 'Sturmlicht 1',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 1,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'read',
        rating: 5,
      },
      { generateUuid: mobileA.nextUuid, now }
    );

    nowMs += 1000;
    const vol15 = await createLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      {
        book: {
          title: 'Edgedancer',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 1.5,
          genres: ['Fantasy'],
          pageCount: 220,
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      {
        generateUuid: mobileA.nextUuid,
        now,
        coverLocalUri: `file://${localPhotoPath}`,
        coverPendingUpload: true,
      }
    );

    nowMs += 1000;
    const vol2 = await createLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      {
        book: {
          title: 'Sturmlicht 2',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 2,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: mobileA.nextUuid, now }
    );

    nowMs += 1000;
    const deletedOffline = await createLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      {
        book: {
          title: 'Offline gelöschtes Buch',
          authors: ['Temp'],
          genres: [],
          metadataSource: 'manual',
        },
        status: 'unread',
      },
      { generateUuid: mobileA.nextUuid, now }
    );
    nowMs += 1000;
    await softDeleteLocalLibraryEntry(mobileA.db, mobABody.user.id, deletedOffline.id, now);

    // Sync nach Reconnect (inkl. transparentem Token-Refresh ohne Login!)
    nowMs += 1000;
    const snap1 = await mobileA.engine.sync('reconnect');
    expect(snap1.status).toBe('synced');
    expect(snap1.pendingCount).toBe(0);
    expect(snap1.lastSummary?.coversUploaded).toBe(1);
    expect(snap1.lastSummary?.coversDownloaded).toBe(1);
    expect(mobileA.getTokens()?.refreshToken).not.toBe(initialTokensA.refreshToken);

    const syncedVol15 = await getLocalLibraryEntryById(mobileA.db, mobABody.user.id, vol15.id);
    expect(syncedVol15?.coverPendingUpload).toBe(false);
    expect(syncedVol15?.book.coverKey).toMatch(/^[a-f0-9]{24}\.webp$/);
    expect(syncedVol15?.coverLocalUri).toContain(syncedVol15?.book.coverKey ?? '');
    expect(fs.existsSync(localPhotoPath)).toBe(false); // Orphan-Cleanup hat alte Temp-Datei entfernt

    // Web-API-Verifikation
    const webLibRes = await fetch(`${baseUrl}/api/library?sort=series&order=asc`, {
      headers: { Authorization: `Bearer ${webAToken}` },
    });
    expect(webLibRes.status).toBe(200);
    const webLib = LibraryListResponseSchema.parse(await webLibRes.json());
    expect(webLib.items.map((i) => i.book.seriesNumber)).toEqual([1, 1.5, 2]);
    const webVol15 = webLib.items.find((i) => i.id === vol15.id);
    expect(webVol15?.book.coverKey).toBe(syncedVol15?.book.coverKey);

    const webCoverRes = await fetch(`${baseUrl}/api/covers/${webVol15!.book.coverKey}`, {
      headers: { Cookie: `bibliolisa_media=${mediaCookieA}` },
    });
    expect(webCoverRes.status).toBe(200);
    expect(webCoverRes.headers.get('content-type')).toContain('image/webp');

    const webRecRes = await fetch(`${baseUrl}/api/recommendations`, {
      headers: { Authorization: `Bearer ${webAToken}` },
    });
    const webRecs = RecommendationResultSchema.parse(await webRecRes.json());
    expect(webRecs.categories.continue_series[0]?.userBookId).toBe(vol15.id);

    // =========================================================================
    // SZENARIO 2: LWW-Konflikt (Web gewinnt -> Android gewinnt) + Duplikat-Merge
    // =========================================================================
    // Android bearbeitet Band 2 bei T+10s offline
    nowMs += 10_000;
    await updateLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      vol2.id,
      { status: 'abandoned', notes: 'Android alt T+10s' },
      { now }
    );

    // Web bearbeitet Band 2 bei T+30s (neuer)
    nowMs += 20_000;
    const webPatch = await fetch(`${baseUrl}/api/library/${vol2.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${webAToken}`,
      },
      body: JSON.stringify({ status: 'reading', notes: 'Web neuer T+30s' }),
    });
    expect(webPatch.status).toBe(200);

    // Android synct -> Web gewinnt, Android konvergiert
    nowMs += 1000;
    const snapConflict1 = await mobileA.engine.sync('manual');
    expect(snapConflict1.status).toBe('synced');
    expect(snapConflict1.lastSummary?.conflictsServerWon).toBe(1);
    const vol2AfterServerWon = await getLocalLibraryEntryById(mobileA.db, mobABody.user.id, vol2.id);
    expect(vol2AfterServerWon?.status).toBe('reading');
    expect(vol2AfterServerWon?.notes).toBe('Web neuer T+30s');
    expect(vol2AfterServerWon?.isDirty).toBe(false);

    // Gegenrichtung: Android bearbeitet neuer -> Client gewinnt
    nowMs += 10_000;
    await updateLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      vol2.id,
      { status: 'read', rating: 4, notes: 'Android gewinnt T+41s' },
      { now }
    );
    nowMs += 1000;
    const snapConflict2 = await mobileA.engine.sync('manual');
    expect(snapConflict2.status).toBe('synced');
    expect(snapConflict2.lastSummary?.conflictsServerWon).toBe(0);

    const webCheckWin = await fetch(`${baseUrl}/api/library/${vol2.id}`, {
      headers: { Authorization: `Bearer ${webAToken}` },
    });
    const webVol2 = await webCheckWin.json();
    expect(webVol2.status).toBe('read');
    expect(webVol2.rating).toBe(4);
    expect(webVol2.notes).toBe('Android gewinnt T+41s');

    // Zweites Android-Gerät von Anna erzeugt Duplikat auf derselben bookId
    const loginMobA2 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'mobile',
        deviceId: 'tablet-anna',
        deviceName: 'Tablet Anna',
      }),
    });
    expect(loginMobA2.status).toBe(200);
    const mobA2Body = AuthTokenResponseSchema.parse(await loginMobA2.json());

    const mobileA2 = await createRealMobileClient({
      user: mobA2Body.user,
      tokens: {
        accessToken: mobA2Body.accessToken,
        refreshToken: mobA2Body.refreshToken!,
        accessTokenExpiresAt: mobA2Body.accessTokenExpiresAt,
      },
      serverUrl: baseUrl,
      coverDir: mobileCoverDirA2,
      now,
    });
    openRawDbs.push(mobileA2.raw);
    nowMs += 5_000;
    // Zuerst Band 2 (mit derselben book.id, aber neuer user_books.id) auf Gerät A2 offline anlegen
    await createLocalLibraryEntry(
      mobileA2.db,
      mobABody.user.id,
      {
        book: {
          id: vol2.bookId,
          title: 'Sturmlicht 2',
          authors: ['Brandon Sanderson'],
          seriesName: 'Sturmlicht',
          seriesNumber: 2,
          genres: ['Fantasy'],
          metadataSource: 'manual',
        },
        status: 'read',
        rating: 5,
        notes: 'Vom zweiten Gerät gemergt',
      },
      { generateUuid: mobileA2.nextUuid, now }
    );
    const snapA2 = await mobileA2.engine.sync('manual');
    expect(snapA2.status).toBe('synced');
    expect(snapA2.lastSummary?.duplicatesMerged).toBe(1);
    const canonicalOnA2 = await getLocalLibraryEntryById(mobileA2.db, mobABody.user.id, vol2.id);
    expect(canonicalOnA2?.rating).toBe(5);
    expect(canonicalOnA2?.notes).toBe('Vom zweiten Gerät gemergt');

    // =========================================================================
    // SZENARIO 4 (vorgezogen vor Server-Stopp): 2-User-Isolation
    // =========================================================================
    const regMobB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ben',
        password: 'Password123!',
        clientType: 'mobile',
        deviceId: 'pixel-ben',
      }),
    });
    expect(regMobB.status).toBe(201);
    const mobBBody = AuthTokenResponseSchema.parse(await regMobB.json());
    const mobileB = await createRealMobileClient({
      user: mobBBody.user,
      tokens: {
        accessToken: mobBBody.accessToken,
        refreshToken: mobBBody.refreshToken!,
        accessTokenExpiresAt: mobBBody.accessTokenExpiresAt,
      },
      serverUrl: baseUrl,
      coverDir: mobileCoverDirB,
      now,
    });
    openRawDbs.push(mobileB.raw);

    nowMs += 1000;
    await createLocalLibraryEntry(
      mobileB.db,
      mobBBody.user.id,
      {
        book: { title: 'Bens Geheimbuch', authors: ['Autor B'], genres: [], metadataSource: 'manual' },
        status: 'unread',
      },
      { generateUuid: mobileB.nextUuid, now }
    );
    const snapB = await mobileB.engine.sync('manual');
    expect(snapB.status).toBe('synced');
    const entriesB = await listLocalLibraryEntries(mobileB.db, mobBBody.user.id);
    expect(entriesB.map((e) => e.book.title)).toEqual(['Bens Geheimbuch']);

    const snapACheck = await mobileA.engine.sync('manual');
    expect(snapACheck.status).toBe('synced');
    const entriesA = await listLocalLibraryEntries(mobileA.db, mobABody.user.id, {
      sort: 'series',
      order: 'asc',
    });
    expect(entriesA.some((e) => e.book.title === 'Bens Geheimbuch')).toBe(false);
    expect(entriesA.map((e) => e.book.title)).toEqual([
      'Sturmlicht 1',
      'Edgedancer',
      'Sturmlicht 2',
    ]);

    // =========================================================================
    // SZENARIO 5a: Reverse-Proxy-Header (HTTPS vs. LAN-HTTP)
    // =========================================================================
    const lanLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'web',
      }),
    });
    const lanCookies = parseSetCookies(lanLogin);
    expect(lanCookies.get('bibliolisa_refresh')).not.toMatch(/;\s*Secure(;|$)/i);

    const proxyLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '203.0.113.10',
        'X-Forwarded-Host': 'books.home.lan',
      },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'web',
      }),
    });
    const proxyCookies = parseSetCookies(proxyLogin);
    expect(proxyCookies.get('bibliolisa_refresh')).toMatch(/;\s*Secure(;|$)/i);
    expect(proxyCookies.get('bibliolisa_media')).toMatch(/;\s*Secure(;|$)/i);

    // =========================================================================
    // SZENARIO 3 & 5b: Server-Abwesenheit (Offline-Resilienz) + Neustart-Persistenz
    // =========================================================================
    await activeApp!.close();
    activeApp = null;

    // Android bearbeitet Buch bei ausgeschaltetem Server -> Status 'offline', Daten bleiben is_dirty = 1
    nowMs += 2000;
    await updateLocalLibraryEntry(
      mobileA.db,
      mobABody.user.id,
      vol1.id,
      { notes: 'Während Server-Neustart offline notiert' },
      { now }
    );
    const offlineSnap = await mobileA.engine.sync('manual');
    expect(offlineSnap.status).toBe('offline');
    expect(offlineSnap.pendingCount).toBe(1);
    expect(await countPendingChanges(mobileA.db, mobABody.user.id)).toBe(1);

    // Server auf demselben DATA_DIR neu starten -> Persistenz + Nach-Sync prüfen
    const restarted = await startServer();
    baseUrl = restarted.baseUrl;
    await setSyncStateValue(mobileA.db, 'server_url', baseUrl);

    nowMs += 2000;
    const recoveredSnap = await mobileA.engine.sync('reconnect');
    expect(recoveredSnap.status).toBe('synced');
    expect(recoveredSnap.pendingCount).toBe(0);

    const webLoginAfterRestart = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'anna',
        password: 'Password123!',
        clientType: 'web',
      }),
    });
    expect(webLoginAfterRestart.status).toBe(200);
    const restartCookies = parseSetCookies(webLoginAfterRestart);
    const restartBody = AuthTokenResponseSchema.parse(await webLoginAfterRestart.json());
    const restartMediaCookie = extractCookieValue(
      restartCookies.get('bibliolisa_media') ?? ''
    );

    const webAfterRestart = LibraryListResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/api/library?sort=series&order=asc`, {
          headers: { Authorization: `Bearer ${restartBody.accessToken}` },
        })
      ).json()
    );
    expect(webAfterRestart.items.map((i) => i.book.seriesNumber)).toEqual([1, 1.5, 2]);
    expect(webAfterRestart.items[0]?.notes).toBe('Während Server-Neustart offline notiert');
    expect(webAfterRestart.items[1]?.book.coverKey).toBe(syncedVol15?.book.coverKey);

    const coverAfterRestart = await fetch(
      `${baseUrl}/api/covers/${syncedVol15!.book.coverKey}`,
      { headers: { Cookie: `bibliolisa_media=${restartMediaCookie}` } }
    );
    expect(coverAfterRestart.status).toBe(200);
    expect(coverAfterRestart.headers.get('content-type')).toContain('image/webp');
  });
});
