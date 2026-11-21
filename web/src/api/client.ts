import type {
  AuthTokenResponse,
  AuthUser,
  BookCoverResponse,
  ChangePasswordRequest,
  CreateLibraryEntry,
  ImportResult,
  LibraryEntry,
  LibraryFacetsResponse,
  LibraryListResponse,
  LibrarySortField,
  LoginRequest,
  MetadataIsbnResponse,
  MetadataProvidersResponse,
  MetadataSearchResponse,
  ReadingStatus,
  RecommendationResult,
  RegisterRequest,
  SessionsResponse,
  SoftDeleteResponse,
  SortOrder,
  UpdateLibraryEntry,
  HealthResponse,
} from '@bibliolisa/shared';

/* -------------------------------------------------------------------------- */
/* Fehler & Token-Speicher (ausschließlich im Arbeitsspeicher!)                */
/* -------------------------------------------------------------------------- */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Feldfehler aus dem Zod-Mapping des Servers (`details.fieldErrors`). */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details as
      | { fieldErrors?: Record<string, string[]> }
      | undefined;
    return details?.fieldErrors ?? {};
  }
}

let accessToken: string | null = null;
let accessTokenExpiresAtMs = 0;
let sessionLostHandler: (() => void) | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAccessTokenExpiresAtMs(): number {
  return accessTokenExpiresAtMs;
}

export function setSessionLostHandler(handler: (() => void) | null): void {
  sessionLostHandler = handler;
}

function storeSession(response: AuthTokenResponse): void {
  accessToken = response.accessToken;
  accessTokenExpiresAtMs = Date.parse(response.accessTokenExpiresAt);
}

export function clearSession(): void {
  accessToken = null;
  accessTokenExpiresAtMs = 0;
}

/* -------------------------------------------------------------------------- */
/* Low-Level-Fetch                                                             */
/* -------------------------------------------------------------------------- */

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** Verhindert Silent-Refresh bei 401 (Login/Refresh-Endpunkte). */
  skipRefresh?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'HTTP_ERROR';
  let message = `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
  let details: unknown;
  try {
    const data = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (data.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      details = data.error.details;
    }
  } catch {
    // kein JSON – generische Meldung verwenden
  }
  if (response.status === 429) {
    message = 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.';
  }
  return new ApiError(response.status, code, message, details);
}

function makeRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
    credentials: 'same-origin',
  });
}

/* -------------------------------------------------------------------------- */
/* Silent Refresh (Single-Flight)                                              */
/* -------------------------------------------------------------------------- */

let refreshInFlight: Promise<AuthTokenResponse | null> | null = null;

/**
 * Erneuert die Session über das HttpOnly-Refresh-Cookie. Parallele Aufrufe teilen sich
 * genau einen Request (verhindert unnötige Token-Rotationen).
 * Rückgabe `null` = keine gültige Session.
 */
export function refreshSession(): Promise<AuthTokenResponse | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientType: 'web' }),
        credentials: 'same-origin',
      });
      if (!response.ok) {
        if (response.status === 401) {
          clearSession();
          return null;
        }
        throw await parseError(response);
      }
      const data = (await response.json()) as AuthTokenResponse;
      storeSession(data);
      return data;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function apiFetchResponse(
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  let response = await makeRequest(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession().catch(() => null);
    if (refreshed) {
      response = await makeRequest(path, options);
    } else {
      sessionLostHandler?.();
    }
  }

  if (!response.ok) {
    throw await parseError(response);
  }
  return response;
}

export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const response = await apiFetchResponse(path, options);
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Typisierte Endpunkte                                                        */
/* -------------------------------------------------------------------------- */

export interface LibraryFilters {
  q?: string;
  status?: ReadingStatus;
  genre?: string;
  author?: string;
  series?: string;
  minRating?: number;
  sort: LibrarySortField;
  order?: SortOrder;
}

export type LoginInput = Pick<LoginRequest, 'username' | 'password'>;
export type RegisterInput = Pick<RegisterRequest, 'username' | 'password'> & {
  displayName?: string | null;
  email?: string | null;
};

function describeDevice(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unbekannt';
  return `${browser} auf ${os}`;
}

export const api = {
  health: () => apiFetch<HealthResponse>('/api/health', { skipRefresh: true }),

  async login(input: LoginInput): Promise<AuthTokenResponse> {
    const data = await apiFetch<AuthTokenResponse>('/api/auth/login', {
      method: 'POST',
      skipRefresh: true,
      body: { ...input, clientType: 'web', deviceName: describeDevice() },
    });
    storeSession(data);
    return data;
  },

  async register(input: RegisterInput): Promise<AuthTokenResponse> {
    const data = await apiFetch<AuthTokenResponse>('/api/auth/register', {
      method: 'POST',
      skipRefresh: true,
      body: { ...input, clientType: 'web', deviceName: describeDevice() },
    });
    storeSession(data);
    return data;
  },

  async logout(): Promise<void> {
    try {
      await apiFetch<void>('/api/auth/logout', {
        method: 'POST',
        body: {},
        skipRefresh: true,
      });
    } finally {
      clearSession();
    }
  },

  me: () => apiFetch<AuthUser>('/api/auth/me'),
  sessions: () => apiFetch<SessionsResponse>('/api/auth/sessions'),
  revokeSession: (id: string) =>
    apiFetch<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  changePassword: (body: ChangePasswordRequest) =>
    apiFetch<void>('/api/auth/change-password', { method: 'POST', body }),

  libraryPage: (
    filters: LibraryFilters,
    page: number,
    limit: number,
    signal?: AbortSignal
  ) =>
    apiFetch<LibraryListResponse>('/api/library', {
      query: { ...filters, page, limit },
      signal,
    }),
  facets: () => apiFetch<LibraryFacetsResponse>('/api/library/facets'),
  entry: (id: string) => apiFetch<LibraryEntry>(`/api/library/${id}`),
  createEntry: (body: CreateLibraryEntry | Record<string, unknown>) =>
    apiFetch<LibraryEntry>('/api/library', { method: 'POST', body }),
  updateEntry: (id: string, body: UpdateLibraryEntry | Record<string, unknown>) =>
    apiFetch<LibraryEntry>(`/api/library/${id}`, { method: 'PATCH', body }),
  deleteEntry: (id: string) =>
    apiFetch<SoftDeleteResponse>(`/api/library/${id}`, { method: 'DELETE' }),
  restoreEntry: (id: string) =>
    apiFetch<LibraryEntry>(`/api/library/${id}/restore`, { method: 'POST', body: {} }),

  uploadCover: (bookId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch<BookCoverResponse>(`/api/books/${bookId}/cover`, {
      method: 'POST',
      body: form,
    });
  },
  fetchCover: (bookId: string, url: string) =>
    apiFetch<BookCoverResponse>(`/api/books/${bookId}/cover/fetch`, {
      method: 'POST',
      body: { url },
    }),

  metadataByIsbn: (isbn: string, signal?: AbortSignal) =>
    apiFetch<MetadataIsbnResponse>(`/api/metadata/isbn/${encodeURIComponent(isbn)}`, {
      signal,
    }),
  metadataSearch: (q: string, limit = 12, signal?: AbortSignal) =>
    apiFetch<MetadataSearchResponse>('/api/metadata/search', {
      query: { q, limit },
      signal,
    }),
  metadataProviders: () =>
    apiFetch<MetadataProvidersResponse>('/api/metadata/providers'),

  recommendations: (seed?: number, limitPerCategory = 5) =>
    apiFetch<RecommendationResult>('/api/recommendations', {
      query: { seed, limitPerCategory },
    }),

  importJson: (payload: unknown) =>
    apiFetch<ImportResult>('/api/import/json', { method: 'POST', body: payload }),

  /** Lädt einen Export (mit Bearer-Header) und stößt den Browser-Download an. */
  async downloadExport(kind: 'json' | 'csv'): Promise<string> {
    const response = await apiFetchResponse(`/api/export/${kind}`);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `bibliolisa-export.${kind}`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return filename;
  },
};

export function coverUrl(coverKey: string | null | undefined): string | null {
  return coverKey ? `/api/covers/${coverKey}` : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const fieldErrors = Object.entries(error.fieldErrors);
    if (error.code === 'VALIDATION_ERROR' && fieldErrors.length > 0) {
      return fieldErrors
        .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
        .join(' · ');
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unbekannter Fehler.';
}
