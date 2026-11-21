import { Directory, File, Paths } from 'expo-file-system';

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
