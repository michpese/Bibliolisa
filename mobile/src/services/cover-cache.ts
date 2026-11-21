import { Directory, File, Paths } from 'expo-file-system';
import { CoverKeySchema } from '@bibliolisa/shared';
import { normalizeServerUrl } from '../sync/health-check';

const COVERS_FOLDER_NAME = 'covers';

function getCoversDirectory(): Directory {
  return new Directory(Paths.document, COVERS_FOLDER_NAME);
}

function ensureCoversDirectory(): Directory {
  const dir = getCoversDirectory();
  if (!dir.exists) {
    dir.create({ idempotent: true, intermediates: true });
  }
  return dir;
}

function inferImageExtension(uri: string): string {
  const clean = uri.split('?')[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  return 'jpg';
}

/**
 * Kopiert ein lokal ausgewähltes oder fotografiertes Cover dauerhaft in documentDirectory/covers/.
 */
export async function saveLocalCover(
  sourceUri: string,
  bookId: string
): Promise<string> {
  const dir = ensureCoversDirectory();
  const ext = inferImageExtension(sourceUri);
  const filename = `local-${bookId}-${Date.now()}.${ext}`;
  const destination = new File(dir, filename);

  const source = new File(sourceUri);
  source.copy(destination);

  return destination.uri;
}

/**
 * Best-Effort-Download eines externen Cover-Vorschaubilds für die Offline-Anzeige.
 * Schlägt im Offline-Modus lautlos fehl, damit der Speichervorgang nie blockiert.
 */
export async function cacheExternalCoverPreview(
  remoteUrl: string,
  bookId: string
): Promise<string | null> {
  try {
    const dir = ensureCoversDirectory();
    const ext = inferImageExtension(remoteUrl);
    const filename = `preview-${bookId}-${Date.now()}.${ext}`;
    const destination = new File(dir, filename);

    const downloaded = await File.downloadFileAsync(remoteUrl, destination, {
      idempotent: true,
    });
    return downloaded.uri;
  } catch {
    return null;
  }
}

/**
 * Prüft, ob ein gecachtes WebP-Cover für einen Server-Cover-Key bereits lokal vorliegt.
 */
export function getCachedCoverUri(coverKey: string): string | null {
  const parsed = CoverKeySchema.safeParse(coverKey);
  if (!parsed.success) {
    return null;
  }
  const file = new File(getCoversDirectory(), parsed.data);
  if (file.exists && file.size > 0) {
    return file.uri;
  }
  return null;
}

/**
 * Lädt ein Cover authentifiziert (Authorization: Bearer) atomar über eine temporäre Datei
 * in Paths.document/covers/<coverKey> herunter.
 */
export async function downloadCachedCover(params: {
  serverUrl: string;
  coverKey: string;
  accessToken: string;
}): Promise<string> {
  const validKey = CoverKeySchema.parse(params.coverKey);
  const normalized = normalizeServerUrl(params.serverUrl);
  if (!normalized.ok) {
    throw new Error(normalized.message);
  }

  const dir = ensureCoversDirectory();
  const destination = new File(dir, validKey);
  if (destination.exists && destination.size > 0) {
    return destination.uri;
  }

  const tmpName = `${validKey}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpFile = new File(dir, tmpName);

  try {
    await File.downloadFileAsync(
      `${normalized.url}/api/covers/${encodeURIComponent(validKey)}`,
      tmpFile,
      {
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
        },
        idempotent: true,
      }
    );

    if (!tmpFile.exists || tmpFile.size === 0) {
      throw new Error('Heruntergeladene Cover-Datei ist leer.');
    }

    if (destination.exists) {
      destination.delete();
    }
    tmpFile.move(destination);
    return destination.uri;
  } catch (error) {
    try {
      if (tmpFile.exists) {
        tmpFile.delete();
      }
    } catch {
      // Aufräumen der temporären Datei ist Best-Effort
    }
    throw error;
  }
}

/**
 * Löscht den gesamten lokalen Cover-Cache (bei Logout, Benutzer- oder Serverwechsel).
 */
export async function clearCoverCache(): Promise<void> {
  try {
    const dir = getCoversDirectory();
    if (dir.exists) {
      dir.delete();
    }
  } catch {
    // Cache-Bereinigung darf Reset nicht abbrechen
  }
}

/**
 * Entfernt verwaiste Cover-Dateien, die von keinem aktiven lokalen Buch mehr referenziert werden.
 */
export async function cleanupOrphanCovers(
  activeUris: ReadonlySet<string>
): Promise<number> {
  try {
    const dir = getCoversDirectory();
    if (!dir.exists) {
      return 0;
    }

    let removed = 0;
    for (const entry of dir.list()) {
      if (entry instanceof File && !activeUris.has(entry.uri)) {
        entry.delete();
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
