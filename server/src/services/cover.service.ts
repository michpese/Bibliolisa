import crypto from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import {
  CoverKeySchema,
  toCanonicalIsoUtc,
  type BookCoverResponse,
} from '@bibliolisa/shared';
import sharp, { type Metadata as SharpMetadata } from 'sharp';
import type { DatabaseContext } from '../db/client.js';
import type { FetchLike } from '../metadata/types.js';
import { AppError } from '../plugins/error-handler.js';
import { SERVER_VERSION } from '../version.js';

export interface DnsAddressRecord {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string) => Promise<DnsAddressRecord[]>;

export interface CoverServiceOptions {
  dbCtx: DatabaseContext;
  now?: () => Date;
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookupFn;
  fetchTimeoutMs?: number;
  maxDownloadBytes?: number;
  maxUploadBytes?: number;
  maxRedirects?: number;
}

const ALLOWED_UPLOAD_FORMATS = new Set(['jpeg', 'png', 'webp']);
const ALLOWED_FETCH_FORMATS = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'tiff',
]);

async function defaultDnsLookup(hostname: string): Promise<DnsAddressRecord[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function isBlockedIpv4Octets(
  a: number,
  b: number,
  c: number,
  _d: number
): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-Local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a >= 224) return true; // Multicast & Reserved (224.0.0.0/4+)
  return false;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function expandIpv6ToWords(rawIp: string): number[] | null {
  const ip = rawIp.toLowerCase();
  const doubleColonParts = ip.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const words: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined || token === '') return null;
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const octets = parseIpv4Octets(token);
        if (!octets) return null;
        words.push(((octets[0] << 8) | octets[1]) & 0xffff);
        words.push(((octets[2] << 8) | octets[3]) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        words.push(Number.parseInt(token, 16));
      }
    }
    return words;
  };

  if (doubleColonParts.length === 1) {
    const words = parseSegmentList(doubleColonParts[0] ?? '');
    return words && words.length === 8 ? words : null;
  }

  const head = parseSegmentList(doubleColonParts[0] ?? '');
  const tail = parseSegmentList(doubleColonParts[1] ?? '');
  if (!head || !tail) return null;

  const missing = 8 - (head.length + tail.length);
  if (missing < 1) return null;

  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

export function isBlockedIpAddress(rawIp: string): boolean {
  let cleaned = rawIp.trim();
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1);
  }
  const zoneIdx = cleaned.indexOf('%');
  if (zoneIdx !== -1) {
    cleaned = cleaned.slice(0, zoneIdx);
  }

  const ipVersion = net.isIP(cleaned);
  if (ipVersion === 4) {
    const octets = parseIpv4Octets(cleaned);
    return octets
      ? isBlockedIpv4Octets(octets[0], octets[1], octets[2], octets[3])
      : true;
  }

  if (ipVersion === 6) {
    const words = expandIpv6ToWords(cleaned);
    if (!words || words.length !== 8) {
      return true;
    }

    const w0 = words[0]!;
    const w1 = words[1]!;
    const w2 = words[2]!;
    const w3 = words[3]!;
    const w4 = words[4]!;
    const w5 = words[5]!;
    const w6 = words[6]!;
    const w7 = words[7]!;

    // :: (unspecified)
    if (words.every((w) => w === 0)) return true;
    // ::1 (loopback)
    if (
      w0 === 0 &&
      w1 === 0 &&
      w2 === 0 &&
      w3 === 0 &&
      w4 === 0 &&
      w5 === 0 &&
      w6 === 0 &&
      w7 === 1
    ) {
      return true;
    }
    // fc00::/7 (Unique Local Address)
    if ((w0 & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (Link-Local) & fec0::/10 (Site-Local)
    if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (Multicast)
    if ((w0 & 0xff00) === 0xff00) return true;

    // ::ffff:0:0/96 (IPv4-mapped) & ::/96 (IPv4-compatible)
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) {
      return isBlockedIpv4Octets(
        (w6 >> 8) & 0xff,
        w6 & 0xff,
        (w7 >> 8) & 0xff,
        w7 & 0xff
      );
    }

    // 64:ff9b::/96 (NAT64)
    if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
      return isBlockedIpv4Octets(
        (w6 >> 8) & 0xff,
        w6 & 0xff,
        (w7 >> 8) & 0xff,
        w7 & 0xff
      );
    }

    // 2002::/16 (6to4)
    if (w0 === 0x2002) {
      return isBlockedIpv4Octets(
        (w1 >> 8) & 0xff,
        w1 & 0xff,
        (w2 >> 8) & 0xff,
        w2 & 0xff
      );
    }

    return false;
  }

  return true;
}

export interface ValidatedSsrfTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type PinnedHttpResult =
  | { kind: 'ok'; buffer: Buffer }
  | { kind: 'redirect'; status: number; location: string | null }
  | { kind: 'http_error'; status: number };

/**
 * Führt einen HTTP(S)-GET-Request aus und pinnt die Socket-Verbindung über `lookup`
 * zwingend auf die zuvor geprüfte IP-Adresse (verhindert DNS-Rebinding / TOCTOU).
 */
export function pinnedHttpDownload(params: {
  url: URL;
  address: string;
  family: 4 | 6;
  maxDownloadBytes: number;
  signal: AbortSignal;
  userAgent: string;
}): Promise<PinnedHttpResult> {
  const { url, address, family, maxDownloadBytes, signal, userAgent } = params;

  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      const abortErr = new DOMException('Aborted', 'AbortError');
      req.destroy(abortErr);
      finishReject(abortErr);
    };

    const finishResolve = (result: PinnedHttpResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const bareHost = url.hostname.replace(/^\[|\]$/g, '');
    const isHttps = url.protocol === 'https:';

    const lookup: net.LookupFunction = (_hostname, opts, cb) => {
      if (opts && opts.all) {
        cb(null, [{ address, family }]);
        return;
      }
      cb(null, address, family);
    };

    const baseOptions: http.RequestOptions = {
      method: 'GET',
      lookup,
      headers: {
        Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
        'User-Agent': userAgent,
      },
    };

    const onResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        const location =
          typeof res.headers.location === 'string' ? res.headers.location : null;
        res.resume();
        finishResolve({ kind: 'redirect', status, location });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        finishResolve({ kind: 'http_error', status });
        return;
      }

      const contentLengthHeader = res.headers['content-length'];
      const contentLengthRaw = Array.isArray(contentLengthHeader)
        ? contentLengthHeader[0]
        : contentLengthHeader;
      if (contentLengthRaw) {
        const declaredSize = Number(contentLengthRaw);
        if (Number.isFinite(declaredSize) && declaredSize > maxDownloadBytes) {
          res.destroy();
          req.destroy();
          finishReject(
            new AppError(
              413,
              'COVER_TOO_LARGE',
              'Cover überschreitet das maximale Download-Limit von 10 MB.'
            )
          );
          return;
        }
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buf.byteLength;
        if (totalBytes > maxDownloadBytes) {
          res.destroy();
          req.destroy();
          finishReject(
            new AppError(
              413,
              'COVER_TOO_LARGE',
              'Cover überschreitet das maximale Download-Limit von 10 MB.'
            )
          );
          return;
        }
        chunks.push(buf);
      });

      res.on('end', () => {
        finishResolve({ kind: 'ok', buffer: Buffer.concat(chunks, totalBytes) });
      });

      res.on('error', (err) => {
        finishReject(err);
      });
    };

    const req = isHttps
      ? https.request(
          url,
          {
            ...baseOptions,
            ...(net.isIP(bareHost) === 0 ? { servername: bareHost } : {}),
          },
          onResponse
        )
      : http.request(url, baseOptions, onResponse);

    signal.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      finishReject(err);
    });

    req.end();
  });
}

export class CoverService {
  private readonly dbCtx: DatabaseContext;
  private readonly now: () => Date;
  private readonly customFetchImpl?: FetchLike;
  private readonly dnsLookup: DnsLookupFn;
  private readonly fetchTimeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly maxUploadBytes: number;
  private readonly maxRedirects: number;

  constructor(options: CoverServiceOptions) {
    this.dbCtx = options.dbCtx;
    this.now = options.now ?? (() => new Date());
    this.customFetchImpl = options.fetchImpl;
    this.dnsLookup = options.dnsLookup ?? defaultDnsLookup;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 8000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 10 * 1024 * 1024;
    this.maxUploadBytes = options.maxUploadBytes ?? 5 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  private assertBookAccessible(userId: string, bookId: string): void {
    const row = this.dbCtx.sqlite
      .prepare(
        `SELECT id FROM books
         WHERE id = ?
           AND deleted_at IS NULL
           AND (
             created_by_user_id = ?
             OR EXISTS (
               SELECT 1 FROM user_books ub
               WHERE ub.user_id = ? AND ub.book_id = books.id
             )
           )`
      )
      .get(bookId, userId, userId) as { id: string } | undefined;

    if (!row) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Buch nicht gefunden.');
    }
  }

  async validateUrlForSsrf(rawUrl: string): Promise<ValidatedSsrfTarget> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new AppError(400, 'INVALID_URL', 'Ungültige Cover-URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError(
        400,
        'SSRF_BLOCKED',
        'Es sind ausschließlich HTTP- und HTTPS-URLs zulässig.'
      );
    }

    if (parsed.username || parsed.password) {
      throw new AppError(
        400,
        'SSRF_BLOCKED',
        'Zugangsdaten in Cover-URLs sind nicht zulässig.'
      );
    }

    const bareHost = parsed.hostname.replace(/^\[|\]$/g, '').trim();
    const lowerHost = bareHost.toLowerCase();

    if (
      !bareHost ||
      lowerHost === 'localhost' ||
      lowerHost.endsWith('.localhost')
    ) {
      throw new AppError(
        400,
        'SSRF_BLOCKED',
        'Lokale Hostnamen sind für den Cover-Abruf blockiert.'
      );
    }

    const literalIpVersion = net.isIP(bareHost);
    if (literalIpVersion !== 0) {
      if (isBlockedIpAddress(bareHost)) {
        throw new AppError(
          400,
          'SSRF_BLOCKED',
          'Die angegebene IP-Adresse ist aus Sicherheitsgründen blockiert.'
        );
      }
      return {
        url: parsed,
        address: bareHost,
        family: literalIpVersion === 6 ? 6 : 4,
      };
    }

    let resolved: DnsAddressRecord[];
    try {
      resolved = await this.dnsLookup(bareHost);
    } catch {
      throw new AppError(
        400,
        'COVER_FETCH_FAILED',
        'Hostname der Cover-URL konnte nicht aufgelöst werden.'
      );
    }

    if (resolved.length === 0) {
      throw new AppError(
        400,
        'COVER_FETCH_FAILED',
        'Keine gültige IP-Adresse für Cover-URL gefunden.'
      );
    }

    for (const record of resolved) {
      if (isBlockedIpAddress(record.address)) {
        throw new AppError(
          400,
          'SSRF_BLOCKED',
          'Ziel-IP-Adresse ist aus Sicherheitsgründen blockiert.'
        );
      }
    }

    const chosen = resolved[0]!;
    const family: 4 | 6 =
      chosen.family === 6 || net.isIP(chosen.address) === 6 ? 6 : 4;

    return {
      url: parsed,
      address: chosen.address,
      family,
    };
  }

  private async downloadWithSsrfProtection(rawUrl: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.fetchTimeoutMs);
    const userAgent = `Bibliolisa/${SERVER_VERSION} (+https://github.com/michpese/Bibliolisa)`;

    try {
      let currentUrl = rawUrl;
      let redirects = 0;

      while (true) {
        const target = await this.validateUrlForSsrf(currentUrl);

        if (!this.customFetchImpl) {
          let result: PinnedHttpResult;
          try {
            result = await pinnedHttpDownload({
              url: target.url,
              address: target.address,
              family: target.family,
              maxDownloadBytes: this.maxDownloadBytes,
              signal: controller.signal,
              userAgent,
            });
          } catch (error) {
            if (error instanceof AppError) {
              throw error;
            }
            const isTimeout =
              controller.signal.aborted ||
              (error instanceof Error && error.name === 'AbortError');
            throw new AppError(
              isTimeout ? 504 : 502,
              isTimeout ? 'COVER_FETCH_TIMEOUT' : 'COVER_FETCH_FAILED',
              isTimeout
                ? 'Zeitüberschreitung beim Herunterladen des Covers.'
                : 'Cover konnte nicht heruntergeladen werden.'
            );
          }

          if (result.kind === 'redirect') {
            if (redirects >= this.maxRedirects) {
              throw new AppError(
                400,
                'TOO_MANY_REDIRECTS',
                'Zu viele Weiterleitungen beim Cover-Abruf.'
              );
            }
            if (!result.location) {
              throw new AppError(
                502,
                'COVER_FETCH_FAILED',
                'Ungültige Weiterleitung ohne Ziel-Header.'
              );
            }
            try {
              currentUrl = new URL(result.location, currentUrl).toString();
            } catch {
              throw new AppError(
                502,
                'COVER_FETCH_FAILED',
                'Ungültige Weiterleitungs-URL.'
              );
            }
            redirects += 1;
            continue;
          }

          if (result.kind === 'http_error') {
            throw new AppError(
              502,
              'COVER_FETCH_FAILED',
              `Cover-Server antwortete mit HTTP ${result.status}.`
            );
          }

          return result.buffer;
        }

        let response: Response;
        try {
          response = await this.customFetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
              'User-Agent': userAgent,
            },
          });
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          const isTimeout =
            controller.signal.aborted ||
            (error instanceof Error && error.name === 'AbortError');
          throw new AppError(
            isTimeout ? 504 : 502,
            isTimeout ? 'COVER_FETCH_TIMEOUT' : 'COVER_FETCH_FAILED',
            isTimeout
              ? 'Zeitüberschreitung beim Herunterladen des Covers.'
              : 'Cover konnte nicht heruntergeladen werden.'
          );
        }

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          if (redirects >= this.maxRedirects) {
            throw new AppError(
              400,
              'TOO_MANY_REDIRECTS',
              'Zu viele Weiterleitungen beim Cover-Abruf.'
            );
          }
          const location = response.headers.get('location');
          if (!location) {
            throw new AppError(
              502,
              'COVER_FETCH_FAILED',
              'Ungültige Weiterleitung ohne Ziel-Header.'
            );
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new AppError(
              502,
              'COVER_FETCH_FAILED',
              'Ungültige Weiterleitungs-URL.'
            );
          }
          redirects += 1;
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new AppError(
            502,
            'COVER_FETCH_FAILED',
            `Cover-Server antwortete mit HTTP ${response.status}.`
          );
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
          const declaredSize = Number(contentLengthHeader);
          if (Number.isFinite(declaredSize) && declaredSize > this.maxDownloadBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new AppError(
              413,
              'COVER_TOO_LARGE',
              'Cover überschreitet das maximale Download-Limit von 10 MB.'
            );
          }
        }

        if (!response.body) {
          const arrayBuf = await response.arrayBuffer();
          if (arrayBuf.byteLength > this.maxDownloadBytes) {
            throw new AppError(
              413,
              'COVER_TOO_LARGE',
              'Cover überschreitet das maximale Download-Limit von 10 MB.'
            );
          }
          return Buffer.from(arrayBuf);
        }

        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            totalBytes += value.byteLength;
            if (totalBytes > this.maxDownloadBytes) {
              await reader.cancel().catch(() => undefined);
              throw new AppError(
                413,
                'COVER_TOO_LARGE',
                'Cover überschreitet das maximale Download-Limit von 10 MB.'
              );
            }
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          const isTimeout =
            controller.signal.aborted ||
            (error instanceof Error && error.name === 'AbortError');
          throw new AppError(
            isTimeout ? 504 : 502,
            isTimeout ? 'COVER_FETCH_TIMEOUT' : 'COVER_FETCH_FAILED',
            isTimeout
              ? 'Zeitüberschreitung beim Herunterladen des Covers.'
              : 'Fehler beim Lesen der Cover-Antwort.'
          );
        }

        return Buffer.concat(chunks, totalBytes);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async processAndWriteWebp(
    inputBuffer: Buffer,
    allowedFormats: ReadonlySet<string>
  ): Promise<string> {
    if (inputBuffer.length === 0) {
      throw new AppError(400, 'INVALID_IMAGE', 'Bilddatei ist leer.');
    }

    let metadata: SharpMetadata;
    try {
      metadata = await sharp(inputBuffer, {
        limitInputPixels: 50_000_000,
      }).metadata();
    } catch {
      throw new AppError(
        400,
        'INVALID_IMAGE',
        'Ungültiges oder beschädigtes Bildformat.'
      );
    }

    if (!metadata.format || !allowedFormats.has(metadata.format)) {
      throw new AppError(
        400,
        'INVALID_IMAGE',
        'Nicht unterstütztes Bildformat. Erlaubt sind JPEG, PNG und WebP.'
      );
    }

    let webpBuffer: Buffer;
    try {
      webpBuffer = await sharp(inputBuffer, {
        limitInputPixels: 50_000_000,
      })
        .rotate()
        .resize({
          width: 600,
          height: 900,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();
    } catch {
      throw new AppError(
        400,
        'INVALID_IMAGE',
        'Bild konnte nicht verarbeitet werden.'
      );
    }

    const hash24 = crypto
      .createHash('sha256')
      .update(webpBuffer)
      .digest('hex')
      .slice(0, 24);
    const coverKey = `${hash24}.webp`;

    await fs.mkdir(this.dbCtx.coversDir, { recursive: true });
    const targetPath = path.join(this.dbCtx.coversDir, coverKey);

    try {
      await fs.access(targetPath);
      return coverKey;
    } catch {
      // Datei existiert noch nicht -> atomar schreiben
    }

    const tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, webpBuffer);
      await fs.rename(tmpPath, targetPath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      try {
        await fs.access(targetPath);
        return coverKey;
      } catch {
        throw error;
      }
    }

    return coverKey;
  }

  private persistBookCoverKey(
    bookId: string,
    coverKey: string,
    coverSourceUrl: string | null
  ): BookCoverResponse {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const serverTs = this.dbCtx.nextServerTimestamp(nowDate);

    this.dbCtx.sqlite
      .prepare(
        `UPDATE books
         SET cover_key = ?,
             cover_source_url = COALESCE(?, cover_source_url),
             updated_at = ?,
             server_updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`
      )
      .run(coverKey, coverSourceUrl, nowIso, serverTs, bookId);

    const updatedRow = this.dbCtx.sqlite
      .prepare('SELECT cover_source_url FROM books WHERE id = ?')
      .get(bookId) as { cover_source_url: string | null } | undefined;

    return {
      bookId,
      coverKey,
      coverSourceUrl: updatedRow?.cover_source_url ?? coverSourceUrl,
      updatedAt: nowIso,
    };
  }

  async processAndStoreUpload(
    userId: string,
    bookId: string,
    buffer: Buffer
  ): Promise<BookCoverResponse> {
    if (buffer.length > this.maxUploadBytes) {
      throw new AppError(
        413,
        'COVER_TOO_LARGE',
        'Hochgeladene Datei überschreitet das Limit von 5 MB.'
      );
    }

    this.assertBookAccessible(userId, bookId);
    const coverKey = await this.processAndWriteWebp(
      buffer,
      ALLOWED_UPLOAD_FORMATS
    );
    return this.persistBookCoverKey(bookId, coverKey, null);
  }

  async fetchAndStoreForBook(
    userId: string,
    bookId: string,
    url: string
  ): Promise<BookCoverResponse> {
    this.assertBookAccessible(userId, bookId);
    const rawBuffer = await this.downloadWithSsrfProtection(url);
    const coverKey = await this.processAndWriteWebp(
      rawBuffer,
      ALLOWED_FETCH_FORMATS
    );
    return this.persistBookCoverKey(bookId, coverKey, url);
  }

  async readCoverFile(coverKey: string): Promise<Buffer> {
    const parsed = CoverKeySchema.safeParse(coverKey);
    if (!parsed.success) {
      throw new AppError(
        400,
        'INVALID_COVER_KEY',
        'Ungültiger Cover-Schlüssel.'
      );
    }

    const resolvedDir = path.resolve(this.dbCtx.coversDir);
    const resolvedFile = path.resolve(resolvedDir, parsed.data);
    if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
      throw new AppError(
        400,
        'INVALID_COVER_KEY',
        'Ungültiger Cover-Pfad.'
      );
    }

    try {
      return await fs.readFile(resolvedFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new AppError(404, 'COVER_NOT_FOUND', 'Cover nicht gefunden.');
      }
      throw error;
    }
  }

  async cleanupOrphanCovers(minAgeMs = 60_000): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.dbCtx.coversDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }

    const rows = this.dbCtx.sqlite
      .prepare('SELECT DISTINCT cover_key FROM books WHERE cover_key IS NOT NULL')
      .all() as Array<{ cover_key: string }>;
    const referencedKeys = new Set(rows.map((r) => r.cover_key));

    const cutoffMs = this.now().getTime() - minAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.webp')) {
        continue;
      }
      if (referencedKeys.has(entry.name)) {
        continue;
      }

      const filePath = path.join(this.dbCtx.coversDir, entry.name);
      try {
        if (minAgeMs > 0) {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs > cutoffMs) {
            continue;
          }
        }
        await fs.unlink(filePath);
        removed += 1;
      } catch {
        // Best-Effort beim Aufräumen
      }
    }

    return removed;
  }
}
