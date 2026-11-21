import { SeriesNumberSchema, type MetadataCandidate } from '@bibliolisa/shared';
import {
  dedupeAuthors,
  extractSeriesFromTitle,
  normalizeCoverUrl,
  normalizeGenres,
  normalizeLanguageCode,
  parsePublishedYear,
  resolveIsbnPair,
  sanitizePageCount,
  stripHtmlTags,
  type FetchLike,
  type MetadataProvider,
} from './types.js';

export interface HardcoverAdapterOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
}

interface HardcoverEditionRecord {
  id?: number | string;
  title?: string | null;
  subtitle?: string | null;
  isbn_10?: string | null;
  isbn_13?: string | null;
  pages?: number | null;
  release_year?: number | null;
  release_date?: string | null;
  publisher?: { name?: string | null } | null;
  language?: { code2?: string | null; language?: string | null } | null;
  image?: { url?: string | null } | null;
  book?: {
    id?: number | string;
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    pages?: number | null;
    release_year?: number | null;
    cached_tags?: unknown;
    image?: { url?: string | null } | null;
    contributions?: Array<{ author?: { name?: string | null } | null }> | null;
    book_series?: Array<{
      position?: number | string | null;
      series?: { name?: string | null } | null;
    }> | null;
  } | null;
}

interface HardcoverSearchDocument {
  id?: number | string;
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  author_names?: string[] | null;
  contributions?: Array<{ author?: { name?: string | null } | null }> | null;
  isbns?: string[] | null;
  pages?: number | null;
  release_year?: number | null;
  genres?: string[] | null;
  tags?: string[] | null;
  image?: { url?: string | null } | null;
  featured_series?: {
    position?: number | string | null;
    series?: { name?: string | null } | null;
  } | null;
  series_names?: string[] | null;
}

function normalizeBearerKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^Bearer\s+/i, '').trim() || undefined;
}

function parsePositionNumber(
  raw: number | string | null | undefined
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
  const checked = SeriesNumberSchema.safeParse(num);
  return checked.success ? checked.data : null;
}

function extractHardcoverTags(cachedTags: unknown): string[] {
  const collected: string[] = [];

  const collectTagEntry = (entry: unknown) => {
    if (typeof entry === 'string') {
      collected.push(entry);
    } else if (entry && typeof entry === 'object' && 'tag' in entry) {
      const tagValue = (entry as { tag?: unknown }).tag;
      if (typeof tagValue === 'string') {
        collected.push(tagValue);
      }
    }
  };

  if (Array.isArray(cachedTags)) {
    for (const item of cachedTags) {
      collectTagEntry(item);
    }
  } else if (cachedTags && typeof cachedTags === 'object') {
    const obj = cachedTags as Record<string, unknown>;
    const prioritizedKeys = [
      'Genre',
      ...Object.keys(obj).filter((k) => k !== 'Genre'),
    ];
    for (const key of prioritizedKeys) {
      const list = obj[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          collectTagEntry(item);
        }
      }
    }
  }

  return normalizeGenres(collected);
}

const LOOKUP_BY_ISBN_13_ONLY_QUERY = `
  query LookupEditionByIsbn13($isbn13: String!) {
    editions(where: { isbn_13: { _eq: $isbn13 } }, limit: 5) {
      id
      title
      subtitle
      isbn_10
      isbn_13
      pages
      release_year
      release_date
      publisher { name }
      language { code2 language }
      image { url }
      book {
        id
        title
        subtitle
        description
        pages
        release_year
        cached_tags
        image { url }
        contributions { author { name } }
        book_series {
          position
          series { name }
        }
      }
    }
  }
`;

const LOOKUP_BY_ISBN_PAIR_QUERY = `
  query LookupEditionByIsbnPair($isbn13: String!, $isbn10: String!) {
    editions(
      where: {
        _or: [
          { isbn_13: { _eq: $isbn13 } }
          { isbn_10: { _eq: $isbn10 } }
        ]
      }
      limit: 5
    ) {
      id
      title
      subtitle
      isbn_10
      isbn_13
      pages
      release_year
      release_date
      publisher { name }
      language { code2 language }
      image { url }
      book {
        id
        title
        subtitle
        description
        pages
        release_year
        cached_tags
        image { url }
        contributions { author { name } }
        book_series {
          position
          series { name }
        }
      }
    }
  }
`;

const SEARCH_BOOKS_QUERY = `
  query SearchHardcoverBooks($query: String!, $limit: Int!) {
    search(query: $query, query_type: "Book", per_page: $limit, page: 1) {
      results
    }
  }
`;

export class HardcoverAdapter implements MetadataProvider {
  readonly id = 'hardcover' as const;
  readonly displayName = 'Hardcover.app';
  readonly requiresApiKey = true;

  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(options: HardcoverAdapterOptions = {}) {
    this.apiKey = normalizeBearerKey(options.apiKey);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? 'https://api.hardcover.app/v1/graphql';
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  private async postGraphql<TData>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<TData> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Hardcover HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: TData;
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors && payload.errors.length > 0 && !payload.data) {
      throw new Error(
        payload.errors[0]?.message ?? 'Hardcover GraphQL Fehler'
      );
    }

    if (!payload.data) {
      throw new Error('Hardcover lieferte keine Daten.');
    }

    return payload.data;
  }

  async lookupByIsbn(
    isbn13: string,
    isbn10: string | null,
    signal: AbortSignal
  ): Promise<MetadataCandidate | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const data = await this.postGraphql<{ editions?: HardcoverEditionRecord[] }>(
      isbn10 ? LOOKUP_BY_ISBN_PAIR_QUERY : LOOKUP_BY_ISBN_13_ONLY_QUERY,
      isbn10 ? { isbn13, isbn10 } : { isbn13 },
      signal
    );

    const editions = data.editions ?? [];
    if (editions.length === 0) {
      return null;
    }

    const chosen =
      editions.find((ed) => ed.isbn_13 === isbn13) ?? editions[0];
    if (!chosen) {
      return null;
    }

    const rawTitle = (chosen.title ?? chosen.book?.title)?.trim();
    if (!rawTitle) {
      return null;
    }

    const rawSubtitle =
      (chosen.subtitle ?? chosen.book?.subtitle)?.trim() || null;
    const titleExtraction = extractSeriesFromTitle(rawTitle, rawSubtitle);

    const primarySeries = (chosen.book?.book_series ?? []).find((entry) =>
      Boolean(entry.series?.name?.trim())
    );
    const seriesName =
      primarySeries?.series?.name?.trim() ?? titleExtraction.seriesName;
    const seriesNumber =
      parsePositionNumber(primarySeries?.position) ??
      titleExtraction.seriesNumber;

    const authors = dedupeAuthors(
      (chosen.book?.contributions ?? [])
        .map((c) => c.author?.name)
        .filter((name): name is string => Boolean(name))
    );

    const isbns = resolveIsbnPair(
      [
        ...(chosen.isbn_13 ? [chosen.isbn_13] : []),
        ...(chosen.isbn_10 ? [chosen.isbn_10] : []),
      ],
      isbn13,
      isbn10
    );

    const rawDescription = chosen.book?.description
      ? stripHtmlTags(chosen.book.description)
      : '';

    const coverUrl = normalizeCoverUrl(
      chosen.image?.url ?? chosen.book?.image?.url
    );

    return {
      source: this.id,
      externalId: String(chosen.book?.id ?? chosen.id ?? isbns.isbn13 ?? isbn13),
      title: titleExtraction.cleanTitle || rawTitle,
      subtitle: rawSubtitle,
      authors,
      seriesName,
      seriesNumber,
      isbn10: isbns.isbn10,
      isbn13: isbns.isbn13,
      pageCount: sanitizePageCount(chosen.pages ?? chosen.book?.pages),
      publishedYear: parsePublishedYear(
        chosen.release_year ?? chosen.release_date ?? chosen.book?.release_year
      ),
      genres: extractHardcoverTags(chosen.book?.cached_tags),
      description: rawDescription || null,
      coverUrl,
      language: normalizeLanguageCode(chosen.language?.code2),
      publisher: chosen.publisher?.name?.trim() || null,
    };
  }

  async search(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MetadataCandidate[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const clampedLimit = Math.max(1, Math.min(25, limit));
    const data = await this.postGraphql<{
      search?: { results?: unknown };
    }>(SEARCH_BOOKS_QUERY, { query, limit: clampedLimit }, signal);

    let rawResults = data.search?.results;
    if (typeof rawResults === 'string') {
      try {
        rawResults = JSON.parse(rawResults) as unknown;
      } catch {
        return [];
      }
    }

    const hits =
      rawResults &&
      typeof rawResults === 'object' &&
      Array.isArray((rawResults as { hits?: unknown }).hits)
        ? ((rawResults as { hits: Array<{ document?: HardcoverSearchDocument }> })
            .hits)
        : [];

    const results: MetadataCandidate[] = [];
    for (const hit of hits) {
      const doc = hit.document;
      if (!doc?.title?.trim()) continue;

      const rawSubtitle = doc.subtitle?.trim() || null;
      const titleExtraction = extractSeriesFromTitle(doc.title, rawSubtitle);
      const isbns = resolveIsbnPair(doc.isbns ?? []);

      const seriesName =
        doc.featured_series?.series?.name?.trim() ??
        doc.series_names?.[0]?.trim() ??
        titleExtraction.seriesName;
      const seriesNumber =
        parsePositionNumber(doc.featured_series?.position) ??
        titleExtraction.seriesNumber;

      const authors = dedupeAuthors([
        ...(doc.author_names ?? []),
        ...(doc.contributions ?? [])
          .map((c) => c.author?.name)
          .filter((name): name is string => Boolean(name)),
      ]);

      const rawDescription = doc.description
        ? stripHtmlTags(doc.description)
        : '';

      results.push({
        source: this.id,
        externalId: String(doc.id ?? isbns.isbn13 ?? doc.title.trim()),
        title: titleExtraction.cleanTitle || doc.title.trim(),
        subtitle: rawSubtitle,
        authors,
        seriesName,
        seriesNumber,
        isbn10: isbns.isbn10,
        isbn13: isbns.isbn13,
        pageCount: sanitizePageCount(doc.pages),
        publishedYear: parsePublishedYear(doc.release_year),
        genres: normalizeGenres([
          ...(doc.genres ?? []),
          ...(doc.tags ?? []),
        ]),
        description: rawDescription || null,
        coverUrl: normalizeCoverUrl(doc.image?.url),
        language: null,
        publisher: null,
      });

      if (results.length >= clampedLimit) {
        break;
      }
    }

    return results;
  }
}
