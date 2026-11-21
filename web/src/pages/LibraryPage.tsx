import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BookPlus,
  LayoutGrid,
  Layers,
  List,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  LibrarySortFieldSchema,
  ReadingStatusSchema,
  getDefaultSortOrder,
  type LibrarySortField,
  type ReadingStatus,
  type SortOrder,
} from '@bibliolisa/shared';
import type { LibraryFilters } from '@/api/client';
import { BookFormDialog } from '@/components/BookFormDialog';
import { BookCard, BookRow } from '@/components/BookCard';
import { SeriesCard } from '@/components/SeriesCard';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/misc';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFacets, useLibraryAll } from '@/hooks/useLibrary';
import {
  SORT_OPTIONS,
  STATUS_LABELS,
  STATUS_ORDER,
  STATUS_STYLES,
} from '@/lib/format';
import { groupBySeries } from '@/lib/series';
import { cn } from '@/lib/utils';

type ViewMode = 'series' | 'grid' | 'list';
const VIEW_STORAGE_KEY = 'bibliolisa-view';

function readView(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'series' || stored === 'grid' || stored === 'list') return stored;
  } catch {
    // ignorieren
  }
  return 'series';
}

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string; icon: typeof Layers }> = [
  { value: 'series', label: 'Reihen', icon: Layers },
  { value: 'grid', label: 'Raster', icon: LayoutGrid },
  { value: 'list', label: 'Liste', icon: List },
];

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const [view, setViewState] = useState<ViewMode>(readView);
  const [addOpen, setAddOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const setView = (value: ViewMode) => {
    setViewState(value);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, value);
    } catch {
      // ignorieren
    }
  };

  const urlQ = params.get('q') ?? '';
  const [searchText, setSearchText] = useState(urlQ);
  const debouncedQ = useDebouncedValue(searchText, 300);

  const statusParam = ReadingStatusSchema.safeParse(params.get('status'));
  const sortParam = LibrarySortFieldSchema.safeParse(params.get('sort'));
  const orderParam = params.get('order');

  const status: ReadingStatus | undefined = statusParam.success ? statusParam.data : undefined;
  const sort: LibrarySortField = sortParam.success ? sortParam.data : 'series';
  const order: SortOrder | undefined =
    orderParam === 'asc' || orderParam === 'desc' ? orderParam : undefined;
  const genre = params.get('genre') ?? undefined;
  const author = params.get('author') ?? undefined;
  const series = params.get('series') ?? undefined;
  const minRatingRaw = Number(params.get('minRating'));
  const minRating =
    Number.isInteger(minRatingRaw) && minRatingRaw >= 1 && minRatingRaw <= 5
      ? minRatingRaw
      : undefined;

  const updateParam = (key: string, value: string | undefined) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true }
    );
  };

  // Live-Suche: debounced Text -> URL-Parameter
  useEffect(() => {
    const trimmed = debouncedQ.trim();
    if (trimmed !== urlQ) {
      updateParam('q', trimmed || undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  // Browser-Navigation (Zurück/Vorwärts/Reset) -> Suchfeld synchron halten
  useEffect(() => {
    setSearchText((prev) => (prev.trim() === urlQ ? prev : urlQ));
  }, [urlQ]);

  const filters: LibraryFilters = useMemo(
    () => ({
      q: urlQ.trim() || undefined,
      status,
      genre,
      author,
      series,
      minRating,
      sort,
      order,
    }),
    [urlQ, status, genre, author, series, minRating, sort, order]
  );

  const library = useLibraryAll(filters);
  const facets = useFacets();

  const items = library.data?.items ?? [];
  const grouped = useMemo(() => groupBySeries(items), [items]);

  const activeFilterCount = [genre, author, series, minRating, status].filter(
    (value) => value !== undefined
  ).length;
  const hasAnyFilter = activeFilterCount > 0 || urlQ.trim() !== '';
  const effectiveOrder = order ?? getDefaultSortOrder(sort);
  const totalBooks = facets.data?.total ?? 0;

  const resetFilters = () => {
    setSearchText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meine Bibliothek</h1>
          <p className="text-sm text-muted-foreground">
            {library.data
              ? `${library.data.total} ${library.data.total === 1 ? 'Buch' : 'Bücher'}${
                  hasAnyFilter ? ' (gefiltert)' : ''
                }`
              : 'Lade …'}
          </p>
        </div>
        <div
          className="inline-flex rounded-lg bg-muted p-0.5"
          role="radiogroup"
          aria-label="Ansicht"
        >
          {VIEW_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={view === value}
              onClick={() => setView(value)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
                view === value
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Status-Schnellfilter mit Zählern */}
      <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <button
          type="button"
          onClick={() => updateParam('status', undefined)}
          className={cn(
            'inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
            status === undefined
              ? 'border-primary bg-primary text-primary-foreground'
              : 'bg-card hover:bg-accent'
          )}
        >
          Alle <span className="tabular-nums opacity-80">{totalBooks}</span>
        </button>
        {STATUS_ORDER.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => updateParam('status', status === value ? undefined : value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              status === value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card hover:bg-accent'
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', STATUS_STYLES[value].dot)} />
            {STATUS_LABELS[value]}
            <span className="tabular-nums opacity-80">{facets.data?.statusCounts[value] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Suche, Sortierung, Filter */}
      <div className="space-y-3 rounded-xl border bg-card p-3 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Suche nach Titel, Autor, Reihe, ISBN, Notizen …"
              aria-label="Bibliothek durchsuchen"
              className="pl-9 pr-9"
              type="search"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label="Suche leeren"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select
            value={sort}
            onChange={(event) => updateParam('sort', event.target.value)}
            aria-label="Sortierung"
            className="w-auto min-w-[150px]"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Sortiert nach: {option.label}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => updateParam('order', effectiveOrder === 'asc' ? 'desc' : 'asc')}
            title={effectiveOrder === 'asc' ? 'Aufsteigend' : 'Absteigend'}
            aria-label={`Sortierrichtung: ${effectiveOrder === 'asc' ? 'aufsteigend' : 'absteigend'}`}
          >
            {effectiveOrder === 'asc' ? (
              <ArrowDownAZ className="h-4 w-4" />
            ) : (
              <ArrowUpAZ className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant={filtersOpen || activeFilterCount > 0 ? 'secondary' : 'outline'}
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filter
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>

        {(filtersOpen || activeFilterCount > 0) && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              value={genre ?? ''}
              onChange={(event) => updateParam('genre', event.target.value)}
              aria-label="Genre filtern"
            >
              <option value="">Alle Genres</option>
              {facets.data?.genres.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {facet.value} ({facet.count})
                </option>
              ))}
            </Select>
            <Select
              value={author ?? ''}
              onChange={(event) => updateParam('author', event.target.value)}
              aria-label="Autor filtern"
            >
              <option value="">Alle Autoren</option>
              {facets.data?.authors.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {facet.value} ({facet.count})
                </option>
              ))}
            </Select>
            <Select
              value={series ?? ''}
              onChange={(event) => updateParam('series', event.target.value)}
              aria-label="Buchreihe filtern"
            >
              <option value="">Alle Buchreihen</option>
              {facets.data?.series.map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {facet.value} ({facet.count})
                </option>
              ))}
            </Select>
            <Select
              value={minRating ? String(minRating) : ''}
              onChange={(event) => updateParam('minRating', event.target.value)}
              aria-label="Mindestbewertung"
            >
              <option value="">Jede Bewertung</option>
              {[5, 4, 3, 2, 1].map((stars) => (
                <option key={stars} value={stars}>
                  ab {stars} {stars === 1 ? 'Stern' : 'Sternen'}
                </option>
              ))}
            </Select>
          </div>
        )}

        {hasAnyFilter && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              <X className="h-3.5 w-3.5" /> Filter zurücksetzen
            </Button>
          </div>
        )}
      </div>

      {/* Inhalt */}
      {library.isLoading ? (
        <LoadingSkeleton view={view} />
      ) : library.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
          <p className="font-medium text-destructive">Die Bibliothek konnte nicht geladen werden.</p>
          <Button variant="outline" className="mt-3" onClick={() => void library.refetch()}>
            Erneut versuchen
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState filtered={hasAnyFilter} onAdd={() => setAddOpen(true)} onReset={resetFilters} />
      ) : (
        <div className={cn('transition-opacity', library.isFetching && 'opacity-70')}>
          {view === 'series' && (
            <div className="space-y-4">
              {grouped.series.map((group) => (
                <SeriesCard key={group.name.toLowerCase()} group={group} />
              ))}
              {grouped.standalone.length > 0 && (
                <section aria-label="Einzelbände" className="space-y-3">
                  {grouped.series.length > 0 && (
                    <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Einzelbände ({grouped.standalone.length})
                    </h2>
                  )}
                  <BookGrid entries={grouped.standalone} />
                </section>
              )}
            </div>
          )}
          {view === 'grid' && <BookGrid entries={items} />}
          {view === 'list' && (
            <div className="space-y-2">
              {items.map((entry) => (
                <BookRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
          {library.isFetching && (
            <div className="mt-4 flex justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-label="Aktualisiere …" />
            </div>
          )}
        </div>
      )}

      <BookFormDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function BookGrid({ entries }: { entries: ReturnType<typeof groupBySeries>['standalone'] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {entries.map((entry) => (
        <BookCard key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function LoadingSkeleton({ view }: { view: ViewMode }) {
  if (view === 'list') {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (view === 'series') {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-56 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }, (_, i) => (
        <Skeleton key={i} className="aspect-[2/3.6] w-full rounded-xl" />
      ))}
    </div>
  );
}

function EmptyState({
  filtered,
  onAdd,
  onReset,
}: {
  filtered: boolean;
  onAdd: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
        <BookPlus className="h-7 w-7" />
      </span>
      {filtered ? (
        <>
          <h2 className="text-lg font-semibold">Keine passenden Bücher</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Mit den aktuellen Filtern wurde nichts gefunden.
          </p>
          <Button variant="outline" onClick={onReset}>
            Filter zurücksetzen
          </Button>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold">Deine Bibliothek ist noch leer</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Füge dein erstes Buch per ISBN-Suche hinzu oder trage es manuell ein.
          </p>
          <Button onClick={onAdd}>
            <BookPlus className="h-4 w-4" /> Erstes Buch hinzufügen
          </Button>
        </>
      )}
    </div>
  );
}
