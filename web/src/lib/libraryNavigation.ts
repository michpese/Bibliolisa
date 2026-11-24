const LAST_SEARCH_KEY = 'bibliolisa:library:last-search';
const SCROLL_MAP_KEY = 'bibliolisa:library:scroll-by-search';
const MAX_SCROLL_ENTRIES = 50;

export interface LibraryNavigationState {
  fromLibrary?: string;
  restoreScroll?: boolean;
}

let memoryLastSearch: string | null = null;
const memoryScrollBySearch = new Map<string, number>();

function normalizeSearch(search: string): string {
  const trimmed = search.trim();
  if (trimmed === '' || trimmed === '?') {
    return '';
  }
  return trimmed.startsWith('?') ? trimmed : `?${trimmed}`;
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return null;
    }
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readScrollMapFromStorage(): Record<string, number> {
  const storage = getSessionStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(SCROLL_MAP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[normalizeSearch(key)] = Math.round(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeScrollMapToStorage(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const obj: Record<string, number> = {};
    for (const [key, value] of memoryScrollBySearch.entries()) {
      obj[key] = value;
    }
    storage.setItem(SCROLL_MAP_KEY, JSON.stringify(obj));
  } catch {
    // sessionStorage kann im Private-Mode oder bei vollem Quota werfen
  }
}

function hydrateScrollMapIfNeeded(): void {
  if (memoryScrollBySearch.size > 0) return;
  const fromStorage = readScrollMapFromStorage();
  for (const [key, value] of Object.entries(fromStorage)) {
    memoryScrollBySearch.set(key, value);
  }
}

function enforceScrollMapCap(): void {
  while (memoryScrollBySearch.size > MAX_SCROLL_ENTRIES) {
    const oldestKey = memoryScrollBySearch.keys().next().value;
    if (oldestKey === undefined) break;
    memoryScrollBySearch.delete(oldestKey);
  }
}

/** Speichert die zuletzt aktive Query der Bibliotheksseite (inkl. leerem Query). */
export function saveLibrarySearch(search: string): void {
  const normalized = normalizeSearch(search);
  memoryLastSearch = normalized;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(LAST_SEARCH_KEY, normalized);
  } catch {
    // ignorieren
  }
}

/** Liefert die zuletzt besuchte Bibliotheks-URL inklusive Filtern/Sortierung (oder '/'). */
export function getLastLibraryUrl(): string {
  if (memoryLastSearch !== null) {
    return memoryLastSearch === '' ? '/' : `/${memoryLastSearch}`;
  }
  const storage = getSessionStorage();
  if (storage) {
    try {
      const stored = storage.getItem(LAST_SEARCH_KEY);
      if (typeof stored === 'string') {
        const normalized = normalizeSearch(stored);
        memoryLastSearch = normalized;
        return normalized === '' ? '/' : `/${normalized}`;
      }
    } catch {
      // ignorieren
    }
  }
  return '/';
}

/** Speichert die Scroll-Position (LRU-begrenzt) für einen Query-String der Bibliothek. */
export function saveLibraryScroll(search: string, scrollY: number): void {
  if (!Number.isFinite(scrollY) || scrollY < 0) {
    return;
  }
  hydrateScrollMapIfNeeded();
  const normalized = normalizeSearch(search);
  const rounded = Math.round(scrollY);
  memoryScrollBySearch.delete(normalized);
  memoryScrollBySearch.set(normalized, rounded);
  enforceScrollMapCap();
  writeScrollMapToStorage();
}

/** Liest die gespeicherte Scroll-Position für einen Query-String oder liefert null. */
export function getSavedLibraryScroll(search: string): number | null {
  const normalized = normalizeSearch(search);
  if (memoryScrollBySearch.has(normalized)) {
    return memoryScrollBySearch.get(normalized) ?? null;
  }
  const fromStorage = readScrollMapFromStorage();
  const value = fromStorage[normalized];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    hydrateScrollMapIfNeeded();
    return value;
  }
  return null;
}

/** Setzt den In-Memory-Zustand zurück (für deterministische Unit-Tests). */
export function resetLibraryNavigationMemory(): void {
  memoryLastSearch = null;
  memoryScrollBySearch.clear();
}
