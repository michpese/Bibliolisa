import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@bibliolisa/shared';
import {
  createLocalLibraryEntry,
  getLocalLibraryEntryById,
  updateLocalLibraryEntry,
} from '../src/db/library.repo';
import { runMigrations } from '../src/db/migrations';
import {
  adoptLocalDataForUser,
  getAppSessionState,
  getSyncStateValue,
  setSyncStateValue,
} from '../src/db/sync-state.repo';
import type { SqlBindValue, SqlExecutor } from '../src/db/types';
import {
  checkForAppUpdate,
  compareSemver,
  formatFileSize,
  formatReleaseNotesForDisplay,
  GITHUB_RELEASES_PAGE_URL,
  isApkZipMagic,
  isNewerVersion,
  isTrustedGitHubUrl,
  parseGitHubReleasePayload,
  parseSemver,
} from '../src/services/app-updater-utils';
import { extractChangelogSection } from '../../scripts/extract-changelog.mjs';

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

describe('SemVer & URL-Validierung für App-Updates', () => {
  it('parst und vergleicht SemVer inkl. Prereleases und mehrstelliger Zahlen', () => {
    expect(parseSemver('v0.2.0')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: [],
    });
    expect(parseSemver('0.2.0-beta.10+build.5')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: ['beta', '10'],
    });
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();

    expect(compareSemver('0.3.0', '0.2.0')).toBe(1);
    expect(compareSemver('0.10.0', '0.2.0')).toBe(1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBe(1);
    expect(compareSemver('0.2.0-beta.10', '0.2.0-beta.2')).toBe(1);
    expect(compareSemver('0.2.0-1', '0.2.0-alpha')).toBe(-1);
    expect(compareSemver('0.2.0-alpha', '0.2.0-alpha.1')).toBe(-1);
    expect(compareSemver('v0.2.0+build.1', '0.2.0')).toBe(0);

    expect(isNewerVersion('0.2.0', 'v0.3.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
    expect(isNewerVersion('0.2.0', 'ungueltig')).toBe(false);
  });

  it('erlaubt nur vertrauenswürdige HTTPS-GitHub-URLs für dieses Repository', () => {
    expect(
      isTrustedGitHubUrl(
        'https://github.com/michpese/Bibliolisa/releases/download/v0.2.0/bibliolisa-v0.2.0.apk'
      )
    ).toBe(true);
    expect(
      isTrustedGitHubUrl(
        'https://objects.githubusercontent.com/github-production-release-asset-123/bibliolisa.apk'
      )
    ).toBe(true);
    expect(
      isTrustedGitHubUrl(
        'https://release-assets.githubusercontent.com/github-production-release-asset-123/bibliolisa.apk'
      )
    ).toBe(true);

    expect(
      isTrustedGitHubUrl(
        'http://github.com/michpese/Bibliolisa/releases/download/v0.2.0/app.apk'
      )
    ).toBe(false);
    expect(
      isTrustedGitHubUrl(
        'https://github.com/otheruser/Bibliolisa/releases/download/v0.2.0/app.apk'
      )
    ).toBe(false);
    expect(isTrustedGitHubUrl('https://evil.example.com/bibliolisa.apk')).toBe(
      false
    );
    expect(isTrustedGitHubUrl('not-a-url')).toBe(false);
  });
});

describe('GitHub-Release-Parsing & Update-Check', () => {
  it('extrahiert bibliolisa-*.apk, .sha256-URL und verwirft Drafts oder fremde URLs', () => {
    expect(
      parseGitHubReleasePayload({
        tag_name: 'v0.3.0',
        draft: true,
        assets: [],
      })
    ).toBeNull();

    const parsed = parseGitHubReleasePayload({
      tag_name: 'v0.3.0',
      name: 'Bibliolisa v0.3.0',
      body: '### ✨ Highlights\n\n- **Suche:** Noch schneller',
      html_url: 'https://evil.example.com/fake-release',
      published_at: '2026-11-25T10:00:00Z',
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'bibliolisa-v0.3.0.apk.sha256',
          browser_download_url:
            'https://github.com/michpese/Bibliolisa/releases/download/v0.3.0/bibliolisa-v0.3.0.apk.sha256',
          size: 96,
          content_type: 'text/plain',
        },
        {
          name: 'bibliolisa-v0.3.0.apk',
          browser_download_url:
            'https://github.com/michpese/Bibliolisa/releases/download/v0.3.0/bibliolisa-v0.3.0.apk',
          size: 52_428_800,
          content_type: 'application/vnd.android.package-archive',
        },
        {
          name: 'malicious.apk',
          browser_download_url: 'https://evil.example.com/malicious.apk',
          size: 1000,
        },
      ],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('0.3.0');
    expect(parsed?.htmlUrl).toBe(GITHUB_RELEASES_PAGE_URL);
    expect(parsed?.apkAsset?.name).toBe('bibliolisa-v0.3.0.apk');
    expect(parsed?.apkAsset?.size).toBe(52_428_800);
    expect(parsed?.apkAsset?.sha256Url).toContain('.apk.sha256');

    const noApk = parseGitHubReleasePayload({
      tag_name: 'v0.3.0',
      assets: [
        {
          name: 'untrusted.apk',
          browser_download_url: 'https://evil.example.com/app.apk',
        },
      ],
    });
    expect(noApk?.apkAsset).toBeNull();
  });

  it('behandelt 200 Update, 200 aktuell, 304 ETag-Cache, 404, Rate-Limit und Fehlerfälle', async () => {
    const releasePayload = {
      tag_name: 'v0.3.0',
      name: 'Bibliolisa v0.3.0',
      body: '### ✨ Highlights\n\n- **Neu:** Test',
      html_url: 'https://github.com/michpese/Bibliolisa/releases/tag/v0.3.0',
      published_at: '2026-11-25T10:00:00Z',
      assets: [
        {
          name: 'bibliolisa-v0.3.0.apk',
          browser_download_url:
            'https://github.com/michpese/Bibliolisa/releases/download/v0.3.0/bibliolisa-v0.3.0.apk',
          size: 40_000_000,
        },
      ],
    };

    const resAvailable = await checkForAppUpdate({
      currentVersion: '0.2.0',
      fetchImpl: async () =>
        new Response(JSON.stringify(releasePayload), {
          status: 200,
          headers: { etag: '"etag-1"' },
        }),
    });
    expect(resAvailable.status).toBe('update_available');
    if (resAvailable.status === 'update_available') {
      expect(resAvailable.release.version).toBe('0.3.0');
      expect(resAvailable.etag).toBe('"etag-1"');
      expect(resAvailable.fromCache).toBe(false);
    }

    const resUpToDate = await checkForAppUpdate({
      currentVersion: '0.3.0',
      fetchImpl: async () =>
        new Response(JSON.stringify(releasePayload), { status: 200 }),
    });
    expect(resUpToDate).toMatchObject({
      status: 'up_to_date',
      currentVersion: '0.3.0',
      latestVersion: '0.3.0',
      fromCache: false,
    });

    if (resAvailable.status !== 'update_available') {
      throw new Error('Erwartete update_available');
    }

    const res304 = await checkForAppUpdate({
      currentVersion: '0.2.0',
      etag: '"etag-1"',
      cachedRelease: resAvailable.release,
      fetchImpl: async (_url, init) => {
        const hdrs = init?.headers as Record<string, string>;
        expect(hdrs['If-None-Match']).toBe('"etag-1"');
        return new Response(null, { status: 304, headers: { etag: '"etag-1"' } });
      },
    });
    expect(res304).toMatchObject({
      status: 'update_available',
      etag: '"etag-1"',
      fromCache: true,
    });

    const res404 = await checkForAppUpdate({
      currentVersion: '0.2.0',
      fetchImpl: async () => new Response('Not Found', { status: 404 }),
    });
    expect(res404).toEqual({ status: 'no_release', etag: null });

    const resRateLimit = await checkForAppUpdate({
      currentVersion: '0.2.0',
      fetchImpl: async () =>
        new Response('Forbidden', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    });
    expect(resRateLimit).toMatchObject({
      status: 'error',
      kind: 'rate_limited',
      httpStatus: 403,
    });

    const resTimeout = await checkForAppUpdate({
      currentVersion: '0.2.0',
      timeoutMs: 25,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    expect(resTimeout).toMatchObject({
      status: 'error',
      kind: 'timeout',
    });

    const resNetwork = await checkForAppUpdate({
      currentVersion: '0.2.0',
      fetchImpl: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(resNetwork).toMatchObject({
      status: 'error',
      kind: 'network',
    });
  });

  it('formatiert Release Notes für UI, prüft APK-Magic-Bytes & Dateigrößen und liest CHANGELOG.md', () => {
    const sampleBody = [
      '### ✨ Highlights',
      '',
      '- **In-App-Updater:** Prüft beim Start und über [`SettingsScreen`](mobile/src/screens/SettingsScreen.tsx)',
      '* **Daten-Schutz:** Alle `SQLite`-Bücher bleiben erhalten.',
      '',
      'Normaler Absatz mit `Code`.',
      '',
      '---',
      '',
      '### Android APK',
      '',
      '- **Datei:** `bibliolisa-v0.2.0.apk`',
      '**Full Changelog**: https://github.com/michpese/Bibliolisa/compare/v0.1.0...v0.2.0',
    ].join('\n');

    const blocks = formatReleaseNotesForDisplay(sampleBody);
    expect(blocks).toEqual([
      { type: 'heading', text: '✨ Highlights' },
      {
        type: 'bullet',
        boldPrefix: 'In-App-Updater:',
        text: 'Prüft beim Start und über SettingsScreen',
      },
      {
        type: 'bullet',
        boldPrefix: 'Daten-Schutz:',
        text: 'Alle SQLite-Bücher bleiben erhalten.',
      },
      { type: 'paragraph', text: 'Normaler Absatz mit Code.' },
    ]);

    expect(isApkZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isApkZipMagic(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]))).toBe(false);
    expect(isApkZipMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);

    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(839_680)).toBe('820 KB');
    expect(formatFileSize(54_735_667)).toBe('52,2 MB');

    const changelogPath = path.resolve(__dirname, '..', '..', 'CHANGELOG.md');
    const changelogMd = fs.readFileSync(changelogPath, 'utf8');

    const sec020 = extractChangelogSection(changelogMd, 'v0.2.0');
    expect(sec020).toContain('### ✨ Highlights');
    expect(sec020).toContain('Android In-App-Updates');
    expect(sec020).not.toContain('## [0.1.0]');

    expect(extractChangelogSection(changelogMd, '0.2.0')).toBe(sec020);
    expect(extractChangelogSection(changelogMd, 'v0.1.0')).toContain(
      'Erstes vollständiges Release'
    );
    expect(extractChangelogSection(changelogMd, 'v9.9.9')).toBe('');
  });
});

describe('Erhalt bestehender Benutzerdaten beim App-Update', () => {
  it('behält Bücher, Bewertungen, Notizen, schmutzige Sync-Einträge, Konto & Update-Einstellungen bei erneutem App-Start/Migrationslauf vollständig', async () => {
    const { db, raw } = createMemorySqlExecutor();
    const nextUuid = () => crypto.randomUUID();

    try {
      await runMigrations(db, nextUuid);
      const initialSession = await getAppSessionState(db);

      const created = await createLocalLibraryEntry(
        db,
        initialSession.userId,
        {
          book: {
            title: 'Dune – Der Wüstenplanet',
            authors: ['Frank Herbert'],
            seriesName: 'Dune',
            seriesNumber: 1,
            genres: ['Science-Fiction'],
            metadataSource: 'manual',
          },
          status: 'reading',
          rating: 5,
          notes: 'Lieblingsbuch im lokalen Speicher',
        },
        { generateUuid: nextUuid }
      );

      await updateLocalLibraryEntry(
        db,
        initialSession.userId,
        created.id,
        {
          rating: 5,
          notes: 'Unbedingt vor dem Update auf dem Gerät behalten!',
        }
      );

      const authUser: AuthUser = {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        username: 'lisa',
        displayName: 'Lisa',
        email: null,
        role: 'admin',
        createdAt: '2026-11-21T10:00:00.000Z',
      };
      await adoptLocalDataForUser(db, authUser);

      await setSyncStateValue(db, 'server_url', 'https://books.home.lan');
      await setSyncStateValue(
        db,
        'last_sync_cursor',
        'MjAyNi0xMS0yMVQxMjowMDowMC4wMDBafGFiYw=='
      );
      await setSyncStateValue(db, 'last_sync_at', '2026-11-21T12:00:00.000Z');
      await setSyncStateValue(db, 'update_auto_check', '1');
      await setSyncStateValue(db, 'update_etag', '"etag-v020"');
      await setSyncStateValue(db, 'update_skipped_version', '0.2.1');

      // Simuliert App-Neustart nach Installation einer neuen APK-Version
      await runMigrations(db, nextUuid);

      const sessionAfterUpdate = await getAppSessionState(db);
      expect(sessionAfterUpdate.deviceId).toBe(initialSession.deviceId);
      expect(sessionAfterUpdate.userId).toBe(authUser.id);
      expect(sessionAfterUpdate.username).toBe('lisa');
      expect(sessionAfterUpdate.displayName).toBe('Lisa');
      expect(sessionAfterUpdate.isLocalOnlyUser).toBe(false);
      expect(sessionAfterUpdate.serverUrl).toBe('https://books.home.lan');
      expect(sessionAfterUpdate.lastSyncCursor).toBe(
        'MjAyNi0xMS0yMVQxMjowMDowMC4wMDBafGFiYw=='
      );
      expect(sessionAfterUpdate.lastSyncAt).toBe('2026-11-21T12:00:00.000Z');

      const entryAfterUpdate = await getLocalLibraryEntryById(
        db,
        authUser.id,
        created.id
      );
      expect(entryAfterUpdate).not.toBeNull();
      expect(entryAfterUpdate?.book.title).toBe('Dune – Der Wüstenplanet');
      expect(entryAfterUpdate?.rating).toBe(5);
      expect(entryAfterUpdate?.status).toBe('reading');
      expect(entryAfterUpdate?.notes).toBe(
        'Unbedingt vor dem Update auf dem Gerät behalten!'
      );
      expect(entryAfterUpdate?.isDirty).toBe(true);

      expect(await getSyncStateValue(db, 'update_auto_check')).toBe('1');
      expect(await getSyncStateValue(db, 'update_etag')).toBe('"etag-v020"');
      expect(await getSyncStateValue(db, 'update_skipped_version')).toBe(
        '0.2.1'
      );
    } finally {
      raw.close();
    }
  });
});
