import { Platform } from 'react-native';
import {
  ApiErrorResponseSchema,
  AuthTokenResponseSchema,
  AuthUserSchema,
  BookCoverResponseSchema,
  MetadataIsbnResponseSchema,
  MetadataSearchResponseSchema,
  SyncResponseSchema,
  type AuthTokenResponse,
  type AuthUser,
  type BookCoverResponse,
  type MetadataIsbnResponse,
  type MetadataSearchResponse,
  type SyncRequest,
  type SyncResponse,
} from '@bibliolisa/shared';
import { normalizeServerUrl } from '../sync/health-check';
import {
  clearAuthTokens,
  getAuthTokens,
  isAccessTokenExpiringSoon,
  saveAuthTokens,
  type StoredAuthTokens,
} from './secure-storage';

export class MobileApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MobileApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isAuthError(error: unknown): boolean {
  return (
    error instanceof MobileApiError &&
    (error.status === 401 ||
      error.code === 'AUTH_REQUIRED' ||
      error.code === 'SESSION_EXPIRED')
  );
}

export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof MobileApiError &&
    (error.code === 'TIMEOUT' ||
      error.code === 'NETWORK_ERROR' ||
      (error.status === 0 && error.code !== 'INVALID_SERVER_URL'))
  );
}

let refreshInFlight: Promise<StoredAuthTokens | null> | null = null;

function requireNormalizedBaseUrl(rawUrl: string): string {
  const normalized = normalizeServerUrl(rawUrl);
  if (!normalized.ok) {
    throw new MobileApiError(0, 'INVALID_SERVER_URL', normalized.message);
  }
  return normalized.url;
}

async function parseErrorResponse(response: Response): Promise<MobileApiError> {
  let code = 'HTTP_ERROR';
  let message = `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
  let details: unknown;

  try {
    const raw = await response.json();
    const parsed = ApiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      details = parsed.data.error.details;
    }
  } catch {
    // Keine JSON-Fehlerantwort
  }

  if (response.status === 429) {
    message = 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.';
  }

  return new MobileApiError(response.status, code, message, details);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 6000,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MobileApiError(0, 'TIMEOUT', 'Zeitüberschreitung bei der Server-Anfrage.');
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new MobileApiError(0, 'NETWORK_ERROR', `Netzwerkfehler: ${msg}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function persistMobileTokenResponse(
  data: AuthTokenResponse
): Promise<StoredAuthTokens> {
  if (!data.refreshToken) {
    throw new MobileApiError(
      500,
      'MISSING_REFRESH_TOKEN',
      'Server hat kein Refresh Token für den mobilen Client zurückgegeben.'
    );
  }

  const stored: StoredAuthTokens = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessTokenExpiresAt: data.accessTokenExpiresAt,
  };
  await saveAuthTokens(stored);
  return stored;
}

/**
 * Erneuert ablaufende oder abgelaufene Tokens per Single-Flight über /api/auth/refresh.
 */
export async function refreshMobileTokens(
  serverUrl: string
): Promise<StoredAuthTokens | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const baseUrl = requireNormalizedBaseUrl(serverUrl);
      const current = await getAuthTokens();
      if (!current?.refreshToken) {
        return null;
      }

      const response = await fetchWithTimeout(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          refreshToken: current.refreshToken,
          clientType: 'mobile',
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          await clearAuthTokens();
          return null;
        }
        throw await parseErrorResponse(response);
      }

      const raw = await response.json();
      const parsed = AuthTokenResponseSchema.parse(raw);
      return await persistMobileTokenResponse(parsed);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Stellt ein noch mindestens 60 Sekunden gültiges Access Token bereit (rotiert bei Bedarf).
 */
export async function ensureFreshAccessToken(serverUrl: string): Promise<string> {
  const baseUrl = requireNormalizedBaseUrl(serverUrl);
  const current = await getAuthTokens();
  if (!current) {
    throw new MobileApiError(
      401,
      'AUTH_REQUIRED',
      'Bitte zuerst in den Einstellungen anmelden.'
    );
  }

  if (!isAccessTokenExpiringSoon(current.accessTokenExpiresAt, 60)) {
    return current.accessToken;
  }

  const refreshed = await refreshMobileTokens(baseUrl);
  if (!refreshed) {
    throw new MobileApiError(
      401,
      'SESSION_EXPIRED',
      'Anmeldung abgelaufen – bitte erneut anmelden.'
    );
  }
  return refreshed.accessToken;
}

async function authenticatedRequest<T>(
  serverUrl: string,
  path: string,
  parse: (json: unknown) => T,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    deviceId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const baseUrl = requireNormalizedBaseUrl(serverUrl);
  let token = await ensureFreshAccessToken(baseUrl);

  const send = async (bearer: string) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    };
    if (options.deviceId) {
      headers['X-Device-Id'] = options.deviceId;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    return fetchWithTimeout(
      `${baseUrl}${path}`,
      {
        method: options.method ?? 'GET',
        headers,
        body,
      },
      options.timeoutMs ?? 6000,
      options.signal
    );
  };

  let response = await send(token);
  if (response.status === 401) {
    const refreshed = await refreshMobileTokens(baseUrl);
    if (!refreshed) {
      throw new MobileApiError(
        401,
        'SESSION_EXPIRED',
        'Anmeldung abgelaufen – bitte erneut anmelden.'
      );
    }
    token = refreshed.accessToken;
    response = await send(token);
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const json = await response.json();
  return parse(json);
}

function getMobileDeviceName(): string {
  return Platform.OS === 'android' ? 'Bibliolisa Android' : `Bibliolisa ${Platform.OS}`;
}

export async function loginMobileAccount(
  serverUrl: string,
  params: { username: string; password: string; deviceId: string }
): Promise<AuthUser> {
  const baseUrl = requireNormalizedBaseUrl(serverUrl);
  const response = await fetchWithTimeout(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      username: params.username.trim(),
      password: params.password,
      clientType: 'mobile',
      deviceId: params.deviceId,
      deviceName: getMobileDeviceName(),
    }),
  });

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const parsed = AuthTokenResponseSchema.parse(await response.json());
  await persistMobileTokenResponse(parsed);
  return parsed.user;
}

export async function registerMobileAccount(
  serverUrl: string,
  params: {
    username: string;
    password: string;
    displayName?: string;
    deviceId: string;
  }
): Promise<AuthUser> {
  const baseUrl = requireNormalizedBaseUrl(serverUrl);
  const response = await fetchWithTimeout(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      username: params.username.trim(),
      password: params.password,
      displayName: params.displayName?.trim() || null,
      clientType: 'mobile',
      deviceId: params.deviceId,
      deviceName: getMobileDeviceName(),
    }),
  });

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const parsed = AuthTokenResponseSchema.parse(await response.json());
  await persistMobileTokenResponse(parsed);
  return parsed.user;
}

export async function logoutMobileBestEffort(serverUrl: string): Promise<void> {
  try {
    const baseUrl = requireNormalizedBaseUrl(serverUrl);
    const tokens = await getAuthTokens();
    if (!tokens) return;

    await fetchWithTimeout(
      `${baseUrl}/api/auth/logout`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      },
      2500
    );
  } catch {
    // Best-effort Logout darf lokalen Account-Reset offline nicht blockieren.
  }
}

export async function fetchCurrentUser(serverUrl: string): Promise<AuthUser> {
  return authenticatedRequest(serverUrl, '/api/auth/me', (json) =>
    AuthUserSchema.parse(json)
  );
}

export async function lookupMetadataByIsbn(
  serverUrl: string,
  isbn: string,
  signal?: AbortSignal
): Promise<MetadataIsbnResponse> {
  return authenticatedRequest(
    serverUrl,
    `/api/metadata/isbn/${encodeURIComponent(isbn)}`,
    (json) => MetadataIsbnResponseSchema.parse(json),
    { timeoutMs: 7000, signal }
  );
}

export async function searchMetadata(
  serverUrl: string,
  query: string,
  limit = 10,
  signal?: AbortSignal
): Promise<MetadataSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  return authenticatedRequest(
    serverUrl,
    `/api/metadata/search?${params.toString()}`,
    (json) => MetadataSearchResponseSchema.parse(json),
    { timeoutMs: 7000, signal }
  );
}

/**
 * Führt einen atomaren Delta-Sync (Push + Pull) gegen POST /api/sync aus.
 */
export async function syncWithServer(
  serverUrl: string,
  payload: SyncRequest,
  options: { signal?: AbortSignal } = {}
): Promise<SyncResponse> {
  return authenticatedRequest(
    serverUrl,
    '/api/sync',
    (json) => SyncResponseSchema.parse(json),
    {
      method: 'POST',
      body: payload,
      deviceId: payload.deviceId,
      timeoutMs: 15000,
      signal: options.signal,
    }
  );
}

function resolveCoverUploadMeta(localUri: string): {
  name: string;
  type: 'image/png' | 'image/webp' | 'image/jpeg';
} {
  const clean = localUri.split('?')[0]?.split('#')[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.png')) {
    return { name: 'cover.png', type: 'image/png' };
  }
  if (clean.endsWith('.webp')) {
    return { name: 'cover.webp', type: 'image/webp' };
  }
  return { name: 'cover.jpg', type: 'image/jpeg' };
}

/**
 * Lädt ein offline ausgewähltes/fotografiertes Cover per Multipart-FormData auf den Server hoch.
 */
export async function uploadBookCover(
  serverUrl: string,
  bookId: string,
  localUri: string,
  options: { signal?: AbortSignal } = {}
): Promise<BookCoverResponse> {
  const baseUrl = requireNormalizedBaseUrl(serverUrl);
  let token = await ensureFreshAccessToken(baseUrl);
  const { name, type } = resolveCoverUploadMeta(localUri);

  const send = async (bearer: string) => {
    const form = new FormData();
    form.append('file', {
      uri: localUri,
      name,
      type,
    } as unknown as Blob);

    return fetchWithTimeout(
      `${baseUrl}/api/books/${encodeURIComponent(bookId)}/cover`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: form,
      },
      20000,
      options.signal
    );
  };

  let response = await send(token);
  if (response.status === 401) {
    const refreshed = await refreshMobileTokens(baseUrl);
    if (!refreshed) {
      throw new MobileApiError(
        401,
        'SESSION_EXPIRED',
        'Anmeldung abgelaufen – bitte erneut anmelden.'
      );
    }
    token = refreshed.accessToken;
    response = await send(token);
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  return BookCoverResponseSchema.parse(await response.json());
}

/**
 * Stößt serverseitig das SSRF-geschützte Herunterladen & WebP-Caching eines externen Covers an.
 */
export async function fetchBookCoverOnServer(
  serverUrl: string,
  bookId: string,
  url: string,
  options: { signal?: AbortSignal } = {}
): Promise<BookCoverResponse> {
  return authenticatedRequest(
    serverUrl,
    `/api/books/${encodeURIComponent(bookId)}/cover/fetch`,
    (json) => BookCoverResponseSchema.parse(json),
    {
      method: 'POST',
      body: { url },
      timeoutMs: 15000,
      signal: options.signal,
    }
  );
}
