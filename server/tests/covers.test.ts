import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import type { FetchLike } from '../src/metadata/types.js';
import {
  isBlockedIpAddress,
  pinnedHttpDownload,
} from '../src/services/cover.service.js';

const tempDirs: string[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-covers-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function buildMultipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  data: Buffer
): { payload: Buffer; contentTypeHeader: string } {
  const boundary = '----BibliolisaTestBoundary7d9e1f';
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([preamble, data, epilogue]),
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
  };
}

function extractCookieValue(
  setCookieHeader: string | string[] | undefined,
  cookieName: string
): string | undefined {
  if (!setCookieHeader) return undefined;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    const first = raw.split(';')[0];
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq > 0 && first.slice(0, eq).trim() === cookieName) {
      return first.slice(eq + 1).trim();
    }
  }
  return undefined;
}

describe('Cover-Cache, SSRF-Schutz, WebP-Verarbeitung & Media-Auth', () => {
  it('blockiert alle privaten, Loopback-, Link-Local-, NAT64- und IPv4-mapped IP-Adressen', () => {
    const blocked = [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '10.255.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456:789a::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
      '64:ff9b::10.0.0.1',
    ];
    for (const ip of blocked) {
      expect(isBlockedIpAddress(ip)).toBe(true);
    }

    const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'];
    for (const ip of allowed) {
      expect(isBlockedIpAddress(ip)).toBe(false);
    }
  });

  it('blockiert SSRF-Ziele (127.0.0.1, 169.254.169.254, 10.0.0.1, DNS-Rebinding, Redirects, >3 Hops, >10MB) und Path Traversal', async () => {
    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'cover-ssrf-test-secret-with-at-least-32-chars',
      LOG_LEVEL: 'silent',
    });

    const samplePng = await sharp({
      create: {
        width: 1200,
        height: 1800,
        channels: 3,
        background: { r: 20, g: 90, b: 180 },
      },
    })
      .png()
      .toBuffer();

    const coverFetchMock: FetchLike = async (input) => {
      const url = String(input);
      if (url === 'https://cdn.example.org/redirect-to-meta.jpg') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      if (url === 'https://cdn.example.org/bad-redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://[invalid' },
        });
      }
      if (url.startsWith('https://cdn.example.org/hop-')) {
        const hopNum = Number(url.split('hop-')[1]);
        return new Response(null, {
          status: 302,
          headers: { location: `https://cdn.example.org/hop-${hopNum + 1}` },
        });
      }
      if (url === 'https://cdn.example.org/huge.jpg') {
        return new Response(new Uint8Array(10 * 1024 * 1024 + 1024), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (url === 'https://cdn.example.org/valid-cover.png') {
        return new Response(new Uint8Array(samplePng), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unerwarteter Fetch-Aufruf auf ${url}`);
    };

    const { app } = await buildApp({
      env,
      dbPath: ':memory:',
      coverFetch: coverFetchMock,
      coverDnsLookup: async (hostname) => {
        if (hostname === 'rebind.evil.test') {
          return [{ address: '10.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
      logger: false,
    });

    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'covertester',
          password: 'Password123!',
          clientType: 'web',
        },
      });
      const token = reg.json().accessToken as string;
      const mediaCookie = extractCookieValue(
        reg.headers['set-cookie'],
        'bibliolisa_media'
      );
      expect(mediaCookie).toBeTruthy();

      const createBookRes = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          book: {
            title: 'Cover Test Buch',
            authors: ['Test Autor'],
          },
        },
      });
      const bookId = createBookRes.json().bookId as string;

      // SSRF-URLs blockieren (inkl. 127.0.0.1, 169.254.169.254, 10.0.0.1, DNS auf 10.0.0.1, Redirect auf Metadata)
      const ssrfUrls = [
        'http://127.0.0.1/cover.jpg',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/internal.png',
        'http://172.16.5.4/internal.png',
        'http://192.168.178.1/router.png',
        'http://[::1]/loopback.png',
        'http://[::ffff:127.0.0.1]/mapped.png',
        'http://localhost:8080/local.png',
        'file:///etc/passwd',
        'https://rebind.evil.test/cover.jpg',
        'https://cdn.example.org/redirect-to-meta.jpg',
      ];

      for (const badUrl of ssrfUrls) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/books/${bookId}/cover/fetch`,
          headers: { authorization: `Bearer ${token}` },
          payload: { url: badUrl },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('SSRF_BLOCKED');
      }

      // Ungültiger Redirect-Location-Header liefert 502 (kein 500-Crash)
      const badRedirect = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId}/cover/fetch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { url: 'https://cdn.example.org/bad-redirect' },
      });
      expect(badRedirect.statusCode).toBe(502);
      expect(badRedirect.json().error.code).toBe('COVER_FETCH_FAILED');

      // > 3 Redirects ablehnen
      const tooManyRedirects = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId}/cover/fetch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { url: 'https://cdn.example.org/hop-1' },
      });
      expect(tooManyRedirects.statusCode).toBe(400);
      expect(tooManyRedirects.json().error.code).toBe('TOO_MANY_REDIRECTS');

      // > 10 MB Download-Limit ablehnen
      const tooLarge = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId}/cover/fetch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { url: 'https://cdn.example.org/huge.jpg' },
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json().error.code).toBe('COVER_TOO_LARGE');

      // Gültiger externer Fetch -> WebP unter DATA_DIR/covers/<sha256_24>.webp
      const fetchOk = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId}/cover/fetch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { url: 'https://cdn.example.org/valid-cover.png' },
      });
      expect(fetchOk.statusCode).toBe(200);
      const coverKey = fetchOk.json().coverKey as string;
      expect(coverKey).toMatch(/^[a-f0-9]{24}\.webp$/);
      expect(fetchOk.json().coverSourceUrl).toBe(
        'https://cdn.example.org/valid-cover.png'
      );

      const storedPath = path.join(dataDir, 'covers', coverKey);
      expect(fs.existsSync(storedPath)).toBe(true);
      const storedMeta = await sharp(fs.readFileSync(storedPath)).metadata();
      expect(storedMeta.format).toBe('webp');
      expect(storedMeta.width).toBeLessThanOrEqual(600);
      expect(storedMeta.height).toBeLessThanOrEqual(900);

      // GET /api/covers/:coverKey: ohne Auth 401
      const unauthCover = await app.inject({
        method: 'GET',
        url: `/api/covers/${coverKey}`,
      });
      expect(unauthCover.statusCode).toBe(401);

      // Mit Bearer Token 200
      const bearerCover = await app.inject({
        method: 'GET',
        url: `/api/covers/${coverKey}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearerCover.statusCode).toBe(200);
      expect(bearerCover.headers['content-type']).toBe('image/webp');
      expect(bearerCover.headers['cache-control']).toBe(
        'private, max-age=604800, immutable'
      );

      // Mit bibliolisa_media Cookie (für Web <img>) 200
      const cookieCover = await app.inject({
        method: 'GET',
        url: `/api/covers/${coverKey}`,
        headers: { cookie: `bibliolisa_media=${mediaCookie}` },
      });
      expect(cookieCover.statusCode).toBe(200);
      expect(cookieCover.rawPayload.equals(bearerCover.rawPayload)).toBe(true);

      // bibliolisa_media Cookie darf NICHT auf andere API-Routen zugreifen
      const mediaOnLibrary = await app.inject({
        method: 'GET',
        url: '/api/library',
        headers: { cookie: `bibliolisa_media=${mediaCookie}` },
      });
      expect(mediaOnLibrary.statusCode).toBe(401);

      // Path Traversal / ungültige Cover-Keys blockieren
      const traversalRes = await app.inject({
        method: 'GET',
        url: '/api/covers/..%2F..%2Fbibliolisa.sqlite',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(traversalRes.statusCode).toBe(400);
      expect(traversalRes.json().error.code).toBe('INVALID_COVER_KEY');

      const badKeyRes = await app.inject({
        method: 'GET',
        url: '/api/covers/invalid-key.png',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(badKeyRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('verarbeitet Multipart-Uploads via sharp, dedupliziert identische Cover und isoliert fremde Bücher', async () => {
    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'cover-upload-test-secret-minimum-32-chars-12',
      LOG_LEVEL: 'silent',
    });

    const { app } = await buildApp({
      env,
      dbPath: ':memory:',
      logger: false,
    });

    try {
      const regA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'uploaderA',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenA = regA.json().accessToken as string;

      const regB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'uploaderB',
          password: 'Password123!',
          clientType: 'mobile',
        },
      });
      const tokenB = regB.json().accessToken as string;

      const bookA1 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { book: { title: 'Buch A1', authors: ['Autor A'] } },
      });
      const bookId1 = bookA1.json().bookId as string;

      const bookA2 = await app.inject({
        method: 'POST',
        url: '/api/library',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { book: { title: 'Buch A2', authors: ['Autor A'] } },
      });
      const bookId2 = bookA2.json().bookId as string;

      const jpegBuffer = await sharp({
        create: {
          width: 800,
          height: 1000,
          channels: 3,
          background: { r: 220, g: 140, b: 40 },
        },
      })
        .jpeg({ quality: 90 })
        .toBuffer();

      const upload1 = buildMultipartBody(
        'file',
        'cover.jpg',
        'image/jpeg',
        jpegBuffer
      );
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId1}/cover`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': upload1.contentTypeHeader,
        },
        payload: upload1.payload,
      });
      expect(res1.statusCode).toBe(200);
      const key1 = res1.json().coverKey as string;
      expect(key1).toMatch(/^[a-f0-9]{24}\.webp$/);

      // Identisches Bild auf Buch 2 -> Content-Addressed Deduplizierung (derselbe Key, 1 Datei)
      const upload2 = buildMultipartBody(
        'file',
        'cover.jpg',
        'image/jpeg',
        jpegBuffer
      );
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId2}/cover`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': upload2.contentTypeHeader,
        },
        payload: upload2.payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().coverKey).toBe(key1);
      const filesInCovers = fs.readdirSync(path.join(dataDir, 'covers'));
      expect(filesInCovers).toEqual([key1]);

      // Ungültige Bytes als image/png -> 400 INVALID_IMAGE
      const invalidImg = buildMultipartBody(
        'file',
        'fake.png',
        'image/png',
        Buffer.from('not-an-image')
      );
      const badImgRes = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId1}/cover`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': invalidImg.contentTypeHeader,
        },
        payload: invalidImg.payload,
      });
      expect(badImgRes.statusCode).toBe(400);
      expect(badImgRes.json().error.code).toBe('INVALID_IMAGE');

      // Fremder User B darf kein Cover für User As Buch hochladen -> 404
      const uploadB = buildMultipartBody(
        'file',
        'cover.jpg',
        'image/jpeg',
        jpegBuffer
      );
      const forbiddenUpload = await app.inject({
        method: 'POST',
        url: `/api/books/${bookId1}/cover`,
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': uploadB.contentTypeHeader,
        },
        payload: uploadB.payload,
      });
      expect(forbiddenUpload.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('pinnt HTTP-Verbindungen via lookup auf die validierte IP (kein DNS-Rebinding) und bereinigt verwaiste Cover', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/cover.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from('pinned-ok'));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('Server address missing');
    }

    const dataDir = createTempDataDir();
    const env = parseEnv({
      DATA_DIR: dataDir,
      JWT_SECRET: 'cover-pin-test-secret-with-at-least-32-chars',
      LOG_LEVEL: 'silent',
    });

    try {
      // Unauflösbarer Hostname wird ohne erneuten DNS-Lookup direkt über die gepinnte IP bedient
      const controller = new AbortController();
      const result = await pinnedHttpDownload({
        url: new URL(
          `http://definitely-not-resolvable.invalid:${addr.port}/cover.png`
        ),
        address: '127.0.0.1',
        family: 4,
        maxDownloadBytes: 1024 * 1024,
        signal: controller.signal,
        userAgent: 'Bibliolisa-Test/0.1.0',
      });
      expect(result).toEqual({
        kind: 'ok',
        buffer: Buffer.from('pinned-ok'),
      });

      // Verwaiste Cover-Bereinigung prüfen
      const { app, coverService } = await buildApp({
        env,
        dbPath: ':memory:',
        logger: false,
      });

      try {
        const reg = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            username: 'cleancover',
            password: 'Password123!',
            clientType: 'mobile',
          },
        });
        const token = reg.json().accessToken as string;

        const bookRes = await app.inject({
          method: 'POST',
          url: '/api/library',
          headers: { authorization: `Bearer ${token}` },
          payload: { book: { title: 'Keep Cover Book', authors: ['Autor'] } },
        });
        const bookId = bookRes.json().bookId as string;

        const pngBuf = await sharp({
          create: {
            width: 100,
            height: 150,
            channels: 3,
            background: { r: 10, g: 20, b: 30 },
          },
        })
          .png()
          .toBuffer();

        const upload = buildMultipartBody('file', 'keep.png', 'image/png', pngBuf);
        const upRes = await app.inject({
          method: 'POST',
          url: `/api/books/${bookId}/cover`,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': upload.contentTypeHeader,
          },
          payload: upload.payload,
        });
        expect(upRes.statusCode).toBe(200);
        const activeKey = upRes.json().coverKey as string;

        const orphanPath = path.join(dataDir, 'covers', '000000000000000000000000.webp');
        fs.writeFileSync(orphanPath, Buffer.from('orphan'));

        const removed = await coverService.cleanupOrphanCovers(0);
        expect(removed).toBe(1);
        expect(fs.existsSync(orphanPath)).toBe(false);
        expect(fs.existsSync(path.join(dataDir, 'covers', activeKey))).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
