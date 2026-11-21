import {
  normalizeIsbn,
  SeriesNumberSchema,
  type MetadataCandidate,
  type MetadataProviderId,
} from '@bibliolisa/shared';

export type FetchLike = typeof globalThis.fetch;

export interface MetadataProvider {
  readonly id: MetadataProviderId;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  isEnabled(): boolean;
  lookupByIsbn(
    isbn13: string,
    isbn10: string | null,
    signal: AbortSignal
  ): Promise<MetadataCandidate | null>;
  search(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MetadataCandidate[]>;
}

const NOISE_GENRE_EXACT = new Set([
  'protected daisy',
  'accessible book',
  'accessible books',
  'in library',
  'lending library',
  'overdrive',
  'large type books',
  'open library staff picks',
  'internet archive wishlist',
  'non-classifiable',
  'general',
  'fiction / general',
  'juvenile fiction / general',
]);

const NOISE_GENRE_PREFIXES = [
  'nyt:',
  'award:',
  'series:',
  'place:',
  'time:',
  'person:',
  'people:',
  'lcgft:',
  'bisac:',
  'ddc:',
  'lcc:',
];

const PLACEHOLDER_COVER_PATTERN =
  /no_cover|nocover|nophoto|no-photo|placeholder|image_not_available/i;

const ISO_639_2_TO_1: Record<string, string> = {
  ger: 'de',
  deu: 'de',
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  dut: 'nl',
  nld: 'nl',
  rus: 'ru',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  pol: 'pl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  tur: 'tr',
  ara: 'ar',
  kor: 'ko',
};

const NON_SERIES_PAREN_HINTS =
  /\b(edition|auflage|ausgabe|unabridged|abridged|reprint|hardcover|paperback|kindle|illustrator|translator|german|english|french|spanish)\b/i;

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number(dec);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    });
}

export function stripHtmlTags(raw: string): string {
  const withLineBreaks = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ');

  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, '');
  const decoded = decodeBasicHtmlEntities(withoutTags);

  return decoded
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseSeriesNumberToken(rawNum: string): number | null {
  const normalized = rawNum.replace(',', '.').trim();
  const parsed = Number(normalized);
  const checked = SeriesNumberSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

export function parseSeriesString(raw: string): {
  seriesName: string | null;
  seriesNumber: number | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { seriesName: null, seriesNumber: null };
  }

  // Muster mit explizitem Marker: "Reihe, Band 1.5", "Mistborn #2", "Series; bk. 3"
  const explicitMatch =
    /^(.*?)(?:[,;]\s*|\s+)(?:Band|Bd\.?|Teil|Book|Bk\.?|Vol\.?|Volume|Nr\.?|No\.?|Part|#)\s*(\d+(?:[.,]\d+)?)\s*$/i.exec(
      trimmed
    );
  if (explicitMatch) {
    const name = explicitMatch[1]?.replace(/[,;\-:\s]+$/, '').trim() ?? '';
    const num = explicitMatch[2] ? parseSeriesNumberToken(explicitMatch[2]) : null;
    if (name && num !== null) {
      return { seriesName: name, seriesNumber: num };
    }
  }

  // Muster mit Nummer in Klammern am Ende: "Mistborn (1.5)"
  const parenMatch = /^(.*?)\s*\(\s*#?\s*(\d+(?:[.,]\d+)?)\s*\)\s*$/.exec(trimmed);
  if (parenMatch) {
    const name = parenMatch[1]?.trim() ?? '';
    const num = parenMatch[2] ? parseSeriesNumberToken(parenMatch[2]) : null;
    if (name && num !== null && !(num >= 1000 && num <= 2100 && Number.isInteger(num))) {
      return { seriesName: name, seriesNumber: num };
    }
  }

  // Muster mit schlichter Nummer am Ende (keine Jahreszahl)
  const trailingNumberMatch = /^(.*?)(?:,\s*|\s+)(\d+(?:[.,]\d+)?)\s*$/.exec(trimmed);
  if (trailingNumberMatch) {
    const name = trailingNumberMatch[1]?.replace(/[,;\-:\s]+$/, '').trim() ?? '';
    const num = trailingNumberMatch[2]
      ? parseSeriesNumberToken(trailingNumberMatch[2])
      : null;
    if (
      name &&
      num !== null &&
      !NON_SERIES_PAREN_HINTS.test(name) &&
      !(num >= 1800 && num <= 2100 && Number.isInteger(num))
    ) {
      return { seriesName: name, seriesNumber: num };
    }
  }

  if (NON_SERIES_PAREN_HINTS.test(trimmed) || /^\d{4}$/.test(trimmed)) {
    return { seriesName: null, seriesNumber: null };
  }

  return { seriesName: trimmed, seriesNumber: null };
}

function tryExtractSeriesFromParenContent(inner: string): {
  seriesName: string;
  seriesNumber: number | null;
} | null {
  const cleaned = inner.trim();
  if (!cleaned || NON_SERIES_PAREN_HINTS.test(cleaned)) {
    return null;
  }

  if (/^\d{4}$/.test(cleaned)) {
    return null;
  }

  const explicitMatch =
    /^(.*?)(?:[,;]\s*|\s+)(?:Band|Bd\.?|Teil|Book|Bk\.?|Vol\.?|Volume|Nr\.?|No\.?|Part|#)\s*(\d+(?:[.,]\d+)?)\s*$/i.exec(
      cleaned
    );
  if (explicitMatch) {
    const name = explicitMatch[1]?.replace(/[,;\-:\s]+$/, '').trim() ?? '';
    const num = explicitMatch[2] ? parseSeriesNumberToken(explicitMatch[2]) : null;
    if (name && num !== null) {
      return { seriesName: name, seriesNumber: num };
    }
  }

  const numericMatch = /^(.*?)(?:,\s*|\s+)(\d+(?:[.,]\d+)?)\s*$/.exec(cleaned);
  if (numericMatch) {
    const name = numericMatch[1]?.replace(/[,;\-:\s]+$/, '').trim() ?? '';
    const num = numericMatch[2] ? parseSeriesNumberToken(numericMatch[2]) : null;
    if (
      name &&
      num !== null &&
      num < 100 &&
      !NON_SERIES_PAREN_HINTS.test(name)
    ) {
      return { seriesName: name, seriesNumber: num };
    }
  }

  return null;
}

export function extractSeriesFromTitle(
  title: string,
  subtitle?: string | null
): {
  cleanTitle: string;
  seriesName: string | null;
  seriesNumber: number | null;
} {
  const trimmedTitle = title.trim();
  const parenSuffix = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(trimmedTitle);
  if (parenSuffix) {
    const baseTitle = parenSuffix[1]?.trim() ?? '';
    const inner = parenSuffix[2] ?? '';
    const parsed = tryExtractSeriesFromParenContent(inner);
    if (parsed && baseTitle) {
      return {
        cleanTitle: baseTitle,
        seriesName: parsed.seriesName,
        seriesNumber: parsed.seriesNumber,
      };
    }
  }

  if (subtitle) {
    const trimmedSub = subtitle.trim();
    const subParen = /^\(([^()]+)\)$/.exec(trimmedSub);
    const subCandidate = subParen?.[1] ?? trimmedSub;
    const explicitSub =
      /^(.*?)(?:[,;]\s*|\s+)(?:Band|Bd\.?|Teil|Book|Bk\.?|Vol\.?|Volume|Nr\.?|No\.?|Part|#)\s*(\d+(?:[.,]\d+)?)\s*$/i.exec(
        subCandidate
      );
    if (explicitSub) {
      const name = explicitSub[1]?.replace(/[,;\-:\s]+$/, '').trim() ?? '';
      const num = explicitSub[2] ? parseSeriesNumberToken(explicitSub[2]) : null;
      if (name && num !== null && !NON_SERIES_PAREN_HINTS.test(name)) {
        return {
          cleanTitle: trimmedTitle,
          seriesName: name,
          seriesNumber: num,
        };
      }
    }
  }

  return {
    cleanTitle: trimmedTitle,
    seriesName: null,
    seriesNumber: null,
  };
}

export function parsePublishedYear(
  raw: string | number | null | undefined
): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw === 'number') {
    const year = Math.trunc(raw);
    return Number.isInteger(year) && year >= 1000 && year <= 2100 ? year : null;
  }

  const match = /(?:^|\D)(1\d{3}|20\d{2}|2100)(?:\D|$)/.exec(raw.trim());
  if (!match?.[1]) {
    return null;
  }
  const year = Number(match[1]);
  return year >= 1000 && year <= 2100 ? year : null;
}

export function sanitizePageCount(
  raw: number | null | undefined
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  const rounded = Math.round(raw);
  return rounded > 0 && rounded <= 50000 ? rounded : null;
}

export function normalizeGenres(
  genres: readonly string[],
  maxCount = 8
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of genres) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 60) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (NOISE_GENRE_EXACT.has(lower)) {
      continue;
    }
    if (NOISE_GENRE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      continue;
    }
    if (/^[\d\W]+$/.test(trimmed)) {
      continue;
    }
    if (seen.has(lower)) {
      continue;
    }

    seen.add(lower);
    result.push(trimmed);
    if (result.length >= maxCount) {
      break;
    }
  }

  return result;
}

export function normalizeCoverUrl(
  raw: string | null | undefined
): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'books.google.com' ||
      parsed.hostname.endsWith('.books.google.com') ||
      parsed.hostname === 'covers.openlibrary.org')
  ) {
    parsed.protocol = 'https:';
  }

  const normalized = parsed.toString();
  if (normalized.length > 2000 || PLACEHOLDER_COVER_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

export function dedupeAuthors(authors: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of authors) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

export function normalizeLanguageCode(
  raw: string | null | undefined
): string | null {
  if (!raw) {
    return null;
  }

  let code = raw.trim().toLowerCase();
  if (!code) {
    return null;
  }

  if (code.includes('/')) {
    const segments = code.split('/').filter(Boolean);
    code = segments[segments.length - 1] ?? '';
  }

  if (code.includes('-') || code.includes('_')) {
    code = code.split(/[-_]/)[0] ?? '';
  }

  if (code.length === 3 && ISO_639_2_TO_1[code]) {
    code = ISO_639_2_TO_1[code]!;
  }

  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

export function resolveIsbnPair(
  rawIsbns: readonly string[],
  fallbackIsbn13: string | null = null,
  fallbackIsbn10: string | null = null
): { isbn10: string | null; isbn13: string | null } {
  let isbn10: string | null = null;
  let isbn13: string | null = null;

  for (const raw of rawIsbns) {
    const norm = normalizeIsbn(raw);
    if (!norm.valid) continue;
    if (isbn13 === null && norm.isbn13 !== null) {
      isbn13 = norm.isbn13;
    }
    if (isbn10 === null && norm.isbn10 !== null) {
      isbn10 = norm.isbn10;
    }
  }

  if (isbn13 === null && fallbackIsbn13) {
    const norm = normalizeIsbn(fallbackIsbn13);
    if (norm.valid) {
      isbn13 = norm.isbn13;
      isbn10 = isbn10 ?? norm.isbn10;
    }
  }

  if (isbn10 === null && fallbackIsbn10) {
    const norm = normalizeIsbn(fallbackIsbn10);
    if (norm.valid) {
      isbn10 = norm.isbn10;
      isbn13 = isbn13 ?? norm.isbn13;
    }
  }

  return { isbn10, isbn13 };
}
