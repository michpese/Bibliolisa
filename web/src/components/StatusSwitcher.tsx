import { BookCheck, BookDashed, BookMarked, BookX } from 'lucide-react';
import type { LibraryEntry, ReadingStatus } from '@bibliolisa/shared';
import { useUpdateEntry, statusTransitionPatch } from '@/hooks/useLibrary';
import { STATUS_LABELS, STATUS_ORDER, STATUS_STYLES } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';

const STATUS_ICONS: Record<ReadingStatus, typeof BookCheck> = {
  unread: BookDashed,
  reading: BookMarked,
  read: BookCheck,
  abandoned: BookX,
};

interface StatusSwitcherProps {
  entry: Pick<LibraryEntry, 'id' | 'status' | 'startedAt' | 'finishedAt'>;
  size?: 'sm' | 'md';
  /** Zeigt zusätzlich zum Icon das Label (z. B. auf der Detailseite). */
  showLabels?: boolean;
  className?: string;
}

/** Ein-Klick-Statuswechsel: jeder Status ist direkt erreichbar, Update erfolgt optimistisch. */
export function StatusSwitcher({
  entry,
  size = 'md',
  showLabels = false,
  className,
}: StatusSwitcherProps) {
  const update = useUpdateEntry();

  const change = (status: ReadingStatus) => {
    if (status === entry.status) return;
    update.mutate(
      { id: entry.id, patch: statusTransitionPatch(entry, status) },
      {
        onError: (error) =>
          toast.error(`Status konnte nicht geändert werden: ${errorMessage(error)}`),
      }
    );
  };

  return (
    <div
      role="radiogroup"
      aria-label="Lesestatus"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5',
        showLabels && 'flex w-full flex-wrap sm:w-auto',
        className
      )}
    >
      {STATUS_ORDER.map((status) => {
        const Icon = STATUS_ICONS[status];
        const active = entry.status === status;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={STATUS_LABELS[status]}
            title={STATUS_LABELS[status]}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              change(status);
            }}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
              size === 'sm' ? 'h-7 min-w-7 px-1.5' : 'h-9 min-w-9 px-2.5',
              showLabels && 'flex-1 sm:flex-none',
              active
                ? STATUS_STYLES[status].active
                : 'text-muted-foreground hover:bg-card hover:text-foreground'
            )}
          >
            <Icon className={size === 'sm' ? 'h-4 w-4' : 'h-4 w-4'} aria-hidden />
            {showLabels && <span>{STATUS_LABELS[status]}</span>}
          </button>
        );
      })}
    </div>
  );
}
