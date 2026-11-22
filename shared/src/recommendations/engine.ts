import { toCanonicalIsoUtc } from '../schemas/common.js';
import type {
  RecommendationItem,
  RecommendationReasonCode,
  RecommendationResult,
} from '../schemas/recommendation.js';
import type { LibraryEntry } from '../schemas/user-book.js';

export interface RecommendationEngineOptions {
  limitPerCategory?: number;
  seed?: number;
  now?: Date;
  includeEntry?: boolean;
}

interface AuthorStats {
  displayName: string;
  sumWeight: number;
  count: number;
  ratingSum: number;
  ratingCount: number;
}

interface GenreStats {
  displayName: string;
  sumWeight: number;
  count: number;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function formatDecimalComma(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

function formatSeriesNumber(value: number): string {
  return String(value);
}

function normalizeSeriesKey(
  seriesName: string | null | undefined
): string | null {
  const trimmed = seriesName?.trim();
  if (!trimmed) return null;
  return normalizeKey(trimmed);
}

function getValidSeriesNumber(entry: LibraryEntry): number | null {
  const num = entry.book.seriesNumber;
  return num !== null && Number.isFinite(num) ? num : null;
}

function compareBySeriesNumberThenTitle(
  a: LibraryEntry,
  b: LibraryEntry
): number {
  const numDiff =
    (getValidSeriesNumber(a) ?? 0) - (getValidSeriesNumber(b) ?? 0);
  if (numDiff !== 0) return numDiff;
  return a.book.title.localeCompare(b.book.title) || a.id.localeCompare(b.id);
}

function compareByTitleThenId(a: LibraryEntry, b: LibraryEntry): number {
  return a.book.title.localeCompare(b.book.title) || a.id.localeCompare(b.id);
}

/**
 * Kategorieübergreifende Reihen-Schutzregel:
 * - Einzelbände (ohne gültigen Reihennamen) sind immer zulässig.
 * - Begonnene Reihen erlauben höchstens den einen nächsten offenen Band aus Stufe 1.
 * - Unbegonnene Reihen erlauben nur unnummerierte Bände oder Band <= 1.
 */
function isSeriesEligibleForRecommendation(
  entry: LibraryEntry,
  startedSeriesKeys: ReadonlySet<string>,
  nextEligibleEntryIdByStartedSeries: ReadonlyMap<string, string>
): boolean {
  const seriesKey = normalizeSeriesKey(entry.book.seriesName);
  if (seriesKey === null) {
    return true;
  }

  if (startedSeriesKeys.has(seriesKey)) {
    return nextEligibleEntryIdByStartedSeries.get(seriesKey) === entry.id;
  }

  const seriesNumber = getValidSeriesNumber(entry);
  return seriesNumber === null || seriesNumber <= 1;
}

/**
 * Deterministischer Mulberry32-PRNG für reproduzierbare „Überrasch mich“-Vorschläge.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const random = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const current = result[i];
    const target = result[j];
    if (current !== undefined && target !== undefined) {
      result[i] = target;
      result[j] = current;
    }
  }
  return result;
}

function makeItem(
  entry: LibraryEntry,
  category: RecommendationItem['category'],
  score: number,
  reasonCode: RecommendationReasonCode,
  reasonText: string,
  includeEntry: boolean
): RecommendationItem {
  const base: RecommendationItem = {
    userBookId: entry.id,
    bookId: entry.bookId,
    category,
    score: Number(score.toFixed(4)),
    reasonCode,
    reasonText,
  };
  if (includeEntry) {
    base.entry = entry;
  }
  return base;
}

function computeAffinityProfile(historyEntries: readonly LibraryEntry[]): {
  authors: Map<string, AuthorStats>;
  genres: Map<string, GenreStats>;
} {
  const authors = new Map<string, AuthorStats>();
  const genres = new Map<string, GenreStats>();

  for (const entry of historyEntries) {
    let weight: number;
    if (entry.status === 'read') {
      weight = entry.rating !== null ? (entry.rating - 2.5) * 2.0 : 1.5;
    } else if (entry.status === 'abandoned') {
      weight = entry.rating !== null ? (entry.rating - 3.0) * 2.0 : -2.0;
    } else {
      continue;
    }

    const seenAuthors = new Set<string>();
    for (const rawAuthor of entry.book.authors) {
      const key = normalizeKey(rawAuthor);
      if (!key || seenAuthors.has(key)) continue;
      seenAuthors.add(key);

      const current = authors.get(key) ?? {
        displayName: rawAuthor.trim(),
        sumWeight: 0,
        count: 0,
        ratingSum: 0,
        ratingCount: 0,
      };
      current.sumWeight += weight;
      current.count += 1;
      if (entry.rating !== null) {
        current.ratingSum += entry.rating;
        current.ratingCount += 1;
      }
      authors.set(key, current);
    }

    const seenGenres = new Set<string>();
    for (const rawGenre of entry.book.genres) {
      const key = normalizeKey(rawGenre);
      if (!key || seenGenres.has(key)) continue;
      seenGenres.add(key);

      const current = genres.get(key) ?? {
        displayName: rawGenre.trim(),
        sumWeight: 0,
        count: 0,
      };
      current.sumWeight += weight;
      current.count += 1;
      genres.set(key, current);
    }
  }

  return { authors, genres };
}

function getAuthorAffinityScore(stats: AuthorStats): number {
  return stats.sumWeight / (1 + 0.35 * (stats.count - 1));
}

function getGenreAffinityScore(stats: GenreStats): number {
  return stats.sumWeight / (stats.count + 2.0);
}

function scoreEntryAffinity(
  entry: LibraryEntry,
  authorMap: ReadonlyMap<string, AuthorStats>,
  genreMap: ReadonlyMap<string, GenreStats>
): {
  rawScore: number;
  authorScore: number;
  genreScore: number;
  bestAuthor: { displayName: string; avgRating: number | null; score: number } | null;
  topGenres: Array<{ displayName: string; score: number }>;
} {
  let bestAuthor: { displayName: string; avgRating: number | null; score: number } | null = null;
  let authorScore = 0;

  for (const rawAuthor of entry.book.authors) {
    const stats = authorMap.get(normalizeKey(rawAuthor));
    if (!stats) continue;
    const score = getAuthorAffinityScore(stats);
    if (bestAuthor === null || score > bestAuthor.score) {
      bestAuthor = {
        displayName: stats.displayName,
        avgRating: stats.ratingCount > 0 ? stats.ratingSum / stats.ratingCount : null,
        score,
      };
    }
  }
  if (bestAuthor !== null) {
    authorScore = bestAuthor.score;
  }

  const matchedGenres: Array<{ displayName: string; score: number }> = [];
  const seenGenres = new Set<string>();
  for (const rawGenre of entry.book.genres) {
    const key = normalizeKey(rawGenre);
    if (!key || seenGenres.has(key)) continue;
    seenGenres.add(key);
    const stats = genreMap.get(key);
    if (!stats) continue;
    matchedGenres.push({
      displayName: stats.displayName,
      score: getGenreAffinityScore(stats),
    });
  }

  matchedGenres.sort((a, b) => b.score - a.score);
  const positiveGenres = matchedGenres.filter((g) => g.score > 0);
  const selectedGenres = (positiveGenres.length > 0 ? positiveGenres : matchedGenres).slice(
    0,
    2
  );
  const genreScore =
    selectedGenres.length > 0
      ? selectedGenres.reduce((sum, g) => sum + g.score, 0) / selectedGenres.length
      : 0;

  const rawScore = 0.6 * authorScore + 0.4 * genreScore;

  return {
    rawScore,
    authorScore,
    genreScore,
    bestAuthor,
    topGenres: selectedGenres,
  };
}

/**
 * Reine, seiteneffektfreie dreistufige Empfehlungs-Engine für Webapp, Server und Offline-Android.
 */
export function generateRecommendations(
  entries: readonly LibraryEntry[],
  options: RecommendationEngineOptions = {}
): RecommendationResult {
  const limitPerCategory = Math.max(1, Math.min(20, options.limitPerCategory ?? 5));
  const now = options.now ?? new Date();
  const seed = Math.trunc(options.seed ?? Math.floor(now.getTime() / 86_400_000));
  const includeEntry = options.includeEntry ?? false;

  const activeEntries = entries.filter(
    (entry) => entry.deletedAt === null && entry.book.deletedAt === null
  );
  const unreadEntries = activeEntries.filter((entry) => entry.status === 'unread');

  // --- Stufe 1: Begonnene Buchreihen fortsetzen ---
  const seriesGroups = new Map<
    string,
    { displayName: string; started: LibraryEntry[]; unread: LibraryEntry[] }
  >();

  for (const entry of activeEntries) {
    const key = normalizeSeriesKey(entry.book.seriesName);
    if (key === null) continue;
    const rawSeries = entry.book.seriesName!.trim();
    const group = seriesGroups.get(key) ?? {
      displayName: rawSeries,
      started: [],
      unread: [],
    };
    if (entry.status === 'read' || entry.status === 'reading') {
      group.started.push(entry);
    } else if (entry.status === 'unread') {
      group.unread.push(entry);
    }
    seriesGroups.set(key, group);
  }

  const startedSeriesKeys = new Set<string>();
  const nextEligibleEntryIdByStartedSeries = new Map<string, string>();
  const stage1Candidates: Array<{
    item: RecommendationItem;
    hasReading: boolean;
    avgRating: number;
    latestProgressAt: string;
    seriesNameLower: string;
  }> = [];

  for (const [seriesKey, group] of seriesGroups.entries()) {
    if (group.started.length === 0) continue;
    startedSeriesKeys.add(seriesKey);
    if (group.unread.length === 0) continue;

    const numberedStarted = group.started
      .map((e) => getValidSeriesNumber(e))
      .filter((n): n is number => n !== null);
    const maxProgress =
      numberedStarted.length > 0 ? Math.max(...numberedStarted) : null;

    let picked: LibraryEntry | undefined;
    let reasonCode: RecommendationReasonCode = 'next_in_series';

    if (maxProgress !== null) {
      // Ganze Zwischenbände dürfen nicht übersprungen werden; Dezimalbände (z. B. 1.5 zwischen 1 und 2) bleiben erlaubt.
      const maxAllowedNext = Math.floor(maxProgress) + 1;
      const nextVolumes = group.unread
        .filter((e) => {
          const num = getValidSeriesNumber(e);
          return num !== null && num > maxProgress && num <= maxAllowedNext;
        })
        .sort(compareBySeriesNumberThenTitle);
      if (nextVolumes[0] !== undefined) {
        picked = nextVolumes[0];
        reasonCode = 'next_in_series';
      } else {
        const gapVolumes = group.unread
          .filter((e) => {
            const num = getValidSeriesNumber(e);
            return num !== null && num < maxProgress;
          })
          .sort(compareBySeriesNumberThenTitle);
        if (gapVolumes[0] !== undefined) {
          picked = gapVolumes[0];
          reasonCode = 'series_gap';
        } else {
          const unnumberedUnread = group.unread
            .filter((e) => getValidSeriesNumber(e) === null)
            .sort(compareByTitleThenId);
          if (unnumberedUnread[0] !== undefined) {
            picked = unnumberedUnread[0];
            reasonCode = 'series_unnumbered';
          }
        }
      }
    } else {
      const starterVolumes = group.unread
        .filter((e) => {
          const num = getValidSeriesNumber(e);
          return num !== null && num <= 1;
        })
        .sort(compareBySeriesNumberThenTitle);
      if (starterVolumes[0] !== undefined) {
        picked = starterVolumes[0];
        reasonCode = 'next_in_series';
      } else {
        const unnumberedUnread = group.unread
          .filter((e) => getValidSeriesNumber(e) === null)
          .sort(compareByTitleThenId);
        if (unnumberedUnread[0] !== undefined) {
          picked = unnumberedUnread[0];
          reasonCode = 'series_unnumbered';
        }
      }
    }

    if (picked === undefined) continue;
    nextEligibleEntryIdByStartedSeries.set(seriesKey, picked.id);

    const hasReading = group.started.some((e) => e.status === 'reading');
    const ratings = group.started
      .map((e) => e.rating)
      .filter((r): r is number => r !== null);
    const avgRating =
      ratings.length > 0
        ? ratings.reduce((acc, val) => acc + val, 0) / ratings.length
        : 3.5;

    let latestProgressAt = '';
    for (const s of group.started) {
      const candidateTs = s.finishedAt ?? s.updatedAt;
      if (candidateTs > latestProgressAt) {
        latestProgressAt = candidateTs;
      }
    }

    const seriesDisplayName = picked.book.seriesName?.trim() || group.displayName;
    const ratingHint =
      ratings.length > 0 ? ` (bisher Ø ${formatDecimalComma(avgRating)}★)` : '';
    const pickedSeriesNumber = getValidSeriesNumber(picked);
    const numLabel =
      pickedSeriesNumber !== null
        ? ` (#${formatSeriesNumber(pickedSeriesNumber)})`
        : '';

    let reasonText: string;
    if (reasonCode === 'series_gap') {
      reasonText = `Ungelesener Band${numLabel} deiner begonnenen Reihe „${seriesDisplayName}“${ratingHint}.`;
    } else if (reasonCode === 'series_unnumbered') {
      reasonText = `Weiterer ungelesener Band deiner begonnenen Reihe „${seriesDisplayName}“${ratingHint}.`;
    } else {
      reasonText = `Nächster Band${numLabel} deiner begonnenen Reihe „${seriesDisplayName}“${ratingHint}.`;
    }

    const latestMs = Date.parse(latestProgressAt) || 0;
    const score = (hasReading ? 1000 : 0) + avgRating * 100 + latestMs / 1e13;

    stage1Candidates.push({
      item: makeItem(
        picked,
        'continue_series',
        score,
        reasonCode,
        reasonText,
        includeEntry
      ),
      hasReading,
      avgRating,
      latestProgressAt,
      seriesNameLower: seriesKey,
    });
  }

  stage1Candidates.sort((a, b) => {
    if (a.hasReading !== b.hasReading) return a.hasReading ? -1 : 1;
    if (a.avgRating !== b.avgRating) return b.avgRating - a.avgRating;
    if (a.latestProgressAt !== b.latestProgressAt) {
      return a.latestProgressAt > b.latestProgressAt ? -1 : 1;
    }
    return a.seriesNameLower.localeCompare(b.seriesNameLower);
  });

  const stage1UserBookIds = new Set(stage1Candidates.map((c) => c.item.userBookId));
  const continueSeries = stage1Candidates
    .slice(0, limitPerCategory)
    .map((c) => c.item);

  // Einheitliche Kandidatenmenge für Stufe 2 & 3 (kategorieübergreifende Reihen-Schutzregel)
  const eligibleUnreadEntries = unreadEntries.filter((entry) =>
    isSeriesEligibleForRecommendation(
      entry,
      startedSeriesKeys,
      nextEligibleEntryIdByStartedSeries
    )
  );

  // --- Stufe 2: Autoren- & Genre-Affinität ---
  const { authors: authorMap, genres: genreMap } = computeAffinityProfile(activeEntries);

  const affinityByEntryId = new Map<string, number>();
  const stage2Candidates: Array<{ entry: LibraryEntry; item: RecommendationItem }> = [];

  for (const entry of eligibleUnreadEntries) {
    const affinity = scoreEntryAffinity(entry, authorMap, genreMap);
    affinityByEntryId.set(entry.id, affinity.rawScore);

    if (stage1UserBookIds.has(entry.id)) {
      continue;
    }

    if (affinity.rawScore <= 0) {
      continue;
    }

    const weightedAuthor = 0.6 * affinity.authorScore;
    const weightedGenre = 0.4 * affinity.genreScore;

    let reasonCode: RecommendationReasonCode;
    let reasonText: string;

    if (weightedAuthor >= weightedGenre && affinity.bestAuthor && affinity.authorScore > 0) {
      reasonCode = affinity.genreScore > 0 ? 'combined_affinity' : 'author_affinity';
      if (affinity.bestAuthor.avgRating !== null) {
        reasonText = `Von ${affinity.bestAuthor.displayName} – du hast Bücher dieses Autors im Schnitt mit ${formatDecimalComma(affinity.bestAuthor.avgRating)}★ bewertet.`;
      } else {
        reasonText = `Von ${affinity.bestAuthor.displayName} – passt zu deinen bisher gelesenen Büchern.`;
      }
    } else if (affinity.topGenres.length > 0) {
      reasonCode = affinity.authorScore > 0 ? 'combined_affinity' : 'genre_affinity';
      if (affinity.topGenres.length >= 2) {
        reasonText = `Passt zu deinen Top-Genres „${affinity.topGenres[0]!.displayName}“ und „${affinity.topGenres[1]!.displayName}“.`;
      } else {
        reasonText = `Passt zu deinem Top-Genre „${affinity.topGenres[0]!.displayName}“.`;
      }
    } else {
      continue;
    }

    stage2Candidates.push({
      entry,
      item: makeItem(
        entry,
        'affinity',
        affinity.rawScore,
        reasonCode,
        reasonText,
        includeEntry
      ),
    });
  }

  stage2Candidates.sort((a, b) => {
    if (a.item.score !== b.item.score) return b.item.score - a.item.score;
    if (a.entry.addedAt !== b.entry.addedAt) {
      return a.entry.addedAt < b.entry.addedAt ? -1 : 1;
    }
    return a.entry.id.localeCompare(b.entry.id);
  });

  const affinityItems = stage2Candidates
    .slice(0, limitPerCategory)
    .map((c) => c.item);

  // --- Stufe 3a: Schneller Read (< 300 Seiten) ---
  const quickReadCandidates = eligibleUnreadEntries
    .filter(
      (entry): entry is LibraryEntry & { book: { pageCount: number } } =>
        entry.book.pageCount !== null &&
        entry.book.pageCount > 0 &&
        entry.book.pageCount < 300
    )
    .sort((a, b) => {
      const pageDiff = a.book.pageCount - b.book.pageCount;
      if (pageDiff !== 0) return pageDiff;
      const affDiff =
        (affinityByEntryId.get(b.id) ?? 0) - (affinityByEntryId.get(a.id) ?? 0);
      if (affDiff !== 0) return affDiff;
      return a.book.title.localeCompare(b.book.title) || a.id.localeCompare(b.id);
    })
    .slice(0, limitPerCategory)
    .map((entry) =>
      makeItem(
        entry,
        'quick_read',
        300 - entry.book.pageCount,
        'quick_read',
        entry.book.pageCount === 1
          ? 'Kompakter Umfang mit nur 1 Seite.'
          : `Kompakter Umfang mit nur ${entry.book.pageCount} Seiten.`,
        includeEntry
      )
    );

  // --- Stufe 3b: Staubfänger (älteste ungelesene Bücher zuerst) ---
  const nowMs = now.getTime();
  const dustCollectorCandidates = [...eligibleUnreadEntries]
    .sort((a, b) => {
      if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
      return a.book.title.localeCompare(b.book.title) || a.id.localeCompare(b.id);
    })
    .slice(0, limitPerCategory)
    .map((entry) => {
      const addedMs = Date.parse(entry.addedAt);
      const days = Number.isNaN(addedMs)
        ? 0
        : Math.max(0, Math.floor((nowMs - addedMs) / 86_400_000));
      const reasonText =
        days === 1
          ? 'Seit 1 Tag auf deinem Lesestapel.'
          : `Seit ${days} Tagen auf deinem Lesestapel.`;
      return makeItem(
        entry,
        'dust_collector',
        days,
        'dust_collector',
        reasonText,
        includeEntry
      );
    });

  // --- Stufe 3c: Überrasch mich (deterministischer Mulberry32-Shuffle) ---
  const surprisePool = [...eligibleUnreadEntries].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const surpriseCandidates = shuffleWithSeed(surprisePool, seed)
    .slice(0, limitPerCategory)
    .map((entry, idx) =>
      makeItem(
        entry,
        'surprise_me',
        surprisePool.length - idx,
        'surprise_me',
        'Zufällige Auswahl aus deinem Ungelesen-Stapel.',
        includeEntry
      )
    );

  return {
    generatedAt: toCanonicalIsoUtc(now),
    seed,
    categories: {
      continue_series: continueSeries,
      affinity: affinityItems,
      quick_read: quickReadCandidates,
      dust_collector: dustCollectorCandidates,
      surprise_me: surpriseCandidates,
    },
  };
}
