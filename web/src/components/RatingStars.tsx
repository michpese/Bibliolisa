import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RatingStarsProps {
  value: number | null;
  /** Wenn gesetzt, ist die Bewertung per Klick änderbar (erneuter Klick auf aktuellen Wert löscht sie). */
  onChange?: (value: number | null) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function RatingStars({ value, onChange, size = 'md', className }: RatingStarsProps) {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';

  return (
    <div
      className={cn('inline-flex items-center gap-0.5', className)}
      role={onChange ? 'radiogroup' : 'img'}
      aria-label={value ? `Bewertung: ${value} von 5 Sternen` : 'Nicht bewertet'}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = value !== null && star <= value;
        const icon = (
          <Star
            className={cn(
              iconSize,
              filled ? 'fill-warning text-warning' : 'text-muted-foreground/40'
            )}
          />
        );
        if (!onChange) {
          return <span key={star}>{icon}</span>;
        }
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? 'Stern' : 'Sterne'}`}
            title={value === star ? 'Bewertung entfernen' : `${star} von 5`}
            onClick={() => onChange(value === star ? null : star)}
            className="rounded p-0.5 transition-transform hover:scale-110"
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
