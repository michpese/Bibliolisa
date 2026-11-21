import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createDownloadResumable,
  getContentUriAsync,
} from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import appConfig from '../../app.json';
import {
  GITHUB_REPO_NAME,
  GITHUB_REPO_OWNER,
  isApkZipMagic,
  isTrustedGitHubUrl,
  type AppReleaseInfo,
} from './app-updater-utils';

const UPDATES_FOLDER_NAME = 'updates';

export interface InstalledAppInfo {
  version: string;
  buildCode: string | null;
  applicationId: string;
}

export interface ApkDownloadProgress {
  bytesWritten: number;
  bytesTotal: number;
  ratio: number;
}

export class UpdateDownloadCancelledError extends Error {
  constructor() {
    super('Download abgebrochen.');
    this.name = 'UpdateDownloadCancelledError';
  }
}

export function getInstalledAppInfo(): InstalledAppInfo {
  const version =
    Application.nativeApplicationVersion?.trim() ||
    appConfig.expo.version ||
    '0.2.0';
  const buildCode =
    Application.nativeBuildVersion?.trim() ||
    (appConfig.expo.android?.versionCode
      ? String(appConfig.expo.android.versionCode)
      : null);
  const applicationId =
    Application.applicationId?.trim() ||
    appConfig.expo.android?.package ||
    'de.bibliolisa.mobile';

  return {
    version,
    buildCode,
    applicationId,
  };
}

function getUpdatesDirectory(): Directory {
  return new Directory(Paths.cache, UPDATES_FOLDER_NAME);
}

/**
 * Entfernt zwischengespeicherte APK-Installationsdateien aus dem Cache-Ordner.
 * Nutzerdaten in SQLite und Cover unter Paths.document bleiben unberührt.
 */
export async function cleanupCachedUpdateApks(): Promise<void> {
  try {
    const dir = getUpdatesDirectory();
    if (dir.exists) {
      dir.delete();
    }
  } catch {
    // Best-Effort-Bereinigung darf den App-Start nie blockieren
  }
}

/**
 * Lädt die Release-APK streamend mit Fortschrittsanzeige in cache/updates/ herunter
 * und prüft Größe sowie APK/ZIP-Magic-Header vor der Installation.
 */
export async function downloadReleaseApk(params: {
  release: AppReleaseInfo;
  onProgress?: (progress: ApkDownloadProgress) => void;
  onVerifying?: () => void;
  onHandleReady?: (cancel: () => Promise<void>) => void;
}): Promise<{ localUri: string; size: number }> {
  if (Platform.OS !== 'android') {
    throw new Error(
      'Direkte APK-Installation wird nur auf Android unterstützt.'
    );
  }

  const asset = params.release.apkAsset;
  if (!asset) {
    throw new Error('Für dieses Release ist keine APK-Datei hinterlegt.');
  }

  if (!isTrustedGitHubUrl(asset.downloadUrl)) {
    throw new Error(
      'Die Download-URL verweist nicht auf das offizielle GitHub-Repository.'
    );
  }

  const updatesDir = getUpdatesDirectory();
  if (!updatesDir.exists) {
    updatesDir.create({ idempotent: true, intermediates: true });
  }

  const safeVersion =
    params.release.version.replace(/[^0-9A-Za-z._-]/g, '_') || 'latest';
  const targetFile = new File(updatesDir, `bibliolisa-${safeVersion}.apk`);
  if (targetFile.exists) {
    targetFile.delete();
  }

  let cancelled = false;
  const appInfo = getInstalledAppInfo();

  const downloadResumable = createDownloadResumable(
    asset.downloadUrl,
    targetFile.uri,
    {
      headers: {
        'User-Agent': `Bibliolisa-Mobile/${appInfo.version} (+https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME})`,
      },
    },
    (progressEvent) => {
      if (!params.onProgress) return;
      const bytesWritten = Math.max(0, progressEvent.totalBytesWritten);
      const bytesTotal =
        progressEvent.totalBytesExpectedToWrite > 0
          ? progressEvent.totalBytesExpectedToWrite
          : Math.max(0, asset.size);
      const ratio =
        bytesTotal > 0 ? Math.min(1, Math.max(0, bytesWritten / bytesTotal)) : 0;
      params.onProgress({
        bytesWritten,
        bytesTotal,
        ratio,
      });
    }
  );

  params.onHandleReady?.(async () => {
    cancelled = true;
    await downloadResumable.cancelAsync();
  });

  try {
    const result = await downloadResumable.downloadAsync();
    if (cancelled || !result) {
      throw new UpdateDownloadCancelledError();
    }

    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `APK-Download fehlgeschlagen (HTTP ${result.status}).`
      );
    }

    params.onVerifying?.();

    const downloadedFile = new File(result.uri);
    if (!downloadedFile.exists || downloadedFile.size <= 0) {
      throw new Error('Heruntergeladene APK-Datei ist leer oder fehlt.');
    }

    if (asset.size > 0 && downloadedFile.size !== asset.size) {
      throw new Error(
        'Heruntergeladene APK-Datei ist unvollständig (Dateigröße weicht ab).'
      );
    }

    const handle = downloadedFile.open();
    let header: Uint8Array;
    try {
      header = handle.readBytes(4);
    } finally {
      handle.close();
    }

    if (!isApkZipMagic(header)) {
      throw new Error(
        'Heruntergeladene Datei ist kein gültiges Android-APK-Paket.'
      );
    }

    return {
      localUri: downloadedFile.uri,
      size: downloadedFile.size,
    };
  } catch (error) {
    try {
      if (targetFile.exists) {
        targetFile.delete();
      }
    } catch {
      // Aufräumen bei abgebrochenem oder defektem Download
    }
    throw error;
  }
}

/**
 * Startet den Android-System-Paketinstaller für eine lokal geprüfte APK-Datei.
 */
export async function launchAndroidApkInstaller(
  localApkUri: string
): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error(
      'APK-Installation wird nur auf Android unterstützt.'
    );
  }

  const contentUri = await getContentUriAsync(localApkUri);
  // Intent.FLAG_GRANT_READ_URI_PERMISSION (0x00000001) – nicht mit FLAG_ACTIVITY_NEW_TASK kombinieren,
  // da IntentLauncher startActivityForResult verwendet.
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1,
  });
}

/**
 * Öffnet die Android-Einstellung „Unbekannte Apps installieren“ direkt für Bibliolisa.
 */
export async function openUnknownSourcesSettings(): Promise<void> {
  if (Platform.OS !== 'android') {
    await Linking.openSettings();
    return;
  }

  const { applicationId } = getInstalledAppInfo();
  try {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES,
      {
        data: `package:${applicationId}`,
      }
    );
  } catch {
    await Linking.openSettings();
  }
}

export async function openReleaseInBrowser(htmlUrl: string): Promise<void> {
  if (!isTrustedGitHubUrl(htmlUrl)) {
    throw new Error('Ungültige GitHub-Release-URL.');
  }
  await Linking.openURL(htmlUrl);
}
