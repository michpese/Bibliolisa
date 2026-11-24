import { Link, useLocation } from 'react-router-dom';
import type { LibraryEntry } from '@bibliolisa/shared';
import { Badge } from '@/components/ui/misc';
import { BookCover } from '@/components/BookCover';
import { RatingStars } from '@/components/RatingStars';
import { StatusSwitcher } from '@/components/StatusSwitcher';
import {
  STATUS_SHORT_LABELS,
  STATUS_STYLES,
  formatAuthors,
  formatSeriesLabel,
} from '@/lib/format';
import type { LibraryNavigationState } from '@/lib/libraryNavigation';
import { cn } from '@/lib/utils';

interface BookItemProps {
  entry: LibraryEntry;
}

/** Karte für die Grid-Ansicht. */
export function BookCard({ entry }: BookItemProps) {
  const location = useLocation();
  const linkState: LibraryNavigationState | undefined =
    location.pathname === '/'
      ? { fromLibrary: `${location.pathname}${location.search}` }
      : undefined;
  const { book } = entry;
  const series = formatSeriesLabel(book);

  return (
    <article className="group flex flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md">
      <Link
        to={`/books/${entry.id}`}
        state={linkState}
        className="flex flex-col gap-2 rounded-md"
      >
        <div className="relative">
          <BookCover coverKey={book.coverKey} title={book.title} />
          <Badge
            className={cn(
              'absolute left-1.5 top-1.5 shadow-sm backdrop-blur',
              STATUS_STYLES[entry.status].badge,
              'bg-card/90'
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLES[entry.status].dot)} />
            {STATUS_SHORT_LABELS[entry.status]}
          </Badge>
        </div>
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug group-hover:text-primary">
            {book.title}
          </h3>
          <p className="line-clamp-1 text-xs text-muted-foreground">{formatAuthors(book)}</p>
          {series && (
            <p className="mt-0.5 line-clamp-1 text-xs font-medium text-accent-foreground/80">
              {series}
            </p>
          )}
        </div>
      </Link>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <RatingStars value={entry.rating} size="sm" />
        <StatusSwitcher entry={entry} size="sm" />
      </div>
    </article>
  );
}

/** Kompakte Zeile für die Listenansicht. */
export function BookRow({ entry }: BookItemProps) {
  const location = useLocation();
  const linkState: LibraryNavigationState | undefined =
    location.pathname === '/'
      ? { fromLibrary: `${location.pathname}${location.search}` }
      : undefined;
  const { book } = entry;
  const series = formatSeriesLabel(book);

  return (
    <article className="flex items-center gap-3 rounded-xl border bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md">
      <Link
        to={`/books/${entry.id}`}
        state={linkState}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md"
      >
        <BookCover coverKey={book.coverKey} title={book.title} className="w-12 shrink-0" />
        <div className="min-w-0">
          <h3 className="line-clamp-1 text-sm font-semibold">{book.title}</h3>
          <p className="line-clamp-1 text-xs text-muted-foreground">{formatAuthors(book)}</p>
          {series && (
            <p className="line-clamp-1 text-xs font-medium text-accent-foreground/80">{series}</p>
          )}
          <div className="mt-1 sm:hidden">
            <RatingStars value={entry.rating} size="sm" />
          </div>
        </div>
      </Link>
      <div className="hidden shrink-0 sm:block">
        <RatingStars value={entry.rating} size="sm" />
      </div>
      <StatusSwitcher entry={entry} size="sm" className="shrink-0" />
    </article>
  );
}
