import type { MetadataCandidate } from '@bibliolisa/shared';
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

export interface GoogleBooksAdapterOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

interface GoogleBooksIndustryIdentifier {
  type?: string;
  identifier?: string;
}

interface GoogleBooksVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  industryIdentifiers?: GoogleBooksIndustryIdentifier[];
  pageCount?: number;
  categories?: string[];
  imageLinks?: {
    extraLarge?: string;
    large?: string;
    medium?: string;
    small?: string;
    thumbnail?: string;
    smallThumbnail?: string;
  };
  language?: string;
}

interface GoogleBooksItem {
  id?: string;
  volumeInfo?: GoogleBooksVolumeInfo;
}

interface GoogleBooksVolumesResponse {
  items?: GoogleBooksItem[];
}

function pickBestCoverUrl(
  imageLinks: GoogleBooksVolumeInfo['imageLinks']
): string | null {
  if (!imageLinks) return null;
  const candidates = [
    imageLinks.extraLarge,
    imageLinks.large,
    imageLinks.medium,
    imageLinks.small,
    imageLinks.thumbnail,
    imageLinks.smallThumbnail,
  ];
  for (const raw of candidates) {
    const normalized = normalizeCoverUrl(raw);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function splitCategories(categories: readonly string[] | undefined): string[] {
  if (!categories) return [];
  const expanded: string[] = [];
  for (const category of categories) {
    expanded.push(category);
    if (category.includes('/')) {
      for (const segment of category.split('/')) {
        const trimmed = segment.trim();
        if (trimmed) {
          expanded.push(trimmed);
        }
      }
    }
  }
  return normalizeGenres(expanded);
}

function mapVolumeItem(
  item: GoogleBooksItem,
  fallbackIsbn13: string | null = null,
  fallbackIsbn10: string | null = null
): MetadataCandidate | null {
  const info = item.volumeInfo;
  if (!info?.title?.trim()) {
    return null;
  }

  const rawSubtitle = info.subtitle?.trim() || null;
  const titleExtraction = extractSeriesFromTitle(info.title, rawSubtitle);
  const rawIdentifiers = (info.industryIdentifiers ?? [])
    .map((entry) => entry.identifier)
    .filter((val): val is string => Boolean(val));

  const isbns = resolveIsbnPair(rawIdentifiers, fallbackIsbn13, fallbackIsbn10);
  const rawDescription = info.description ? stripHtmlTags(info.description) : '';

  return {
    source: 'google_books',
    externalId: item.id?.trim() || isbns.isbn13 || info.title.trim(),
    title: titleExtraction.cleanTitle || info.title.trim(),
    subtitle: rawSubtitle,
    authors: dedupeAuthors(info.authors ?? []),
    seriesName: titleExtraction.seriesName,
    seriesNumber: titleExtraction.seriesNumber,
    isbn10: isbns.isbn10,
    isbn13: isbns.isbn13,
    pageCount: sanitizePageCount(info.pageCount),
    publishedYear: parsePublishedYear(info.publishedDate),
    genres: splitCategories(info.categories),
    description: rawDescription || null,
    coverUrl: pickBestCoverUrl(info.imageLinks),
    language: normalizeLanguageCode(info.language),
    publisher: info.publisher?.trim() || null,
  };
}

export class GoogleBooksAdapter implements MetadataProvider {
  readonly id = 'google_books' as const;
  readonly displayName = 'Google Books';
  readonly requiresApiKey = false;

  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: GoogleBooksAdapterOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (
      options.baseUrl ?? 'https://www.googleapis.com/books/v1'
    ).replace(/\/+$/, '');
  }

  isEnabled(): boolean {
    return true;
  }

  private async queryVolumes(
    query: string,
    maxResults: number,
    signal: AbortSignal
  ): Promise<GoogleBooksItem[]> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    if (this.apiKey) {
      params.set('key', this.apiKey);
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/volumes?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Google Books HTTP ${response.status}`);
    }

    const data = (await response.json()) as GoogleBooksVolumesResponse;
    return data.items ?? [];
  }

  async lookupByIsbn(
    isbn13: string,
    isbn10: string | null,
    signal: AbortSignal
  ): Promise<MetadataCandidate | null> {
    let items = await this.queryVolumes(`isbn:${isbn13}`, 5, signal);
    if (items.length === 0 && isbn10) {
      items = await this.queryVolumes(`isbn:${isbn10}`, 5, signal);
    }
    if (items.length === 0) {
      return null;
    }

    const exactMatch = items.find((item) => {
      const identifiers = item.volumeInfo?.industryIdentifiers ?? [];
      return identifiers.some((entry) => {
        const cleaned = entry.identifier?.replace(/[\s-]+/g, '').toUpperCase();
        return cleaned === isbn13 || (isbn10 !== null && cleaned === isbn10);
      });
    });

    const chosen = exactMatch ?? items[0];
    return chosen ? mapVolumeItem(chosen, isbn13, isbn10) : null;
  }

  async search(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MetadataCandidate[]> {
    const clampedLimit = Math.max(1, Math.min(25, limit));
    const items = await this.queryVolumes(query, clampedLimit, signal);

    const results: MetadataCandidate[] = [];
    for (const item of items) {
      const mapped = mapVolumeItem(item);
      if (mapped) {
        results.push(mapped);
      }
      if (results.length >= clampedLimit) {
        break;
      }
    }
    return results;
  }
}
