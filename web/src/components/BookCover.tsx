import { BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { coverUrl } from '@/api/client';
import { cn } from '@/lib/utils';

interface BookCoverProps {
  coverKey?: string | null;
  /** Externe Vorschau-URL (z. B. Metadaten-Treffer), hat Vorrang vor coverKey. */
  previewUrl?: string | null;
  title: string;
  className?: string;
}

/** Cover im 2:3-Format mit Platzhalter. Interne Cover laden per Media-Cookie (kein Token in der URL). */
export function BookCover({ coverKey, previewUrl, title, className }: BookCoverProps) {
  const src = previewUrl ?? coverUrl(coverKey);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div
      className={cn(
        'relative aspect-[2/3] w-full overflow-hidden rounded-md bg-gradient-to-br from-accent to-secondary shadow-sm ring-1 ring-border',
        className
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={`Cover von ${title}`}
          loading="lazy"
          decoding="async"
          referrerPolicy={previewUrl ? 'no-referrer' : undefined}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2 text-center text-accent-foreground/70">
          <BookOpen className="h-6 w-6" aria-hidden />
          <span className="line-clamp-3 text-[10px] font-medium leading-tight">{title}</span>
        </div>
      )}
    </div>
  );
}
