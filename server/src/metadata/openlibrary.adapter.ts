import type { MetadataCandidate } from '@bibliolisa/shared';
import {
  dedupeAuthors,
  extractSeriesFromTitle,
  normalizeCoverUrl,
  normalizeGenres,
  normalizeLanguageCode,
  parsePublishedYear,
  parseSeriesString,
  resolveIsbnPair,
  sanitizePageCount,
  stripHtmlTags,
  type FetchLike,
  type MetadataProvider,
} from './types.js';

const USER_AGENT = 'Bibliolisa/0.1.0 (+https://github.com/bibliolisa)';

export interface OpenLibraryAdapterOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

interface OpenLibraryEditionJson {
  key?: string;
  title?: string;
  subtitle?: string;
  series?: string[];
  isbn_10?: string[];
  isbn_13?: string[];
  number_of_pages?: number;
  publish_date?: string;
  publishers?: string[];
  languages?: Array<{ key?: string }>;
  covers?: number[];
  description?: string | { value?: string };
  subjects?: string[];
  works?: Array<{ key?: string }>;
  authors?: Array<{ key?: string }>;
  by_statement?: string;
}

interface OpenLibraryWorkJson {
  description?: string | { value?: string };
  subjects?: string[];
}

interface OpenLibraryAuthorJson {
  name?: string;
}

interface OpenLibrarySearchDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  isbn?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  publisher?: string[];
  language?: string[];
  subject?: string[];
  cover_i?: number;
}

function extractDescriptionText(
  desc: string | { value?: string } | undefined
): string | null {
  if (!desc) return null;
  const raw = typeof desc === 'string' ? desc : desc.value;
  if (!raw) return null;
  const cleaned = stripHtmlTags(raw);
  return cleaned || null;
}

function splitByStatement(statement: string | undefined): string[] {
  if (!statement) return [];
  const cleaned = statement.replace(/^(by|von)\s+/i, '').trim();
  if (!cleaned) return [];
  return dedupeAuthors(cleaned.split(/\s*(?:,|;|&|\band\b|\bund\b)\s*/i));
}

export class OpenLibraryAdapter implements MetadataProvider {
  readonly id = 'openlibrary' as const;
  readonly displayName = 'Open Library';
  readonly requiresApiKey = false;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: OpenLibraryAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://openlibrary.org').replace(
      /\/+$/,
      ''
    );
  }

  isEnabled(): boolean {
    return true;
  }

  private async fetchJson<T>(
    pathOrUrl: string,
    signal: AbortSignal,
    allowNotFound = false
  ): Promise<T | null> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal,
    });

    if (allowNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Open Library HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  }

  async lookupByIsbn(
    isbn13: string,
    isbn10: string | null,
    signal: AbortSignal
  ): Promise<MetadataCandidate | null> {
    let edition = await this.fetchJson<OpenLibraryEditionJson>(
      `/isbn/${encodeURIComponent(isbn13)}.json`,
      signal,
      true
    );

    if (!edition && isbn10) {
      edition = await this.fetchJson<OpenLibraryEditionJson>(
        `/isbn/${encodeURIComponent(isbn10)}.json`,
        signal,
        true
      );
    }

    if (!edition || !edition.title?.trim()) {
      return null;
    }

    const workKey = edition.works?.[0]?.key;
    const authorKeys = (edition.authors ?? [])
      .map((a) => a.key)
      .filter((k): k is string => Boolean(k))
      .slice(0, 3);

    const [workResult, ...authorResults] = await Promise.allSettled([
      workKey
        ? this.fetchJson<OpenLibraryWorkJson>(`${workKey}.json`, signal, true)
        : Promise.resolve(null),
      ...authorKeys.map((key) =>
        this.fetchJson<OpenLibraryAuthorJson>(`${key}.json`, signal, true)
      ),
    ]);

    const work =
      workResult.status === 'fulfilled' ? workResult.value : null;

    const fetchedAuthors: string[] = [];
    for (const res of authorResults) {
      if (res.status === 'fulfilled' && res.value?.name) {
        fetchedAuthors.push(res.value.name);
      }
    }

    const authors =
      fetchedAuthors.length > 0
        ? dedupeAuthors(fetchedAuthors)
        : splitByStatement(edition.by_statement);

    const rawSubtitle = edition.subtitle?.trim() || null;
    const titleExtraction = extractSeriesFromTitle(edition.title, rawSubtitle);

    let seriesName: string | null = null;
    let seriesNumber: number | null = null;
    if (edition.series && edition.series.length > 0 && edition.series[0]) {
      const parsedSeries = parseSeriesString(edition.series[0]);
      seriesName = parsedSeries.seriesName;
      seriesNumber = parsedSeries.seriesNumber;
    }
    if (seriesName === null && titleExtraction.seriesName !== null) {
      seriesName = titleExtraction.seriesName;
      seriesNumber = titleExtraction.seriesNumber;
    } else if (
      seriesName !== null &&
      seriesNumber === null &&
      titleExtraction.seriesNumber !== null
    ) {
      seriesNumber = titleExtraction.seriesNumber;
    }

    const resolvedIsbns = resolveIsbnPair(
      [...(edition.isbn_13 ?? []), ...(edition.isbn_10 ?? [])],
      isbn13,
      isbn10
    );

    const coverId = (edition.covers ?? []).find(
      (id) => typeof id === 'number' && id > 0
    );
    const coverUrl = coverId
      ? normalizeCoverUrl(
          `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`
        )
      : null;

    const description =
      extractDescriptionText(edition.description) ??
      extractDescriptionText(work?.description);

    const genres = normalizeGenres([
      ...(edition.subjects ?? []),
      ...(work?.subjects ?? []),
    ]);

    const externalId =
      edition.key?.replace(/^\/books\//, '').trim() || resolvedIsbns.isbn13 || isbn13;

    return {
      source: this.id,
      externalId,
      title: titleExtraction.cleanTitle || edition.title.trim(),
      subtitle: rawSubtitle,
      authors,
      seriesName,
      seriesNumber,
      isbn10: resolvedIsbns.isbn10,
      isbn13: resolvedIsbns.isbn13,
      pageCount: sanitizePageCount(edition.number_of_pages),
      publishedYear: parsePublishedYear(edition.publish_date),
      genres,
      description,
      coverUrl,
      language: normalizeLanguageCode(edition.languages?.[0]?.key),
      publisher: edition.publishers?.[0]?.trim() || null,
    };
  }

  async search(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MetadataCandidate[]> {
    const clampedLimit = Math.max(1, Math.min(25, limit));
    const params = new URLSearchParams({
      q: query,
      limit: String(clampedLimit),
      fields:
        'key,title,subtitle,author_name,isbn,first_publish_year,number_of_pages_median,publisher,language,subject,cover_i',
    });

    const data = await this.fetchJson<{ docs?: OpenLibrarySearchDoc[] }>(
      `/search.json?${params.toString()}`,
      signal,
      false
    );

    const docs = data?.docs ?? [];
    const results: MetadataCandidate[] = [];

    for (const doc of docs) {
      if (!doc.title?.trim()) continue;
      const rawSubtitle = doc.subtitle?.trim() || null;
      const titleExtraction = extractSeriesFromTitle(doc.title, rawSubtitle);
      const isbns = resolveIsbnPair(doc.isbn ?? []);
      const coverUrl =
        typeof doc.cover_i === 'number' && doc.cover_i > 0
          ? normalizeCoverUrl(
              `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg?default=false`
            )
          : null;

      results.push({
        source: this.id,
        externalId:
          doc.key?.replace(/^\/works\//, '').trim() ||
          isbns.isbn13 ||
          doc.title.trim(),
        title: titleExtraction.cleanTitle || doc.title.trim(),
        subtitle: rawSubtitle,
        authors: dedupeAuthors(doc.author_name ?? []),
        seriesName: titleExtraction.seriesName,
        seriesNumber: titleExtraction.seriesNumber,
        isbn10: isbns.isbn10,
        isbn13: isbns.isbn13,
        pageCount: sanitizePageCount(doc.number_of_pages_median),
        publishedYear: parsePublishedYear(doc.first_publish_year),
        genres: normalizeGenres(doc.subject ?? []),
        description: null,
        coverUrl,
        language: normalizeLanguageCode(doc.language?.[0]),
        publisher: doc.publisher?.[0]?.trim() || null,
      });

      if (results.length >= clampedLimit) {
        break;
      }
    }

    return results;
  }
}
