import type {
  MetadataCandidate,
  MetadataIsbnResponse,
  MetadataProviderId,
  MetadataProvidersResponse,
  MetadataSearchResponse,
  ProviderStatus,
} from '@bibliolisa/shared';
import {
  dedupeAuthors,
  normalizeGenres,
  type MetadataProvider,
} from './types.js';

export interface MetadataAggregatorOptions {
  providers: MetadataProvider[];
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  now?: () => Date;
}

interface CacheEntry<T> {
  value: T;
  cachedAtMs: number;
}

const DEFAULT_PRIORITY_ORDER: readonly MetadataProviderId[] = [
  'hardcover',
  'google_books',
  'openlibrary',
];

const SERIES_PRIORITY_ORDER: readonly MetadataProviderId[] = [
  'hardcover',
  'openlibrary',
  'google_books',
];

const DESCRIPTION_PRIORITY_ORDER: readonly MetadataProviderId[] = [
  'google_books',
  'hardcover',
  'openlibrary',
];

const PRIORITY_RANK: Record<MetadataProviderId, number> = {
  hardcover: 0,
  google_books: 1,
  openlibrary: 2,
};

function orderCandidatesBy(
  byProvider: ReadonlyMap<MetadataProviderId, MetadataCandidate>,
  order: readonly MetadataProviderId[]
): MetadataCandidate[] {
  const result: MetadataCandidate[] = [];
  for (const id of order) {
    const candidate = byProvider.get(id);
    if (candidate) {
      result.push(candidate);
    }
  }
  return result;
}

function mergeCandidates(
  candidates: readonly MetadataCandidate[],
  fallbackIsbn13: string,
  fallbackIsbn10: string | null
): MetadataCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const byProvider = new Map<MetadataProviderId, MetadataCandidate>();
  for (const candidate of candidates) {
    if (!byProvider.has(candidate.source)) {
      byProvider.set(candidate.source, candidate);
    }
  }

  const defaultOrdered = orderCandidatesBy(byProvider, DEFAULT_PRIORITY_ORDER);
  const seriesOrdered = orderCandidatesBy(byProvider, SERIES_PRIORITY_ORDER);
  const descriptionOrdered = orderCandidatesBy(
    byProvider,
    DESCRIPTION_PRIORITY_ORDER
  );

  const primary = defaultOrdered[0];
  if (!primary) {
    return null;
  }

  const titleCandidate = defaultOrdered.find((c) => Boolean(c.title.trim()));
  const title = titleCandidate?.title ?? primary.title;
  const subtitle =
    defaultOrdered.find((c) => Boolean(c.subtitle?.trim()))?.subtitle ?? null;

  const authorsCandidate = defaultOrdered.find((c) => c.authors.length > 0);
  const authors = authorsCandidate
    ? dedupeAuthors(authorsCandidate.authors)
    : [];

  const seriesNameCandidate = seriesOrdered.find((c) =>
    Boolean(c.seriesName?.trim())
  );
  const seriesName = seriesNameCandidate?.seriesName ?? null;

  let seriesNumber: number | null =
    seriesNameCandidate?.seriesNumber ?? null;
  if (seriesNumber === null && seriesName !== null) {
    const normalizedSeries = seriesName.trim().toLowerCase();
    const matchingNumCandidate = seriesOrdered.find(
      (c) =>
        c.seriesNumber !== null &&
        c.seriesName !== null &&
        c.seriesName.trim().toLowerCase() === normalizedSeries
    );
    const anyNumCandidate = seriesOrdered.find((c) => c.seriesNumber !== null);
    seriesNumber =
      matchingNumCandidate?.seriesNumber ??
      anyNumCandidate?.seriesNumber ??
      null;
  } else if (seriesNumber === null) {
    seriesNumber =
      seriesOrdered.find((c) => c.seriesNumber !== null)?.seriesNumber ?? null;
  }

  const description =
    descriptionOrdered.find((c) => Boolean(c.description?.trim()))
      ?.description ?? null;

  const pageCount =
    defaultOrdered.find((c) => c.pageCount !== null)?.pageCount ?? null;
  const publishedYear =
    defaultOrdered.find((c) => c.publishedYear !== null)?.publishedYear ?? null;

  const genres = normalizeGenres(
    defaultOrdered.flatMap((c) => c.genres),
    8
  );

  const httpsCover = defaultOrdered.find((c) =>
    c.coverUrl?.startsWith('https://')
  )?.coverUrl;
  const anyCover = defaultOrdered.find((c) => c.coverUrl !== null)?.coverUrl;
  const coverUrl = httpsCover ?? anyCover ?? null;

  const language =
    defaultOrdered.find((c) => Boolean(c.language?.trim()))?.language ?? null;
  const publisher =
    defaultOrdered.find((c) => Boolean(c.publisher?.trim()))?.publisher ?? null;

  const isbn13 =
    defaultOrdered.find((c) => c.isbn13 !== null)?.isbn13 ?? fallbackIsbn13;
  const isbn10 =
    defaultOrdered.find((c) => c.isbn10 !== null)?.isbn10 ?? fallbackIsbn10;

  return {
    source: primary.source,
    externalId: primary.externalId,
    title,
    subtitle,
    authors,
    seriesName,
    seriesNumber,
    isbn10,
    isbn13,
    pageCount,
    publishedYear,
    genres,
    description,
    coverUrl,
    language,
    publisher,
  };
}

export class MetadataAggregator {
  private readonly providers: MetadataProvider[];
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => Date;

  private readonly isbnCache = new Map<
    string,
    CacheEntry<MetadataIsbnResponse>
  >();
  private readonly searchCache = new Map<
    string,
    CacheEntry<MetadataSearchResponse>
  >();

  constructor(options: MetadataAggregatorOptions) {
    this.providers = options.providers;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000;
    this.maxCacheEntries = options.maxCacheEntries ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  private getCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string
  ): T | null {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }

    const ageMs = this.now().getTime() - entry.cachedAtMs;
    if (ageMs > this.cacheTtlMs || ageMs < 0) {
      cache.delete(key);
      return null;
    }

    // LRU-Refresh: Eintrag ans Ende der Map verschieben
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  private setCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T
  ): void {
    if (this.maxCacheEntries <= 0) {
      return;
    }
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= this.maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, {
      value,
      cachedAtMs: this.now().getTime(),
    });
  }

  private async runWithTimeout<T>(
    provider: MetadataProvider,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<
    | { ok: true; value: T; durationMs: number }
    | { ok: false; timedOut: boolean; errorMessage: string; durationMs: number }
  > {
    const controller = new AbortController();
    const startMs = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const value = await fn(controller.signal);
      return {
        ok: true,
        value,
        durationMs: Math.max(0, Date.now() - startMs),
      };
    } catch (error) {
      const isAbort =
        timedOut ||
        controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError');
      const errorMessage = isAbort
        ? `Zeitüberschreitung nach ${this.timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : 'Unbekannter Provider-Fehler';
      return {
        ok: false,
        timedOut: isAbort,
        errorMessage,
        durationMs: Math.max(0, Date.now() - startMs),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  getProvidersInfo(): MetadataProvidersResponse {
    return {
      providers: this.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        enabled: provider.isEnabled(),
        requiresApiKey: provider.requiresApiKey,
      })),
    };
  }

  async lookupByIsbn(
    isbn13: string,
    isbn10: string | null
  ): Promise<MetadataIsbnResponse> {
    const cacheKey = `isbn:${isbn13}`;
    const cached = this.getCached(this.isbnCache, cacheKey);
    if (cached) {
      return cached;
    }

    const executions = await Promise.allSettled(
      this.providers.map(async (provider) => {
        if (!provider.isEnabled()) {
          return {
            provider,
            status: {
              provider: provider.id,
              displayName: provider.displayName,
              enabled: false,
              status: 'disabled',
            } satisfies ProviderStatus,
            candidate: null as MetadataCandidate | null,
          };
        }

        const outcome = await this.runWithTimeout(provider, (signal) =>
          provider.lookupByIsbn(isbn13, isbn10, signal)
        );

        if (!outcome.ok) {
          return {
            provider,
            status: {
              provider: provider.id,
              displayName: provider.displayName,
              enabled: true,
              status: outcome.timedOut ? 'timeout' : 'error',
              errorMessage: outcome.errorMessage,
              durationMs: outcome.durationMs,
            } satisfies ProviderStatus,
            candidate: null as MetadataCandidate | null,
          };
        }

        return {
          provider,
          status: {
            provider: provider.id,
            displayName: provider.displayName,
            enabled: true,
            status: outcome.value ? 'ok' : 'empty',
            durationMs: outcome.durationMs,
          } satisfies ProviderStatus,
          candidate: outcome.value,
        };
      })
    );

    const providerStatuses: ProviderStatus[] = [];
    const candidates: MetadataCandidate[] = [];

    for (let i = 0; i < executions.length; i++) {
      const exec = executions[i];
      const provider = this.providers[i];
      if (!exec || !provider) continue;

      if (exec.status === 'fulfilled') {
        providerStatuses.push(exec.value.status);
        if (exec.value.candidate) {
          candidates.push(exec.value.candidate);
        }
      } else {
        providerStatuses.push({
          provider: provider.id,
          displayName: provider.displayName,
          enabled: provider.isEnabled(),
          status: 'error',
          errorMessage:
            exec.reason instanceof Error
              ? exec.reason.message
              : 'Unbekannter Fehler',
        });
      }
    }

    candidates.sort(
      (a, b) => PRIORITY_RANK[a.source] - PRIORITY_RANK[b.source]
    );

    const merged = mergeCandidates(candidates, isbn13, isbn10);
    const response: MetadataIsbnResponse = {
      isbn10,
      isbn13,
      merged,
      candidates,
      providerStatuses,
    };

    const enabledStatuses = providerStatuses.filter((s) => s.enabled);
    const allEnabledFailed =
      enabledStatuses.length > 0 &&
      enabledStatuses.every((s) => s.status === 'error' || s.status === 'timeout');

    if (!allEnabledFailed) {
      this.setCached(this.isbnCache, cacheKey, response);
    }

    return response;
  }

  async search(query: string, limit = 10): Promise<MetadataSearchResponse> {
    const trimmedQuery = query.trim();
    const clampedLimit = Math.max(1, Math.min(25, limit));
    const cacheKey = `search:${clampedLimit}:${trimmedQuery.toLowerCase()}`;

    const cached = this.getCached(this.searchCache, cacheKey);
    if (cached) {
      return cached;
    }

    const executions = await Promise.allSettled(
      this.providers.map(async (provider) => {
        if (!provider.isEnabled()) {
          return {
            status: {
              provider: provider.id,
              displayName: provider.displayName,
              enabled: false,
              status: 'disabled',
            } satisfies ProviderStatus,
            items: [] as MetadataCandidate[],
          };
        }

        const outcome = await this.runWithTimeout(provider, (signal) =>
          provider.search(trimmedQuery, clampedLimit, signal)
        );

        if (!outcome.ok) {
          return {
            status: {
              provider: provider.id,
              displayName: provider.displayName,
              enabled: true,
              status: outcome.timedOut ? 'timeout' : 'error',
              errorMessage: outcome.errorMessage,
              durationMs: outcome.durationMs,
            } satisfies ProviderStatus,
            items: [] as MetadataCandidate[],
          };
        }

        return {
          status: {
            provider: provider.id,
            displayName: provider.displayName,
            enabled: true,
            status: outcome.value.length > 0 ? 'ok' : 'empty',
            durationMs: outcome.durationMs,
          } satisfies ProviderStatus,
          items: outcome.value,
        };
      })
    );

    const providerStatuses: ProviderStatus[] = [];
    const collected: MetadataCandidate[] = [];

    for (let i = 0; i < executions.length; i++) {
      const exec = executions[i];
      const provider = this.providers[i];
      if (!exec || !provider) continue;

      if (exec.status === 'fulfilled') {
        providerStatuses.push(exec.value.status);
        collected.push(...exec.value.items);
      } else {
        providerStatuses.push({
          provider: provider.id,
          displayName: provider.displayName,
          enabled: provider.isEnabled(),
          status: 'error',
          errorMessage:
            exec.reason instanceof Error
              ? exec.reason.message
              : 'Unbekannter Fehler',
        });
      }
    }

    collected.sort(
      (a, b) => PRIORITY_RANK[a.source] - PRIORITY_RANK[b.source]
    );

    const deduped: MetadataCandidate[] = [];
    const seenExternalKeys = new Set<string>();
    const seenIsbn13 = new Set<string>();

    for (const candidate of collected) {
      const externalKey = `${candidate.source}:${candidate.externalId}`;
      if (seenExternalKeys.has(externalKey)) {
        continue;
      }
      if (candidate.isbn13 && seenIsbn13.has(candidate.isbn13)) {
        continue;
      }

      seenExternalKeys.add(externalKey);
      if (candidate.isbn13) {
        seenIsbn13.add(candidate.isbn13);
      }

      deduped.push(candidate);
      if (deduped.length >= clampedLimit) {
        break;
      }
    }

    const response: MetadataSearchResponse = {
      query: trimmedQuery,
      candidates: deduped,
      providerStatuses,
    };

    const enabledStatuses = providerStatuses.filter((s) => s.enabled);
    const allEnabledFailed =
      enabledStatuses.length > 0 &&
      enabledStatuses.every((s) => s.status === 'error' || s.status === 'timeout');

    if (!allEnabledFailed) {
      this.setCached(this.searchCache, cacheKey, response);
    }

    return response;
  }
}
