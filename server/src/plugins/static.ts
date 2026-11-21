import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Ermittelt das Verzeichnis des gebauten Webapp-Bundles.
 *
 * Reihenfolge:
 *  1. explizit konfiguriertes `WEB_DIR` (Docker: `/app/public`)
 *  2. `<repo>/web/dist` relativ zum kompilierten Server (`server/dist/plugins`) bzw. zur Quelle
 *
 * Gibt `null` zurück, wenn kein Bundle mit `index.html` existiert (z. B. in der reinen API-Entwicklung).
 */
export function resolveWebDir(configured?: string): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured ? path.resolve(configured) : null,
    path.resolve(currentDir, '..', '..', '..', 'web', 'dist'),
    path.resolve(currentDir, '..', '..', '..', '..', 'web', 'dist'),
  ].filter((value): value is string => value !== null);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
    if (configured && candidate === path.resolve(configured)) {
      // Ein explizit konfiguriertes, aber leeres Verzeichnis nicht stillschweigend mit Fallbacks überdecken.
      return null;
    }
  }

  return null;
}

/**
 * Registriert die statische Auslieferung der Webapp unter `/`.
 * Der SPA-Fallback (`index.html` für unbekannte Nicht-API-GET-Pfade) wird im
 * Not-Found-Handler (`registerErrorHandler`) umgesetzt, damit `/api/*` strikt JSON-404 liefert.
 */
export async function registerWebApp(
  app: FastifyInstance,
  webDir: string
): Promise<void> {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    index: ['index.html'],
    wildcard: false,
    // Cache-Control kommt ausschließlich aus setHeaders (sonst überschreibt das Plugin es mit max-age=0).
    cacheControl: false,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const normalized = filePath.split(path.sep).join('/');
      if (normalized.includes('/assets/')) {
        // Vite erzeugt Content-Hash-Dateinamen -> dauerhaft cachebar.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
}
