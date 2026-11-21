import { z } from 'zod';

export const GITHUB_REPO_OWNER = 'michpese';
export const GITHUB_REPO_NAME = 'Bibliolisa';
export const GITHUB_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

const TRUSTED_GITHUB_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface AppReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
  sha256Url: string | null;
}

export interface AppReleaseInfo {
  tagName: string;
  version: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  prerelease: boolean;
  apkAsset: AppReleaseAsset | null;
}

export interface ReleaseNoteBlock {
  type: 'heading' | 'bullet' | 'paragraph';
  text: string;
  boldPrefix?: string;
}

export type UpdateCheckErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'http_error'
  | 'invalid_response';

export type UpdateCheckResult =
  | {
      status: 'update_available';
      release: AppReleaseInfo;
      etag: string | null;
      fromCache: boolean;
    }
  | {
      status: 'up_to_date';
      currentVersion: string;
      latestVersion: string;
      release?: AppReleaseInfo;
      etag: string | null;
      fromCache: boolean;
    }
  | {
      status: 'no_release';
      etag: string | null;
    }
  | {
      status: 'error';
      kind: UpdateCheckErrorKind;
      message: string;
      httpStatus?: number;
    };

const GitHubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string(),
  size: z.number().int().nonnegative().optional().default(0),
  content_type: z.string().optional().default('application/octet-stream'),
});

const GitHubReleasePayloadSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  draft: z.boolean().optional().default(false),
  prerelease: z.boolean().optional().default(false),
  assets: z.array(GitHubAssetSchema).optional().default([]),
});

export const CachedAppReleaseSchema: z.ZodType<AppReleaseInfo> = z.object({
  tagName: z.string(),
  version: z.string(),
  name: z.string(),
  body: z.string(),
  htmlUrl: z.string(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  apkAsset: z
    .object({
      name: z.string(),
      downloadUrl: z.string(),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      sha256Url: z.string().nullable(),
    })
    .nullable(),
});

const SEMVER_PATTERN =
  /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parst einen SemVer-String (optional mit führendem "v" und Build-Metadaten).
 */
export function parseSemver(raw: string): ParsedSemver | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  const prerelease = match[4] ? match[4].split('.').filter(Boolean) : [];
  return { major, minor, patch, prerelease };
}

function formatNormalizedSemver(parsed: ParsedSemver): string {
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length > 0
    ? `${base}-${parsed.prerelease.join('.')}`
    : base;
}

/**
 * Vergleicht zwei SemVer-Versionen gemäß SemVer 2.0.0 (-1 | 0 | 1, null bei ungültigem Format).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;

  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const idA = aPre[i]!;
    const idB = bPre[i]!;
    if (idA === idB) continue;

    const numA = /^\d+$/.test(idA) ? Number(idA) : null;
    const numB = /^\d+$/.test(idB) ? Number(idB) : null;

    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA < numB ? -1 : 1;
      continue;
    }
    if (numA !== null && numB === null) {
      return -1;
    }
    if (numA === null && numB !== null) {
      return 1;
    }
    return idA < idB ? -1 : 1;
  }

  if (aPre.length === bPre.length) return 0;
  return aPre.length < bPre.length ? -1 : 1;
}

export function isNewerVersion(
  currentVersion: string,
  candidateVersion: string
): boolean {
  return compareSemver(candidateVersion, currentVersion) === 1;
}

/**
 * Stellt sicher, dass Download- und Release-URLs ausschließlich auf das Bibliolisa-GitHub-Repo
 * bzw. vertrauenswürdige GitHub-Asset-CDNs über HTTPS zeigen.
 */
export function isTrustedGitHubUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (!TRUSTED_GITHUB_HOSTS.has(host)) {
      return false;
    }
    if (host === 'github.com') {
      const expectedPrefix =
        `/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/`.toLowerCase();
      return parsed.pathname.toLowerCase().startsWith(expectedPrefix);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validiert eine GitHub Releases API-Antwort und extrahiert Release-Metadaten samt APK-Asset.
 */
export function parseGitHubReleasePayload(raw: unknown): AppReleaseInfo | null {
  const parsed = GitHubReleasePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const data = parsed.data;
  if (data.draft) {
    return null;
  }

  const semver = parseSemver(data.tag_name);
  if (!semver) {
    return null;
  }

  const validApkAssets = data.assets.filter(
    (asset) =>
      asset.name.toLowerCase().endsWith('.apk') &&
      isTrustedGitHubUrl(asset.browser_download_url)
  );

  const selectedApk =
    validApkAssets.find((asset) => /^bibliolisa-.*\.apk$/i.test(asset.name)) ??
    validApkAssets[0] ??
    null;

  let sha256Url: string | null = null;
  if (selectedApk) {
    const exactShaName = `${selectedApk.name}.sha256`.toLowerCase();
    const shaAsset =
      data.assets.find(
        (asset) =>
          asset.name.toLowerCase() === exactShaName &&
          isTrustedGitHubUrl(asset.browser_download_url)
      ) ??
      data.assets.find(
        (asset) =>
          asset.name.toLowerCase().endsWith('.apk.sha256') &&
          isTrustedGitHubUrl(asset.browser_download_url)
      );
    sha256Url = shaAsset ? shaAsset.browser_download_url : null;
  }

  const htmlUrl =
    data.html_url && isTrustedGitHubUrl(data.html_url)
      ? data.html_url
      : GITHUB_RELEASES_PAGE_URL;

  const version = formatNormalizedSemver(semver);

  return {
    tagName: data.tag_name.trim(),
    version,
    name: data.name?.trim() || `Bibliolisa v${version}`,
    body: data.body ?? '',
    htmlUrl,
    publishedAt: data.published_at ?? null,
    prerelease: data.prerelease,
    apkAsset: selectedApk
      ? {
          name: selectedApk.name,
          downloadUrl: selectedApk.browser_download_url,
          size: selectedApk.size,
          contentType: selectedApk.content_type,
          sha256Url,
        }
      : null,
  };
}

function buildUpdateOutcome(params: {
  currentVersion: string;
  release: AppReleaseInfo;
  etag: string | null;
  fromCache: boolean;
}): UpdateCheckResult {
  if (isNewerVersion(params.currentVersion, params.release.version)) {
    return {
      status: 'update_available',
      release: params.release,
      etag: params.etag,
      fromCache: params.fromCache,
    };
  }
  return {
    status: 'up_to_date',
    currentVersion: params.currentVersion,
    latestVersion: params.release.version,
    release: params.release,
    etag: params.etag,
    fromCache: params.fromCache,
  };
}

/**
 * Prüft gegen die GitHub Releases API (inkl. ETag-Caching), ob eine neuere APK-Version vorliegt.
 */
export async function checkForAppUpdate(params: {
  currentVersion: string;
  etag?: string | null;
  cachedRelease?: AppReleaseInfo | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}): Promise<UpdateCheckResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? 8000;
  const apiUrl = params.apiUrl ?? GITHUB_LATEST_RELEASE_API_URL;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Bibliolisa-Mobile/${params.currentVersion} (+https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME})`,
  };

  if (params.etag && params.cachedRelease) {
    headers['If-None-Match'] = params.etag;
  }

  try {
    const response = await fetchFn(apiUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const responseEtag = response.headers.get('etag') ?? params.etag ?? null;

    if (response.status === 304 && params.cachedRelease) {
      return buildUpdateOutcome({
        currentVersion: params.currentVersion,
        release: params.cachedRelease,
        etag: responseEtag,
        fromCache: true,
      });
    }

    if (response.status === 404) {
      return {
        status: 'no_release',
        etag: null,
      };
    }

    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      return {
        status: 'error',
        kind: 'rate_limited',
        httpStatus: response.status,
        message:
          'GitHub API-Limit erreicht. Bitte später erneut nach Updates suchen.',
      };
    }

    if (!response.ok) {
      return {
        status: 'error',
        kind: 'http_error',
        httpStatus: response.status,
        message: `Update-Prüfung fehlgeschlagen (HTTP ${response.status}).`,
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      return {
        status: 'error',
        kind: 'invalid_response',
        message: 'GitHub-Antwort konnte nicht als JSON gelesen werden.',
      };
    }

    const release = parseGitHubReleasePayload(rawJson);
    if (!release) {
      return {
        status: 'error',
        kind: 'invalid_response',
        message: 'GitHub-Release-Antwort hat ein unerwartetes Format.',
      };
    }

    return buildUpdateOutcome({
      currentVersion: params.currentVersion,
      release,
      etag: responseEtag,
      fromCache: false,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 'error',
        kind: 'timeout',
        message: 'Zeitüberschreitung bei der Suche nach App-Updates.',
      };
    }
    return {
      status: 'error',
      kind: 'network',
      message:
        'GitHub Releases konnte nicht erreicht werden. Bitte Internetverbindung prüfen.',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function cleanInlineMarkdown(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)]+|[^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .trim();
}

/**
 * Bereitet Release-Notes aus CHANGELOG/GitHub-Release für die mobile Anzeige auf
 * und blendet technische CI-/Artefakt-Blöcke aus.
 */
export function formatReleaseNotesForDisplay(body: string): ReleaseNoteBlock[] {
  if (!body.trim()) return [];

  const blocks: ReleaseNoteBlock[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (
      /^#{1,6}\s+(Android APK|Docker-Image)/i.test(trimmed) ||
      /^\*\*Full Changelog\*\*/i.test(trimmed) ||
      /^<!--\s*Release notes generated/i.test(trimmed)
    ) {
      break;
    }

    if (!trimmed || /^---+$/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) {
      continue;
    }

    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const headingText = cleanInlineMarkdown(headingMatch[1]!);
      if (headingText) {
        blocks.push({ type: 'heading', text: headingText });
      }
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      const rawContent = bulletMatch[1]!.trim();
      const boldPrefixMatch =
        /^\*\*([^*]+?)\*\*\s*(?:([:–—-])\s*|\s+)(.+)$/.exec(rawContent);

      if (boldPrefixMatch) {
        const rawPrefix = cleanInlineMarkdown(boldPrefixMatch[1]!);
        const separator = boldPrefixMatch[2] ?? '';
        const cleanRest = cleanInlineMarkdown(boldPrefixMatch[3]!);

        const normalizedPrefix = rawPrefix.endsWith(':')
          ? rawPrefix
          : separator === ':'
            ? `${rawPrefix}:`
            : rawPrefix;

        const displayText =
          separator && separator !== ':'
            ? `${separator} ${cleanRest}`
            : cleanRest;

        blocks.push({
          type: 'bullet',
          boldPrefix: normalizedPrefix,
          text: displayText,
        });
      } else {
        const cleanBullet = cleanInlineMarkdown(rawContent);
        if (cleanBullet) {
          blocks.push({ type: 'bullet', text: cleanBullet });
        }
      }
      continue;
    }

    const paragraphText = cleanInlineMarkdown(trimmed);
    if (paragraphText) {
      blocks.push({ type: 'paragraph', text: paragraphText });
    }
  }

  return blocks;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unbekannt';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Prüft auf den ZIP/APK-Magic-Header ("PK\x03\x04"), um defekte oder HTML-Downloads abzufangen.
 */
export function isApkZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}
