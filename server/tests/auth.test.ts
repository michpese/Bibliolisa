import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { hashPassword, verifyPassword } from '../src/services/auth.service.js';

const BASE_ENV = parseEnv({
  PORT: '3000',
  HOST: '127.0.0.1',
  DATA_DIR: './tmp-unused',
  JWT_SECRET: 'test-jwt-secret-with-at-least-32-characters-12345',
  TRUST_PROXY: 'true',
  ALLOW_REGISTRATION: 'true',
  LOG_LEVEL: 'silent',
});

function extractCookies(setCookieHeader: string | string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!setCookieHeader) return result;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    const firstPart = raw.split(';')[0];
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      result.set(name, value);
    }
  }
  return result;
}

describe('Auth, Config & Sicherheit', () => {
  it('validiert Umgebungsvariablen strikt inklusive Bool-Parsing und JWT_SECRET-Länge', () => {
    expect(() =>
      parseEnv({
        JWT_SECRET: 'zu-kurz',
      })
    ).toThrow();

    const parsed = parseEnv({
      JWT_SECRET: 'a'.repeat(32),
      TRUST_PROXY: 'false',
      ALLOW_REGISTRATION: 'false',
    });
    expect(parsed.TRUST_PROXY).toBe(false);
    expect(parsed.ALLOW_REGISTRATION).toBe(false);
  });

  it('hasht und verifiziert Passwörter mit scrypt (N=32768,r=8,p=1,maxmem=64MiB) und timingSafeEqual', async () => {
    const hash = await hashPassword('MeinGeheimesPasswort!123');
    expect(hash.startsWith('$scrypt$n=32768,r=8,p=1$')).toBe(true);
    expect(await verifyPassword('MeinGeheimesPasswort!123', hash)).toBe(true);
    expect(await verifyPassword('FalschesPasswort', hash)).toBe(false);
    expect(await verifyPassword('x', 'invalid-format')).toBe(false);
  });

  it('schützt alle API-Routen außer /api/health, login, register, refresh strikt mit 401', async () => {
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json()).toMatchObject({
        status: 'ok',
        allowRegistration: true,
        providers: {
          openLibrary: true,
          googleBooks: true,
          hardcover: false,
        },
      });

      const protectedRequests = [
        { method: 'GET' as const, url: '/api/auth/me' },
        { method: 'GET' as const, url: '/api/auth/sessions' },
        { method: 'POST' as const, url: '/api/auth/logout' },
        { method: 'POST' as const, url: '/api/auth/change-password' },
        { method: 'GET' as const, url: '/api/library' },
        { method: 'GET' as const, url: '/api/library/facets' },
        { method: 'POST' as const, url: '/api/library' },
        { method: 'GET' as const, url: '/api/unbekannter-pfad' },
      ];

      for (const req of protectedRequests) {
        const res = await app.inject(req);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHORIZED');
      }
    } finally {
      await app.close();
    }
  });

  it('vergibt dem ersten Benutzer die Admin-Rolle und respektiert ALLOW_REGISTRATION=false', async () => {
    const envNoReg = { ...BASE_ENV, ALLOW_REGISTRATION: false };
    const { app } = await buildApp({
      env: envNoReg,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      // Vor erstem User ist Registrierung trotz ALLOW_REGISTRATION=false erlaubt
      const healthBefore = await app.inject({ method: 'GET', url: '/api/health' });
      expect(healthBefore.json().allowRegistration).toBe(true);

      const firstRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'AdminUser',
          password: 'Password123!',
          email: 'admin@example.com',
          clientType: 'mobile',
        },
      });
      expect(firstRes.statusCode).toBe(201);
      expect(firstRes.json().user.role).toBe('admin');

      const healthAfter = await app.inject({ method: 'GET', url: '/api/health' });
      expect(healthAfter.json().allowRegistration).toBe(false);

      const secondRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'SecondUser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      expect(secondRes.statusCode).toBe(403);
      expect(secondRes.json().error.code).toBe('REGISTRATION_DISABLED');
    } finally {
      await app.close();
    }
  });

  it('setzt Web-Cookies inklusive bibliolisa_media, respektiert X-Forwarded-Proto und erneuert bibliolisa_media bei /refresh', async () => {
    let currentMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app, authService } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(currentMs),
      logger: false,
    });

    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: {
          'x-forwarded-proto': 'https',
        },
        payload: {
          username: 'webuser',
          password: 'Password123!',
          clientType: 'web',
          deviceName: 'Firefox Desktop',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const regBody = regRes.json();
      expect(regBody.refreshToken).toBeUndefined();
      expect(typeof regBody.accessToken).toBe('string');

      const regSetCookies = regRes.headers['set-cookie'];
      const regCookies = extractCookies(regSetCookies);
      const initialRefresh = regCookies.get('bibliolisa_refresh');
      const initialMedia = regCookies.get('bibliolisa_media');
      expect(initialRefresh).toBeTruthy();
      expect(initialMedia).toBeTruthy();

      // Prüfe HttpOnly, SameSite=Lax, Pfade und dynamisches Secure-Flag bei https
      const cookieList = Array.isArray(regSetCookies) ? regSetCookies : [String(regSetCookies)];
      const refreshCookieStr = cookieList.find((c) => c.startsWith('bibliolisa_refresh='));
      const mediaCookieStr = cookieList.find((c) => c.startsWith('bibliolisa_media='));
      expect(refreshCookieStr).toContain('Path=/api/auth');
      expect(refreshCookieStr).toContain('HttpOnly');
      expect(refreshCookieStr).toContain('SameSite=Lax');
      expect(refreshCookieStr).toContain('Secure');
      expect(mediaCookieStr).toContain('Path=/api/covers');
      expect(mediaCookieStr).toContain('HttpOnly');
      expect(mediaCookieStr).toContain('SameSite=Lax');
      expect(mediaCookieStr).toContain('Secure');

      // Ohne https darf kein Secure-Flag gesetzt sein
      const httpLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'WEBUSER', // COLLATE NOCASE
          password: 'Password123!',
          clientType: 'web',
        },
      });
      expect(httpLoginRes.statusCode).toBe(200);
      const httpCookieStr = String(httpLoginRes.headers['set-cookie']);
      expect(httpCookieStr).not.toContain('Secure');

      // Zeit um 60s vorstellen und Web-Refresh durchführen -> muss BEIDE Cookies erneuern
      currentMs += 60_000;
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: {
          'x-forwarded-proto': 'https',
          cookie: `bibliolisa_refresh=${initialRefresh}`,
        },
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshedCookies = extractCookies(refreshRes.headers['set-cookie']);
      const newRefresh = refreshedCookies.get('bibliolisa_refresh');
      const newMedia = refreshedCookies.get('bibliolisa_media');

      expect(newRefresh).toBeTruthy();
      expect(newRefresh).not.toBe(initialRefresh);
      expect(newMedia).toBeTruthy();
      expect(newMedia).not.toBe(initialMedia);

      const mediaClaims = await authService.verifyMediaToken(newMedia!);
      expect(mediaClaims).toEqual({
        sub: regBody.user.id,
        scope: 'media:read',
      });

      // Authentifizierter Aufruf auf unbekannten /api/*-Pfad liefert 404 JSON
      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/unknown-route',
        headers: {
          authorization: `Bearer ${refreshRes.json().accessToken}`,
        },
      });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('unterstützt 30s Grace-Window bei Refresh-Rotation und widerruft Session-Kette bei spätem Replay', async () => {
    let currentMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      now: () => new Date(currentMs),
      logger: false,
    });

    try {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'mobileuser',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: 'pixel-9',
          deviceName: 'Pixel 9',
        },
      });
      const r1 = regRes.json().refreshToken as string;
      expect(r1).toBeTruthy();

      // Erste reguläre Rotation R1 -> R2
      const rot1 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: r1, clientType: 'mobile' },
      });
      expect(rot1.statusCode).toBe(200);
      const r2 = rot1.json().refreshToken as string;
      expect(r2).not.toBe(r1);

      // Einmaliger Retry von R1 innerhalb von 30s (t + 15s) -> akzeptiert (liefert R3)
      currentMs += 15_000;
      const graceRetry = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: r1, clientType: 'mobile' },
      });
      expect(graceRetry.statusCode).toBe(200);
      const r3 = graceRetry.json().refreshToken as string;
      expect(r3).not.toBe(r2);

      // Spätes Replay nach Ablauf des 30s-Fensters (R3 -> R4, dann t + 31s Replay von R3)
      const rot3 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: r3, clientType: 'mobile' },
      });
      expect(rot3.statusCode).toBe(200);
      const r4 = rot3.json().refreshToken as string;

      currentMs += 31_000;
      const lateReplay = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: r3, clientType: 'mobile' },
      });
      expect(lateReplay.statusCode).toBe(401);
      expect(lateReplay.json().error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');

      // Gesamte Session-Kette (inkl. aktuellem R4) muss widerrufen sein
      const followUpR4 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: r4, clientType: 'mobile' },
      });
      expect(followUpR4.statusCode).toBe(401);
      expect(followUpR4.json().error.code).toBe('REFRESH_TOKEN_REVOKED');
    } finally {
      await app.close();
    }
  });

  it('verwaltet Sessions mandantenisoliert, ändert Passwort sicher, loggt aus und erzwingt Rate-Limiting', async () => {
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      authRateLimitMax: 5,
      logger: false,
    });

    try {
      // User A registriert Web- & Mobile-Session
      const regA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'alice',
          password: 'Password123!',
          clientType: 'web',
          deviceName: 'Alice Browser',
        },
      });
      const aliceToken = regA.json().accessToken as string;
      const aliceCookie = extractCookies(regA.headers['set-cookie']).get(
        'bibliolisa_refresh'
      )!;

      const loginAMobile = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'alice',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: 'alice-phone',
          deviceName: 'Alice Phone',
        },
      });
      const aliceMobileRefresh = loginAMobile.json().refreshToken as string;

      // User B registrieren
      const regB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'bob',
          password: 'Password123!',
          clientType: 'mobile',
          deviceId: 'bob-phone',
        },
      });
      const bobToken = regB.json().accessToken as string;

      // /api/auth/me & Sessions-Liste prüfen
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().username).toBe('alice');

      const sessionsRes = await app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          cookie: `bibliolisa_refresh=${aliceCookie}`,
        },
      });
      expect(sessionsRes.statusCode).toBe(200);
      const aliceSessions = sessionsRes.json().sessions as Array<{
        id: string;
        clientType: string;
        isCurrent: boolean;
      }>;
      expect(aliceSessions).toHaveLength(2);
      expect(aliceSessions.find((s) => s.clientType === 'web')?.isCurrent).toBe(true);
      const mobileSession = aliceSessions.find((s) => s.clientType === 'mobile')!;
      expect(mobileSession.isCurrent).toBe(false);

      // User B darf Session von User A nicht widerrufen -> 404
      const bobRevokeAlice = await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${mobileSession.id}`,
        headers: { authorization: `Bearer ${bobToken}` },
      });
      expect(bobRevokeAlice.statusCode).toBe(404);

      // User A widerruft eigene Mobile-Session -> Refresh scheitert
      const aliceRevokeMobile = await app.inject({
        method: 'DELETE',
        url: `/api/auth/sessions/${mobileSession.id}`,
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(aliceRevokeMobile.statusCode).toBe(204);

      const revokedMobileRefresh = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: aliceMobileRefresh, clientType: 'mobile' },
      });
      expect(revokedMobileRefresh.statusCode).toBe(401);

      // Passwortänderung mit falschem aktuellem Passwort -> 401
      const badPwdChange = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${aliceToken}` },
        payload: {
          currentPassword: 'WrongPassword!',
          newPassword: 'NewPassword456!',
        },
      });
      expect(badPwdChange.statusCode).toBe(401);

      // Passwortänderung erfolgreich
      const okPwdChange = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          cookie: `bibliolisa_refresh=${aliceCookie}`,
        },
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'NewPassword456!',
          revokeOtherSessions: true,
        },
      });
      expect(okPwdChange.statusCode).toBe(204);

      // Logout widerruft aktuelles Refresh Token und löscht Cookies
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          cookie: `bibliolisa_refresh=${aliceCookie}`,
        },
      });
      expect(logoutRes.statusCode).toBe(204);
      const logoutCookies = extractCookies(logoutRes.headers['set-cookie']);
      expect(logoutCookies.get('bibliolisa_refresh')).toBe('');
      expect(logoutCookies.get('bibliolisa_media')).toBe('');

      // Rate-Limit via X-Forwarded-For (max 5 in diesem Test)
      for (let i = 0; i < 5; i++) {
        const attempt = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': '203.0.113.55' },
          payload: {
            username: 'alice',
            password: 'WrongPassword!',
            clientType: 'mobile',
          },
        });
        expect(attempt.statusCode).toBe(401);
      }

      const rateLimited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.55' },
        payload: {
          username: 'alice',
          password: 'NewPassword456!',
          clientType: 'mobile',
        },
      });
      expect(rateLimited.statusCode).toBe(429);
      expect(rateLimited.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });

  it('bereinigt abgelaufene sowie alte widerrufene Refresh Tokens und begrenzt /api/auth/refresh per Rate-Limit', async () => {
    let currentMs = Date.parse('2026-11-21T10:00:00.000Z');
    const { app, authService, dbCtx } = await buildApp({
      env: { ...BASE_ENV, ALLOW_REGISTRATION: false },
      dbPath: ':memory:',
      authRateLimitMax: 2,
      now: () => new Date(currentMs),
      logger: false,
    });

    try {
      const regAdmin = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'admin1',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      expect(regAdmin.statusCode).toBe(201);
      const refreshToken = regAdmin.json().refreshToken as string;

      // Registrierung bei ALLOW_REGISTRATION=false lehnt sofort vor scrypt ab
      const regBlocked = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'blockeduser',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      expect(regBlocked.statusCode).toBe(403);
      expect(regBlocked.json().error.code).toBe('REGISTRATION_DISABLED');

      // Zusätzliches abgelaufenes Token und altes widerrufenes Token einfügen
      const userId = regAdmin.json().user.id as string;
      dbCtx.sqlite
        .prepare(
          `INSERT INTO refresh_tokens (id, user_id, token_hash, client_type, expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, 'mobile', ?, NULL, ?)`
        )
        .run(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          userId,
          'expired-hash',
          '2026-11-20T10:00:00.000Z',
          '2026-10-01T10:00:00.000Z'
        );
      dbCtx.sqlite
        .prepare(
          `INSERT INTO refresh_tokens (id, user_id, token_hash, client_type, expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, 'mobile', ?, ?, ?)`
        )
        .run(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          userId,
          'old-revoked-hash',
          '2027-11-20T10:00:00.000Z',
          '2026-11-10T10:00:00.000Z',
          '2026-11-01T10:00:00.000Z'
        );

      const pruned = authService.pruneExpiredAndRevokedTokens(7);
      expect(pruned).toBe(2);

      const remaining = dbCtx.sqlite
        .prepare('SELECT COUNT(*) AS cnt FROM refresh_tokens')
        .get() as { cnt: number };
      expect(remaining.cnt).toBe(1);

      // /api/auth/refresh Rate-Limit: authRateLimitMax=2 => max 6/min
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          headers: { 'x-forwarded-for': '203.0.113.77' },
          payload: { refreshToken: `invalid-${i}`, clientType: 'mobile' },
        });
        expect(res.statusCode).toBe(401);
      }

      const limitedRefresh = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { 'x-forwarded-for': '203.0.113.77' },
        payload: { refreshToken, clientType: 'mobile' },
      });
      expect(limitedRefresh.statusCode).toBe(429);
      expect(limitedRefresh.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});
