import type { ReadingStatus } from '@bibliolisa/shared';
import { STATUS_STYLES } from '@/lib/format';
import { cn } from '@/lib/utils';

interface SeriesProgressBarProps {
  /** Status je Band in Reihenfolge der Bände. */
  statuses: ReadingStatus[];
  className?: string;
}

/**
 * Fortschrittsbalken einer Buchreihe: ein Segment pro Band, gefärbt nach Lesestatus.
 */
export function SeriesProgressBar({ statuses, className }: SeriesProgressBarProps) {
  const total = statuses.length;
  const read = statuses.filter((s) => s === 'read').length;
  const percent = total === 0 ? 0 : Math.round((read / total) * 100);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={`${read} von ${total} Bänden gelesen`}
      className={cn('flex h-2 w-full gap-0.5 overflow-hidden rounded-full', className)}
    >
      {statuses.map((status, index) => (
        <div
          key={index}
          className={cn(
            'h-full flex-1 transition-colors first:rounded-l-full last:rounded-r-full',
            STATUS_STYLES[status].bar
          )}
        />
      ))}
    </div>
  );
}
