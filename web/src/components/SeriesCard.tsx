import { Link } from 'react-router-dom';
import { BookCheck, BookDashed, BookMarked, BookX, Play } from 'lucide-react';
import { toast } from 'sonner';
import type { LibraryEntry, ReadingStatus } from '@bibliolisa/shared';
import { errorMessage } from '@/api/client';
import { BookCover } from '@/components/BookCover';
import { SeriesProgressBar } from '@/components/SeriesProgressBar';
import { Button } from '@/components/ui/button';
import { statusTransitionPatch, useUpdateEntry } from '@/hooks/useLibrary';
import {
  STATUS_LABELS,
  STATUS_SHORT_LABELS,
  STATUS_STYLES,
  formatSeriesNumber,
} from '@/lib/format';
import type { SeriesGroup } from '@/lib/series';
import { cn } from '@/lib/utils';

const STATUS_ICONS: Record<ReadingStatus, typeof BookCheck> = {
  unread: BookDashed,
  reading: BookMarked,
  read: BookCheck,
  abandoned: BookX,
};

/** Ein Klick = nächster Status im Lesezyklus. */
const NEXT_STATUS: Record<ReadingStatus, ReadingStatus> = {
  unread: 'reading',
  reading: 'read',
  read: 'unread',
  abandoned: 'unread',
};

function VolumeTile({ entry }: { entry: LibraryEntry }) {
  const update = useUpdateEntry();
  const Icon = STATUS_ICONS[entry.status];
  const next = NEXT_STATUS[entry.status];
  const number = formatSeriesNumber(entry.book.seriesNumber);

  return (
    <div className="flex w-[84px] shrink-0 flex-col gap-1.5">
      <Link
        to={`/books/${entry.id}`}
        title={entry.book.title}
        className={cn(
          'relative block rounded-md ring-2 ring-offset-2 ring-offset-card transition-shadow hover:shadow-md',
          entry.status === 'read' && 'ring-success/70',
          entry.status === 'reading' && 'ring-primary',
          entry.status === 'abandoned' && 'ring-destructive/60',
          entry.status === 'unread' && 'ring-transparent'
        )}
      >
        <BookCover coverKey={entry.book.coverKey} title={entry.book.title} />
        <span className="absolute left-1 top-1 rounded bg-card/90 px-1.5 py-0.5 text-[10px] font-bold leading-none shadow-sm">
          {number ? `#${number}` : '–'}
        </span>
      </Link>
      <button
        type="button"
        onClick={() =>
          update.mutate(
            { id: entry.id, patch: statusTransitionPatch(entry, next) },
            {
              onError: (error) =>
                toast.error(`Status konnte nicht geändert werden: ${errorMessage(error)}`),
            }
          )
        }
        title={`${STATUS_LABELS[entry.status]} – Klick: ${STATUS_LABELS[next]}`}
        aria-label={`Band ${number || entry.book.title}: ${STATUS_LABELS[entry.status]}. Klicken für ${STATUS_LABELS[next]}`}
        className={cn(
          'inline-flex h-7 items-center justify-center gap-1 rounded-md text-[11px] font-medium transition-colors hover:brightness-95',
          STATUS_STYLES[entry.status].badge
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {STATUS_SHORT_LABELS[entry.status]}
      </button>
    </div>
  );
}

export function SeriesCard({ group }: { group: SeriesGroup }) {
  const update = useUpdateEntry();
  const { counts, total, next } = group;
  const inProgress = counts.reading;

  return (
    <section
      className="rounded-xl border bg-card p-4 shadow-sm"
      aria-label={`Buchreihe ${group.name}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{group.name}</h3>
          <p className="text-sm text-muted-foreground">
            {counts.read} von {total} {total === 1 ? 'Band' : 'Bänden'} gelesen
            {inProgress > 0 && ` · ${inProgress} in Arbeit`}
            {counts.abandoned > 0 && ` · ${counts.abandoned} abgebrochen`}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
            group.percentRead === 100
              ? 'bg-success/15 text-success'
              : 'bg-accent text-accent-foreground'
          )}
        >
          {group.percentRead}%
        </span>
      </header>

      <SeriesProgressBar
        statuses={group.entries.map((entry) => entry.status)}
        className="mt-3"
      />

      {next && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Als Nächstes:</span>
          <Link to={`/books/${next.id}`} className="min-w-0 truncate font-medium hover:text-primary">
            {next.book.seriesNumber !== null
              ? `Band ${formatSeriesNumber(next.book.seriesNumber)} – `
              : ''}
            {next.book.title}
          </Link>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() =>
              update.mutate(
                { id: next.id, patch: statusTransitionPatch(next, 'reading') },
                {
                  onSuccess: () => toast.success(`„${next.book.title}“ wird jetzt gelesen.`),
                  onError: (error) => toast.error(errorMessage(error)),
                }
              )
            }
          >
            <Play className="h-3.5 w-3.5" /> Jetzt lesen
          </Button>
        </div>
      )}

      <div className="scrollbar-none -mx-1 mt-4 flex gap-3 overflow-x-auto px-2 pb-2 pt-2">
        {group.entries.map((entry) => (
          <VolumeTile key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
