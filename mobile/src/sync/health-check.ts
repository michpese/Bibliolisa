import { HealthResponseSchema, type HealthResponse } from '@bibliolisa/shared';

export const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

export type NormalizedUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

export type HealthCheckErrorKind =
  | 'invalid_url'
  | 'timeout'
  | 'tls_error'
  | 'network_error'
  | 'http_error'
  | 'invalid_response';

export type HealthCheckResult =
  | {
      ok: true;
      url: string;
      latencyMs: number;
      health: HealthResponse;
    }
  | {
      ok: false;
      url: string;
      latencyMs: number;
      kind: HealthCheckErrorKind;
      message: string;
      httpStatus?: number;
    };

/**
 * Normalisiert und validiert eine frei konfigurierbare http://- oder https://-Server-URL.
 */
export function normalizeServerUrl(raw: string): NormalizedUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Bitte eine Server-URL eingeben (z. B. https://books.home.lan).',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message:
        'Ungültige URL. Bitte mit http:// oder https:// angeben (z. B. http://192.168.x.x:3000).',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      message: 'Es werden ausschließlich http:// und https:// unterstützt.',
    };
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      message: 'Server-Hostname fehlt.',
    };
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return {
    ok: true,
    url: `${parsed.origin}${cleanPath}`,
  };
}

function looksLikeTlsError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('certificate') ||
    lower.includes('ssl') ||
    lower.includes('tls') ||
    lower.includes('trust anchor') ||
    lower.includes('self-signed') ||
    lower.includes('self signed') ||
    lower.includes('cert_')
  );
}

/**
 * Prüft GET <serverUrl>/api/health mit hartem 1500ms-AbortController-Timeout.
 */
export async function checkServerHealth(
  rawUrl: string,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<HealthCheckResult> {
  const normalized = normalizeServerUrl(rawUrl);
  if (!normalized.ok) {
    return {
      ok: false,
      url: rawUrl.trim(),
      latencyMs: 0,
      kind: 'invalid_url',
      message: normalized.message,
    };
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${normalized.url}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const latencyMs = Math.max(1, Date.now() - startedAt);

    if (!response.ok) {
      return {
        ok: false,
        url: normalized.url,
        latencyMs,
        kind: 'http_error',
        httpStatus: response.status,
        message: `Server antwortete mit HTTP ${response.status}.`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        ok: false,
        url: normalized.url,
        latencyMs,
        kind: 'invalid_response',
        message: 'Server lieferte keine gültige JSON-Antwort unter /api/health.',
      };
    }

    const parsed = HealthResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        url: normalized.url,
        latencyMs,
        kind: 'invalid_response',
        message: 'Antwort entspricht nicht dem Bibliolisa-Health-Format.',
      };
    }

    return {
      ok: true,
      url: normalized.url,
      latencyMs,
      health: parsed.data,
    };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const errMsg = error instanceof Error ? error.message : String(error);

    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      return {
        ok: false,
        url: normalized.url,
        latencyMs,
        kind: 'timeout',
        message: `Zeitüberschreitung nach ${timeoutMs} ms – Server im aktuellen Netzwerk nicht erreichbar.`,
      };
    }

    if (looksLikeTlsError(errMsg)) {
      return {
        ok: false,
        url: normalized.url,
        latencyMs,
        kind: 'tls_error',
        message:
          'TLS-/Zertifikatsfehler. Bei selbstsigniertem HTTPS bitte die lokale CA als Benutzer-CA in Android installieren.',
      };
    }

    return {
      ok: false,
      url: normalized.url,
      latencyMs,
      kind: 'network_error',
      message: `Verbindung fehlgeschlagen: ${errMsg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
