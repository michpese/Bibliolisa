import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Clock,
  Dices,
  Flame,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ThumbsUp,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { RecommendationCategory, RecommendationItem } from '@bibliolisa/shared';
import { api, errorMessage } from '@/api/client';
import { BookCover } from '@/components/BookCover';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { libraryKeys, statusTransitionPatch, useUpdateEntry } from '@/hooks/useLibrary';
import { formatAuthors, formatSeriesLabel } from '@/lib/format';

const CATEGORIES: Array<{
  key: RecommendationCategory;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: 'continue_series',
    title: 'Begonnene Reihen',
    description: 'Der nächste Band, wo du aufgehört hast.',
    icon: Layers,
  },
  {
    key: 'affinity',
    title: 'Empfohlen für dich',
    description: 'Passend zu deinen Lieblingsautoren und -genres.',
    icon: ThumbsUp,
  },
  {
    key: 'quick_read',
    title: 'Schneller Read',
    description: 'Kompakte Bücher unter 300 Seiten.',
    icon: Clock,
  },
  {
    key: 'dust_collector',
    title: 'Staubfänger',
    description: 'Schon lange auf deinem Lesestapel.',
    icon: Flame,
  },
  {
    key: 'surprise_me',
    title: 'Überrasch mich',
    description: 'Eine zufällige Auswahl aus deinem Stapel.',
    icon: Dices,
  },
];

function randomSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] ?? 0) % 2_000_000_000;
}

export function RecommendationsPage() {
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const query = useQuery({
    queryKey: [...libraryKeys.recommendations, seed ?? 'auto'],
    queryFn: () => api.recommendations(seed, 5),
  });

  const result = query.data;
  const isEmpty =
    result !== undefined &&
    CATEGORIES.every((category) => result.categories[category.key].length === 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Was lese ich als Nächstes?</h1>
          <p className="text-sm text-muted-foreground">
            Vorschläge aus deinem ungelesenen Stapel – jeweils mit Begründung.
          </p>
        </div>
        <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          Neu berechnen
        </Button>
      </div>

      {query.isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      )}

      {query.isError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center text-destructive">
          {errorMessage(query.error)}
        </div>
      )}

      {isEmpty && (
        <div className="rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
          <p className="font-medium">Noch keine Empfehlungen verfügbar.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Füge ungelesene Bücher hinzu – dann erscheinen hier passende Vorschläge.
          </p>
        </div>
      )}

      {result &&
        !isEmpty &&
        CATEGORIES.map(({ key, title, description, icon: Icon }) => {
          const items = result.categories[key];
          if (items.length === 0 && key !== 'surprise_me') return null;
          return (
            <section key={key} className="space-y-3" aria-labelledby={`rec-${key}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h2 id={`rec-${key}`} className="text-base font-semibold leading-tight">
                      {title}
                    </h2>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </div>
                {key === 'surprise_me' && (
                  <Button variant="secondary" size="sm" onClick={() => setSeed(randomSeed())}>
                    <Dices className="h-4 w-4" /> Neu würfeln
                  </Button>
                )}
              </div>
              {items.length === 0 ? (
                <p className="rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
                  Keine passenden Bücher gefunden.
                </p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((item) => (
                    <RecommendationCard key={`${key}-${item.userBookId}`} item={item} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}

function RecommendationCard({ item }: { item: RecommendationItem }) {
  const update = useUpdateEntry();
  const entry = item.entry;
  if (!entry) return null;
  const { book } = entry;
  const series = formatSeriesLabel(book);

  return (
    <li className="flex gap-3 rounded-xl border bg-card p-3 shadow-sm transition-shadow hover:shadow-md">
      <Link to={`/books/${entry.id}`} className="w-20 shrink-0">
        <BookCover coverKey={book.coverKey} title={book.title} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="min-w-0">
          <Link to={`/books/${entry.id}`} className="hover:text-primary">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{book.title}</h3>
          </Link>
          <p className="line-clamp-1 text-xs text-muted-foreground">{formatAuthors(book)}</p>
          {series && (
            <p className="line-clamp-1 text-xs font-medium text-accent-foreground/80">{series}</p>
          )}
        </div>
        <p className="rounded-md bg-accent/60 px-2 py-1.5 text-xs leading-snug text-accent-foreground">
          {item.reasonText}
        </p>
        <div className="mt-auto pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: entry.id, patch: statusTransitionPatch(entry, 'reading') },
                {
                  onSuccess: () => toast.success(`„${book.title}“ wird jetzt gelesen.`),
                  onError: (error) => toast.error(errorMessage(error)),
                }
              )
            }
          >
            {update.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Jetzt lesen
          </Button>
        </div>
      </div>
    </li>
  );
}
