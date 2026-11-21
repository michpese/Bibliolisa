import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Pencil, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/api/client';
import { BookCover } from '@/components/BookCover';
import { BookFormDialog } from '@/components/BookFormDialog';
import { RatingStars } from '@/components/RatingStars';
import { SeriesCard } from '@/components/SeriesCard';
import { StatusSwitcher } from '@/components/StatusSwitcher';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
import {
  useDeleteEntry,
  useEntry,
  useLibraryAll,
  useRestoreEntry,
  useUpdateEntry,
} from '@/hooks/useLibrary';
import {
  formatAuthors,
  formatDate,
  formatSeriesNumber,
} from '@/lib/format';
import { buildSeriesGroup } from '@/lib/series';

export function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const entryQuery = useEntry(id);
  const entry = entryQuery.data;
  const update = useUpdateEntry();
  const remove = useDeleteEntry();
  const restore = useRestoreEntry();

  const [editOpen, setEditOpen] = useState(false);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (entry) setNotes(entry.notes ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, entry?.notes]);

  const seriesName = entry?.book.seriesName ?? undefined;
  const seriesQuery = useLibraryAll(
    { series: seriesName, sort: 'series' },
    { enabled: Boolean(seriesName) }
  );
  const seriesEntries =
    seriesName && seriesQuery.data
      ? seriesQuery.data.items.filter(
          (item) => item.book.seriesName?.toLowerCase() === seriesName.toLowerCase()
        )
      : [];

  if (entryQuery.isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <Skeleton className="aspect-[2/3] w-full max-w-[220px]" />
        <div className="space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (entryQuery.isError || !entry) {
    const notFound =
      entryQuery.error instanceof ApiError && entryQuery.error.status === 404;
    return (
      <div className="mx-auto max-w-md space-y-3 py-16 text-center">
        <h1 className="text-xl font-semibold">
          {notFound ? 'Buch nicht gefunden' : 'Fehler beim Laden'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {notFound
            ? 'Dieser Eintrag existiert nicht (mehr) in deiner Bibliothek.'
            : errorMessage(entryQuery.error)}
        </p>
        <Button asChild variant="outline">
          <Link to="/">Zur Bibliothek</Link>
        </Button>
      </div>
    );
  }

  const { book } = entry;
  const notesDirty = notes.trim() !== (entry.notes ?? '').trim();

  const handleDelete = () => {
    remove.mutate(entry.id, {
      onSuccess: () => {
        toast(`„${book.title}“ wurde entfernt.`, {
          duration: 10_000,
          action: {
            label: 'Wiederherstellen',
            onClick: () =>
              restore.mutate(entry.id, {
                onSuccess: () => toast.success('Eintrag wiederhergestellt.'),
                onError: (error) => toast.error(errorMessage(error)),
              }),
          },
        });
        navigate('/', { replace: true });
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  const facts: Array<[string, string | null]> = [
    ['Verlag', book.publisher],
    ['Erschienen', book.publishedYear ? String(book.publishedYear) : null],
    ['Seiten', book.pageCount ? String(book.pageCount) : null],
    ['Sprache', book.language],
    ['ISBN-13', book.isbn13],
    ['ISBN-10', book.isbn10],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft className="h-4 w-4" /> Bibliothek
          </Link>
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4" /> Bearbeiten
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDelete}
            disabled={remove.isPending}
          >
            {remove.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Entfernen
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="mx-auto w-full max-w-[220px] md:mx-0">
          <BookCover
            coverKey={book.coverKey}
            title={book.title}
            className="shadow-lg"
          />
        </div>

        <div className="min-w-0 space-y-5">
          <header className="space-y-1">
            {book.seriesName && (
              <Link
                to={`/?series=${encodeURIComponent(book.seriesName)}`}
                className="text-sm font-medium text-accent-foreground/80 hover:text-primary"
              >
                {book.seriesName}
                {book.seriesNumber !== null && ` · Band ${formatSeriesNumber(book.seriesNumber)}`}
              </Link>
            )}
            <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
              {book.title}
            </h1>
            {book.subtitle && <p className="text-lg text-muted-foreground">{book.subtitle}</p>}
            <p className="text-muted-foreground">{formatAuthors(book)}</p>
          </header>

          <Card className="space-y-4 p-4">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Lesestatus
              </p>
              <StatusSwitcher entry={entry} showLabels />
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Bewertung
                </p>
                <RatingStars
                  value={entry.rating}
                  onChange={(rating) =>
                    update.mutate(
                      { id: entry.id, patch: { rating } },
                      { onError: (error) => toast.error(errorMessage(error)) }
                    )
                  }
                />
              </div>
              <dl className="grid grid-cols-3 gap-x-6 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Hinzugefügt</dt>
                  <dd className="font-medium">{formatDate(entry.addedAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Begonnen</dt>
                  <dd className="font-medium">{formatDate(entry.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Beendet</dt>
                  <dd className="font-medium">{formatDate(entry.finishedAt)}</dd>
                </div>
              </dl>
            </div>
          </Card>

          {book.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {book.genres.map((genre) => (
                <Link key={genre} to={`/?genre=${encodeURIComponent(genre)}`}>
                  <Badge className="bg-accent text-accent-foreground transition-colors hover:bg-accent/70">
                    {genre}
                  </Badge>
                </Link>
              ))}
            </div>
          )}

          {book.description && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-semibold">Beschreibung</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                {book.description}
              </p>
            </section>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            {facts
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
          </dl>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Meine Notizen</h2>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Gedanken, Zitate, Leseeindrücke …"
              rows={4}
              maxLength={50000}
            />
            {notesDirty && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      { id: entry.id, patch: { notes: notes.trim() || null } },
                      {
                        onSuccess: () => toast.success('Notizen gespeichert.'),
                        onError: (error) => toast.error(errorMessage(error)),
                      }
                    )
                  }
                >
                  <Save className="h-4 w-4" /> Notizen speichern
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNotes(entry.notes ?? '')}
                >
                  Verwerfen
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>

      {seriesEntries.length > 1 && book.seriesName && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Weitere Bände der Reihe</h2>
          <SeriesCard group={buildSeriesGroup(book.seriesName, seriesEntries)} />
        </section>
      )}

      <BookFormDialog open={editOpen} onOpenChange={setEditOpen} entry={entry} />
    </div>
  );
}
