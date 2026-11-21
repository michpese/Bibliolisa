import { useRef, useState } from 'react';
import { Loader2, Search, Sparkles } from 'lucide-react';
import {
  normalizeIsbn,
  type MetadataCandidate,
  type MetadataProviderId,
  type ProviderStatus,
} from '@bibliolisa/shared';
import { api, errorMessage } from '@/api/client';
import { BookCover } from '@/components/BookCover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/misc';
import { formatSeriesNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export const PROVIDER_LABELS: Record<MetadataProviderId, string> = {
  hardcover: 'Hardcover',
  google_books: 'Google Books',
  openlibrary: 'Open Library',
};

const STATUS_HINTS: Record<ProviderStatus['status'], string> = {
  ok: 'Treffer',
  empty: 'Keine Treffer',
  error: 'Fehler',
  timeout: 'Timeout',
  disabled: 'Deaktiviert',
};

interface ResultItem {
  candidate: MetadataCandidate;
  merged: boolean;
}

interface MetadataSearchPanelProps {
  initialQuery?: string;
  onPick: (candidate: MetadataCandidate) => void;
}

export function MetadataSearchPanel({ initialQuery = '', onPick }: MetadataSearchPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultItem[] | null>(null);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [providerFilter, setProviderFilter] = useState<MetadataProviderId | 'all'>('all');
  const abortRef = useRef<AbortController | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setProviderFilter('all');

    try {
      const isbn = normalizeIsbn(q);
      if (isbn.valid) {
        const response = await api.metadataByIsbn(isbn.isbn13 ?? isbn.isbn10 ?? q, controller.signal);
        const items: ResultItem[] = [];
        if (response.merged) {
          items.push({ candidate: response.merged, merged: true });
        }
        for (const candidate of response.candidates) {
          items.push({ candidate, merged: false });
        }
        setResults(items);
        setStatuses(response.providerStatuses);
      } else {
        const response = await api.metadataSearch(q, 12, controller.signal);
        setResults(response.candidates.map((candidate) => ({ candidate, merged: false })));
        setStatuses(response.providerStatuses);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setResults(null);
      setError(errorMessage(err));
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  };

  const visible = (results ?? []).filter(
    (item) =>
      providerFilter === 'all' || item.merged || item.candidate.source === providerFilter
  );

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ISBN, Titel oder Autor …"
          aria-label="Metadaten suchen"
          inputMode="search"
          autoComplete="off"
        />
        <Button type="submit" disabled={loading || query.trim() === ''}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Suchen
        </Button>
      </form>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {statuses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Provider-Auswahl">
          <button
            type="button"
            onClick={() => setProviderFilter('all')}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              providerFilter === 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
          >
            Alle
          </button>
          {statuses.map((status) => (
            <button
              key={status.provider}
              type="button"
              disabled={!status.enabled}
              onClick={() => setProviderFilter(status.provider)}
              title={status.errorMessage ?? STATUS_HINTS[status.status]}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                providerFilter === status.provider
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent'
              )}
            >
              {PROVIDER_LABELS[status.provider]}
              <span className="ml-1 opacity-70">· {STATUS_HINTS[status.status]}</span>
            </button>
          ))}
        </div>
      )}

      {results !== null && visible.length === 0 && !loading && (
        <p className="rounded-md bg-muted px-3 py-3 text-center text-sm text-muted-foreground">
          Keine Treffer – du kannst das Buch unten manuell eintragen.
        </p>
      )}

      <ul className="space-y-2">
        {visible.map((item, index) => {
          const { candidate } = item;
          const series = candidate.seriesName
            ? `${candidate.seriesName}${
                candidate.seriesNumber !== null
                  ? ` · Band ${formatSeriesNumber(candidate.seriesNumber)}`
                  : ''
              }`
            : null;
          return (
            <li
              key={`${candidate.source}-${candidate.externalId}-${index}`}
              className="flex gap-3 rounded-lg border bg-background p-2.5"
            >
              <BookCover
                title={candidate.title}
                previewUrl={candidate.coverUrl}
                className="w-14 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h4 className="line-clamp-2 text-sm font-semibold">{candidate.title}</h4>
                  {item.merged ? (
                    <Badge className="bg-primary/15 text-primary">
                      <Sparkles className="h-3 w-3" /> Beste Kombination
                    </Badge>
                  ) : (
                    <Badge className="bg-secondary text-secondary-foreground">
                      {PROVIDER_LABELS[candidate.source]}
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {candidate.authors.join(', ') || 'Unbekannter Autor'}
                  {candidate.publishedYear ? ` · ${candidate.publishedYear}` : ''}
                  {candidate.pageCount ? ` · ${candidate.pageCount} S.` : ''}
                </p>
                {series && (
                  <p className="line-clamp-1 text-xs font-medium text-accent-foreground/80">
                    {series}
                  </p>
                )}
                {candidate.isbn13 && (
                  <p className="text-[11px] text-muted-foreground">ISBN {candidate.isbn13}</p>
                )}
              </div>
              <Button size="sm" variant="outline" className="self-center" onClick={() => onPick(candidate)}>
                Übernehmen
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
