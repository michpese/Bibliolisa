import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';

const BASE_ENV = parseEnv({
  DATA_DIR: './tmp-static-test',
  JWT_SECRET: 'static-test-secret-with-at-least-32-characters-1',
  LOG_LEVEL: 'silent',
});

let webDir: string;

beforeAll(() => {
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-web-'));
  fs.mkdirSync(path.join(webDir, 'assets'));
  fs.writeFileSync(
    path.join(webDir, 'index.html'),
    '<!doctype html><html><body><div id="root">Bibliolisa</div></body></html>'
  );
  fs.writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1);');
});

afterAll(() => {
  fs.rmSync(webDir, { recursive: true, force: true });
});

function cookieHeaders(raw: string | string[] | number | undefined): string[] {
  if (raw === undefined || typeof raw === 'number') return [];
  return Array.isArray(raw) ? raw : [raw];
}

describe('Webapp-Auslieferung, SPA-Fallback & Reverse-Proxy-Header', () => {
  it('liefert index.html auf / und im SPA-Fallback, Assets cachebar und /api/* strikt als JSON-404', async () => {
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      logger: false,
      webDir,
    });

    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.body).toContain('Bibliolisa');
      expect(root.headers['cache-control']).toBe('no-cache');

      const spa = await app.inject({ method: 'GET', url: '/library/some-id?x=1' });
      expect(spa.statusCode).toBe(200);
      expect(spa.headers['content-type']).toContain('text/html');
      expect(spa.body).toContain('id="root"');

      const asset = await app.inject({
        method: 'GET',
        url: '/assets/app-abc123.js',
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');

      const missingAsset = await app.inject({
        method: 'GET',
        url: '/assets/missing.js',
      });
      expect(missingAsset.statusCode).toBe(404);

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe('ok');

      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'staticuser',
          password: 'Password123!',
          clientType: 'web',
        },
      });
      expect(reg.statusCode).toBe(201);
      const token = reg.json().accessToken as string;

      const unknownApi = await app.inject({
        method: 'GET',
        url: '/api/does-not-exist',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.headers['content-type']).toContain('application/json');
      expect(unknownApi.json().error.code).toBe('NOT_FOUND');

      const unauthenticatedApi = await app.inject({
        method: 'GET',
        url: '/api/library',
      });
      expect(unauthenticatedApi.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('setzt das Secure-Flag der Auth-Cookies nur bei X-Forwarded-Proto: https', async () => {
    const { app } = await buildApp({
      env: BASE_ENV,
      dbPath: ':memory:',
      logger: false,
      webDir,
    });

    try {
      const plain = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'plainuser', password: 'Password123!', clientType: 'web' },
      });
      expect(plain.statusCode).toBe(201);
      const plainCookies = cookieHeaders(plain.headers['set-cookie']);
      expect(plainCookies.length).toBeGreaterThanOrEqual(2);
      for (const cookie of plainCookies) {
        expect(cookie).toContain('HttpOnly');
        expect(cookie).not.toMatch(/;\s*Secure/i);
      }

      const proxied = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '203.0.113.7',
          'x-forwarded-host': 'books.example.test',
        },
        payload: { username: 'plainuser', password: 'Password123!', clientType: 'web' },
      });
      expect(proxied.statusCode).toBe(200);
      const proxiedCookies = cookieHeaders(proxied.headers['set-cookie']);
      expect(proxiedCookies.length).toBeGreaterThanOrEqual(2);
      for (const cookie of proxiedCookies) {
        expect(cookie).toMatch(/;\s*Secure/i);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toMatch(/SameSite=Lax/i);
      }
      expect(proxiedCookies.some((c) => c.startsWith('bibliolisa_refresh='))).toBe(true);
      expect(proxiedCookies.some((c) => c.startsWith('bibliolisa_media='))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
