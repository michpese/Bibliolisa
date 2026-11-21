#!/usr/bin/env node
/**
 * Container-Smoke-Test für Bibliolisa (Phase 3).
 *
 * Prüft gegen das echte Docker-Image:
 *   - Non-Root-Betrieb (UID 10001) und korrekte Rechte auf dem gemounteten /data-Verzeichnis
 *   - Auslieferung der Webapp (/ + SPA-Fallback + gecachte Assets) und /api/health
 *   - JSON-404 für unbekannte /api/*-Pfade, 401 ohne Token
 *   - Reverse-Proxy-Header (X-Forwarded-Proto/-For): Secure-Flag der Auth-Cookies
 *   - Cover-Upload + authentifizierte Cover-Auslieferung (Media-Cookie)
 *   - Container-Neustart ohne Verlust von Benutzer, Buch und Cover
 *
 * Aufruf:   node scripts/docker-smoke-test.mjs
 * Optional: SMOKE_IMAGE=bibliolisa:local  SMOKE_PORT=38080  SMOKE_SKIP_BUILD=1
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.SMOKE_IMAGE ?? 'bibliolisa:local';
const PORT = Number(process.env.SMOKE_PORT ?? 38080);
const NAME = `bibliolisa-smoke-${process.pid}`;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = randomBytes(32).toString('hex');
const APP_UID = '10001';

// 1x1 PNG (gültig, wird vom Server per sharp nach WebP konvertiert)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${!condition && detail ? `  -> ${detail}` : ''}`);
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) {
    throw new Error(`docker konnte nicht gestartet werden: ${result.error.message}`);
  }
  if (!options.allowFail && result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} fehlgeschlagen (Exit ${result.status}):\n${result.stderr ?? ''}`
    );
  }
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // Container startet noch
    }
    await sleep(750);
  }
  return false;
}

function parseSetCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookies = new Map();
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    cookies.set(pair.slice(0, idx).trim(), { value: pair.slice(idx + 1).trim(), raw: line });
  }
  return cookies;
}

function hasFlag(rawCookie, flag) {
  return new RegExp(`;\\s*${flag}(;|$)`, 'i').test(rawCookie);
}

function mountArgs(dataDir) {
  return ['--mount', `type=bind,source=${dataDir},target=/data`];
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-smoke-'));
  let started = false;

  const cleanup = () => {
    docker(['rm', '-f', NAME], { allowFail: true });
    try {
      // Dateien gehören UID 10001 -> mit Container-Root aufräumen, falls Host-User sie nicht löschen darf
      docker(
        ['run', '--rm', '--user', '0', '--entrypoint', 'sh', ...mountArgs(dataDir), IMAGE, '-c', 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true'],
        { allowFail: true }
      );
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Aufräumen ist Best-Effort
    }
  };

  try {
    if (!process.env.SMOKE_SKIP_BUILD) {
      console.log(`== docker build -t ${IMAGE} .`);
      docker(['build', '-t', IMAGE, '.'], { inherit: true });
    }

    // Rechte für das (leere) Host-Verzeichnis: wie `chown 10001:10001 ./data`
    docker(['run', '--rm', '--user', '0', '--entrypoint', 'chown', ...mountArgs(dataDir), IMAGE, `${APP_UID}:${APP_UID}`, '/data']);

    const runContainer = () =>
      docker([
        'run', '-d', '--name', NAME,
        '-p', `127.0.0.1:${PORT}:3000`,
        '-e', `JWT_SECRET=${JWT_SECRET}`,
        '-e', 'LOG_LEVEL=info',
        '-e', 'TRUST_PROXY=true',
        ...mountArgs(dataDir),
        IMAGE,
      ]);

    console.log('== Container starten');
    runContainer();
    started = true;
    check('Container wird healthy erreichbar (/api/health)', await waitForHealth());

    // --- Non-Root & Rechte -------------------------------------------------
    const uid = docker(['exec', NAME, 'id', '-u']).stdout;
    check('Container läuft als Non-Root (UID 10001)', uid === APP_UID, `uid=${uid}`);
    const dbOwner = docker(['exec', NAME, 'stat', '-c', '%u', '/data/bibliolisa.sqlite'], { allowFail: true }).stdout;
    check('/data/bibliolisa.sqlite gehört UID 10001', dbOwner === APP_UID, `owner=${dbOwner}`);
    const coversOwner = docker(['exec', NAME, 'stat', '-c', '%u', '/data/covers'], { allowFail: true }).stdout;
    check('/data/covers gehört UID 10001', coversOwner === APP_UID, `owner=${coversOwner}`);
    const hc = docker(['inspect', '--format', '{{json .Config.Healthcheck}}', NAME]).stdout;
    check('HEALTHCHECK ist im Image konfiguriert', hc !== 'null' && hc.includes('api/health'), hc);
    const ports = docker(['port', NAME, '3000/tcp']).stdout;
    check('Port nur auf Loopback/High-Port gebunden (nicht 80/443)', !/:(80|443)$/m.test(ports), ports);

    // --- Webapp & Routing ----------------------------------------------------
    const root = await fetch(`${BASE}/`);
    const html = await root.text();
    check('GET / liefert HTML der Webapp', root.status === 200 && (root.headers.get('content-type') ?? '').includes('text/html') && html.includes('id="root"'));
    check('index.html ist no-cache', (root.headers.get('cache-control') ?? '').includes('no-cache'));

    const spa = await fetch(`${BASE}/books/00000000-0000-4000-8000-000000000000`);
    check('SPA-Fallback liefert index.html für Client-Routen', spa.status === 200 && (await spa.text()).includes('id="root"'));

    const assetMatch = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html);
    if (assetMatch) {
      const asset = await fetch(`${BASE}${assetMatch[1]}`);
      check('Hash-Asset wird immutable ausgeliefert', asset.status === 200 && (asset.headers.get('cache-control') ?? '').includes('immutable'), `${asset.status}`);
    } else {
      check('Hash-Asset im index.html gefunden', false, 'kein /assets/*.js Verweis');
    }

    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('/api/health liefert status=ok', health.status === 'ok', JSON.stringify(health));
    const unauth = await fetch(`${BASE}/api/library`);
    check('/api/library ohne Token -> 401', unauth.status === 401);

    // --- Reverse-Proxy-Header ---------------------------------------------------
    const credentials = { username: 'smokeuser', password: 'Smoke-Test-Passw0rd!', clientType: 'web' };
    const proxied = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.5',
        'x-forwarded-host': 'books.example.test',
      },
      body: JSON.stringify(credentials),
    });
    check('Registrierung über simulierten Proxy -> 201', proxied.status === 201, `${proxied.status}`);
    const proxiedCookies = parseSetCookies(proxied);
    const refresh = proxiedCookies.get('bibliolisa_refresh');
    const media = proxiedCookies.get('bibliolisa_media');
    check('X-Forwarded-Proto: https -> Refresh-Cookie ist Secure+HttpOnly+SameSite=Lax', refresh && hasFlag(refresh.raw, 'Secure') && hasFlag(refresh.raw, 'HttpOnly') && /SameSite=Lax/i.test(refresh.raw), refresh?.raw);
    check('X-Forwarded-Proto: https -> Media-Cookie ist Secure+HttpOnly', media && hasFlag(media.raw, 'Secure') && hasFlag(media.raw, 'HttpOnly'), media?.raw);
    const registered = await proxied.json();
    const token = registered.accessToken;

    const direct = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, username: 'smokeuser2' }),
    });
    const directRefresh = parseSetCookies(direct).get('bibliolisa_refresh');
    const reg2Body = await direct.json();
    const token2 = reg2Body.accessToken;
    check('Direkter HTTP-Zugriff (LAN) -> Cookie ohne Secure-Flag', direct.status === 201 && directRefresh && !hasFlag(directRefresh.raw, 'Secure'), directRefresh?.raw);

    // --- Buch + Cover ----------------------------------------------------------
    const authHeaders = { authorization: `Bearer ${token}` };
    const created = await fetch(`${BASE}/api/library`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'reading',
        rating: 4,
        book: { title: 'Smoke-Test-Buch', authors: ['Tester'], seriesName: 'Smoke', seriesNumber: 1.5 },
      }),
    });
    const entry = await created.json();
    check('Buch anlegen -> 201 (Reihe, Dezimalband 1,5)', created.status === 201 && entry.book?.seriesNumber === 1.5, `${created.status}`);

    const form = new FormData();
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'cover.png');
    const upload = await fetch(`${BASE}/api/books/${entry.bookId}/cover`, { method: 'POST', headers: authHeaders, body: form });
    const uploaded = await upload.json();
    check('Cover-Upload -> 200 mit coverKey (*.webp)', upload.status === 200 && /^[a-f0-9]{24}\.webp$/.test(uploaded.coverKey ?? ''), JSON.stringify(uploaded));
    const coverKey = uploaded.coverKey;

    const mediaCookie = `bibliolisa_media=${media?.value ?? ''}`;
    const coverOk = await fetch(`${BASE}/api/covers/${coverKey}`, { headers: { cookie: mediaCookie } });
    check('Cover mit Media-Cookie (wie <img> in der Web-UI) -> 200 image/webp', coverOk.status === 200 && (coverOk.headers.get('content-type') ?? '').includes('image/webp'), `${coverOk.status}`);
    const coverDenied = await fetch(`${BASE}/api/covers/${coverKey}`);
    check('Cover ohne Authentifizierung -> 401', coverDenied.status === 401, `${coverDenied.status}`);
    const apiNotFound = await fetch(`${BASE}/api/gibt-es-nicht`, { headers: authHeaders });
    check('Unbekannter /api/*-Pfad -> JSON 404 (kein index.html)', apiNotFound.status === 404 && (apiNotFound.headers.get('content-type') ?? '').includes('application/json'));

    const coverFileOnHost = fs.existsSync(path.join(dataDir, 'covers', coverKey));
    check('Cover-Datei liegt im gemounteten Host-Verzeichnis (covers/)', coverFileOnHost);
    check('SQLite-Datei liegt im gemounteten Host-Verzeichnis', fs.existsSync(path.join(dataDir, 'bibliolisa.sqlite')));

    // --- Phase 5: Mobile Auth, Bearer-Cover, Delta-Sync, LWW-Konflikt & 2-User-Isolation ---
    const mobileLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        clientType: 'mobile',
        deviceId: 'smoke-android-1',
        deviceName: 'Smoke Android',
      }),
    });
    const mobileLoginBody = await mobileLogin.json();
    check(
      'Mobiler Login -> 200 mit accessToken & refreshToken',
      mobileLogin.status === 200 && Boolean(mobileLoginBody.accessToken) && Boolean(mobileLoginBody.refreshToken),
      `${mobileLogin.status}`
    );

    const mobileRefresh = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: mobileLoginBody.refreshToken, clientType: 'mobile' }),
    });
    const mobileRefreshed = await mobileRefresh.json();
    const mobileToken = mobileRefreshed.accessToken;
    check(
      'Mobile Refresh-Token-Rotation -> 200 mit neuem Token-Paar',
      mobileRefresh.status === 200 &&
        Boolean(mobileToken) &&
        Boolean(mobileRefreshed.refreshToken) &&
        mobileRefreshed.refreshToken !== mobileLoginBody.refreshToken,
      `${mobileRefresh.status}`
    );

    const mobileBearerCover = await fetch(`${BASE}/api/covers/${coverKey}`, {
      headers: { authorization: `Bearer ${mobileToken}` },
    });
    check(
      'Cover-Download per Bearer-Auth (Android) -> 200 image/webp',
      mobileBearerCover.status === 200 &&
        (mobileBearerCover.headers.get('content-type') ?? '').includes('image/webp'),
      `${mobileBearerCover.status}`
    );

    const tInitial = new Date(Date.now() - 10_000).toISOString();
    const tStale = new Date(Date.now() - 5_000).toISOString();
    const syncBookId = randomUUID();
    const syncUbId = randomUUID();

    const syncRes1 = await fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mobileToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'smoke-android-1',
        cursor: null,
        clientTime: new Date().toISOString(),
        limit: 100,
        changes: {
          books: [
            {
              id: syncBookId,
              title: 'Sync-Test-Buch',
              subtitle: null,
              authors: ['Mobile Tester'],
              seriesName: 'Smoke',
              seriesNumber: 2.5,
              isbn10: null,
              isbn13: null,
              pageCount: 280,
              publishedYear: 2026,
              genres: ['Science-Fiction'],
              description: null,
              coverKey: null,
              coverSourceUrl: null,
              language: 'de',
              publisher: null,
              metadataSource: 'manual',
              metadataExternalId: null,
              createdAt: tInitial,
              updatedAt: tInitial,
              deletedAt: null,
            },
          ],
          userBooks: [
            {
              id: syncUbId,
              bookId: syncBookId,
              status: 'unread',
              rating: null,
              notes: 'Offline erfasst',
              addedAt: tInitial,
              startedAt: null,
              finishedAt: null,
              createdAt: tInitial,
              updatedAt: tInitial,
              deletedAt: null,
            },
          ],
        },
      }),
    });
    const syncBody1 = await syncRes1.json();
    check(
      'Delta-Sync Push + Pull -> 200 (Offline-Buch akzeptiert, Web-Buch gepullt)',
      syncRes1.status === 200 &&
        syncBody1.pushResults?.books?.[0]?.status === 'accepted' &&
        syncBody1.pushResults?.userBooks?.[0]?.status === 'accepted' &&
        syncBody1.pull?.books?.some((b) => b.id === entry.bookId),
      `${syncRes1.status}`
    );

    const webLibSeries = await (
      await fetch(`${BASE}/api/library?sort=series&order=asc`, { headers: authHeaders })
    ).json();
    const seriesNums = (webLibSeries.items ?? []).map((item) => item.book?.seriesNumber);
    check(
      'Web-API sieht gepushtes Mobile-Buch in korrekter Reihen-Sortierung [1.5, 2.5]',
      seriesNums.length === 2 && seriesNums[0] === 1.5 && seriesNums[1] === 2.5,
      JSON.stringify(seriesNums)
    );

    // Neuerer Edit in der Web-UI -> älterer Push von Android muss conflict_server_won liefern
    const webPatch = await fetch(`${BASE}/api/library/${syncUbId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'read', rating: 5, notes: 'Web-Sieger' }),
    });
    check('Web-Update auf gesynctes Buch -> 200', webPatch.status === 200, `${webPatch.status}`);

    const syncConflict = await fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mobileToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'smoke-android-1',
        cursor: syncBody1.nextCursor,
        clientTime: new Date().toISOString(),
        limit: 100,
        changes: {
          books: [],
          userBooks: [
            {
              id: syncUbId,
              bookId: syncBookId,
              status: 'abandoned',
              rating: 2,
              notes: 'Veralteter Offline-Edit',
              addedAt: tInitial,
              startedAt: null,
              finishedAt: null,
              createdAt: tInitial,
              updatedAt: tStale,
              deletedAt: null,
            },
          ],
        },
      }),
    });
    const syncConflictBody = await syncConflict.json();
    check(
      'LWW-Konflikt -> conflict_server_won + autoritativer Web-Stand im Pull',
      syncConflict.status === 200 &&
        syncConflictBody.pushResults?.userBooks?.[0]?.status === 'conflict_server_won' &&
        syncConflictBody.pull?.userBooks?.some(
          (ub) => ub.id === syncUbId && ub.notes === 'Web-Sieger' && ub.status === 'read'
        ),
      JSON.stringify(syncConflictBody.pushResults)
    );

    // 2-User-Isolation im Sync
    const user2Sync = await fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token2}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'smoke-android-user2',
        cursor: null,
        clientTime: new Date().toISOString(),
        limit: 100,
        changes: {
          books: [],
          userBooks: [
            {
              id: syncUbId,
              bookId: syncBookId,
              status: 'reading',
              rating: 1,
              notes: 'Cross-User Versuch',
              addedAt: tInitial,
              startedAt: null,
              finishedAt: null,
              createdAt: tInitial,
              updatedAt: new Date().toISOString(),
              deletedAt: null,
            },
          ],
        },
      }),
    });
    const user2SyncBody = await user2Sync.json();
    check(
      '2-User-Isolation im Sync -> User 2 pullt 0 fremde Bücher & Cross-User-Push rejected',
      user2Sync.status === 200 &&
        user2SyncBody.pull?.books?.length === 0 &&
        user2SyncBody.pull?.userBooks?.length === 0 &&
        user2SyncBody.pushResults?.userBooks?.[0]?.status === 'rejected',
      JSON.stringify(user2SyncBody)
    );

    // --- Neustart: Persistenz ----------------------------------------------------
    console.log('== Container neu starten');
    docker(['restart', NAME]);
    check('Nach Neustart wieder erreichbar', await waitForHealth());

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    check('Login nach Neustart (Benutzer persistiert)', login.status === 200, `${login.status}`);
    const loginBody = await login.json();
    const libraryAfter = await fetch(`${BASE}/api/library?sort=series&order=asc`, {
      headers: { authorization: `Bearer ${loginBody.accessToken}` },
    });
    const libraryJson = await libraryAfter.json();
    const persisted = libraryJson.items?.find((item) => item.book?.title === 'Smoke-Test-Buch');
    const persistedSynced = libraryJson.items?.find((item) => item.book?.title === 'Sync-Test-Buch');
    check('Buch, Bewertung und Reihe nach Neustart vorhanden', persisted && persisted.rating === 4 && persisted.book.seriesNumber === 1.5);
    check(
      'Per Sync erfasstes Buch (Band 2,5) & LWW-Siegerstand nach Neustart erhalten',
      persistedSynced &&
        persistedSynced.book.seriesNumber === 2.5 &&
        persistedSynced.status === 'read' &&
        persistedSynced.notes === 'Web-Sieger'
    );
    check('Cover-Key nach Neustart am Buch vorhanden', persisted?.book?.coverKey === coverKey);
    const loginMedia = parseSetCookies(login).get('bibliolisa_media');
    const coverAfter = await fetch(`${BASE}/api/covers/${coverKey}`, { headers: { cookie: `bibliolisa_media=${loginMedia?.value ?? ''}` } });
    check('Cover nach Neustart weiterhin abrufbar', coverAfter.status === 200, `${coverAfter.status}`);

    const logs = docker(['logs', NAME], { allowFail: true });
    const allLogs = `${logs.stdout}\n${logs.stderr}`;
    check('Keine SQLite-/Rechte-Fehler in den Container-Logs', !/SQLITE_CANTOPEN|EACCES|EPERM|readonly database/i.test(allLogs));
  } catch (error) {
    check('Smoke-Test ohne unerwartete Ausnahme', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (started) {
      const logs = docker(['logs', '--tail', '30', NAME], { allowFail: true });
      if (results.some((r) => !r.ok)) {
        console.log('\n--- letzte Container-Logs ---\n' + logs.stdout + logs.stderr);
      }
    }
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden.`);
  if (failed.length > 0) {
    console.error('Fehlgeschlagen:\n' + failed.map((f) => ` - ${f.name}`).join('\n'));
    process.exit(1);
  }
}

await main();
