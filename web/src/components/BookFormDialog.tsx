import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  normalizeIsbn,
  type LibraryEntry,
  type MetadataCandidate,
  type ReadingStatus,
} from '@bibliolisa/shared';
import { api, errorMessage } from '@/api/client';
import { BookCover } from '@/components/BookCover';
import { MetadataSearchPanel } from '@/components/MetadataSearchPanel';
import { RatingStars } from '@/components/RatingStars';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/field';
import { statusTransitionPatch, useInvalidateLibrary } from '@/hooks/useLibrary';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  formatSeriesNumber,
  parseDecimal,
  parseOptionalInt,
  splitList,
} from '@/lib/format';
import { uuidv4 } from '@/lib/utils';

interface FormState {
  title: string;
  subtitle: string;
  authors: string;
  seriesName: string;
  seriesNumber: string;
  isbn: string;
  pageCount: string;
  publishedYear: string;
  genres: string;
  description: string;
  language: string;
  publisher: string;
  status: ReadingStatus;
  rating: number | null;
  notes: string;
  metadataSource: MetadataCandidate['source'] | 'manual';
  metadataExternalId: string | null;
}

const EMPTY_FORM: FormState = {
  title: '',
  subtitle: '',
  authors: '',
  seriesName: '',
  seriesNumber: '',
  isbn: '',
  pageCount: '',
  publishedYear: '',
  genres: '',
  description: '',
  language: '',
  publisher: '',
  status: 'unread',
  rating: null,
  notes: '',
  metadataSource: 'manual',
  metadataExternalId: null,
};

function formFromEntry(entry: LibraryEntry): FormState {
  const { book } = entry;
  return {
    title: book.title,
    subtitle: book.subtitle ?? '',
    authors: book.authors.join(', '),
    seriesName: book.seriesName ?? '',
    seriesNumber: formatSeriesNumber(book.seriesNumber),
    isbn: book.isbn13 ?? book.isbn10 ?? '',
    pageCount: book.pageCount ? String(book.pageCount) : '',
    publishedYear: book.publishedYear ? String(book.publishedYear) : '',
    genres: book.genres.join(', '),
    description: book.description ?? '',
    language: book.language ?? '',
    publisher: book.publisher ?? '',
    status: entry.status,
    rating: entry.rating,
    notes: entry.notes ?? '',
    metadataSource: book.metadataSource,
    metadataExternalId: book.metadataExternalId,
  };
}

interface BookFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ohne Eintrag: neues Buch anlegen. Mit Eintrag: bearbeiten. */
  entry?: LibraryEntry;
  initialQuery?: string;
  onSaved?: (entry: LibraryEntry) => void;
}

type Errors = Partial<Record<keyof FormState | 'form', string>>;

export function BookFormDialog({
  open,
  onOpenChange,
  entry,
  initialQuery,
  onSaved,
}: BookFormDialogProps) {
  const isEdit = Boolean(entry);
  const invalidate = useInvalidateLibrary();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverFilePreview, setCoverFilePreview] = useState<string | null>(null);
  const [remoteCoverUrl, setRemoteCoverUrl] = useState<string | null>(null);

  // Formular bei jedem Öffnen zurücksetzen
  useEffect(() => {
    if (open) {
      setForm(entry ? formFromEntry(entry) : EMPTY_FORM);
      setErrors({});
      setCoverFile(null);
      setRemoteCoverUrl(null);
    }
  }, [open, entry?.id]);

  useEffect(() => {
    if (!coverFile) {
      setCoverFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const applyCandidate = (candidate: MetadataCandidate) => {
    setForm((prev) => ({
      ...prev,
      title: candidate.title,
      subtitle: candidate.subtitle ?? '',
      authors: candidate.authors.join(', '),
      seriesName: candidate.seriesName ?? '',
      seriesNumber: formatSeriesNumber(candidate.seriesNumber),
      isbn: candidate.isbn13 ?? candidate.isbn10 ?? prev.isbn,
      pageCount: candidate.pageCount ? String(candidate.pageCount) : '',
      publishedYear: candidate.publishedYear ? String(candidate.publishedYear) : '',
      genres: candidate.genres.join(', '),
      description: candidate.description ?? '',
      language: candidate.language ?? '',
      publisher: candidate.publisher ?? '',
      metadataSource: candidate.source,
      metadataExternalId: candidate.externalId,
    }));
    setCoverFile(null);
    setRemoteCoverUrl(candidate.coverUrl);
    setErrors({});
    toast.success('Metadaten übernommen – du kannst sie unten noch korrigieren.');
  };

  const validate = () => {
    const next: Errors = {};
    if (form.title.trim() === '') next.title = 'Titel ist erforderlich.';
    if (parseDecimal(form.seriesNumber) === undefined) {
      next.seriesNumber = 'Bitte eine Zahl angeben (z. B. 1 oder 1,5).';
    }
    const pages = parseOptionalInt(form.pageCount);
    if (pages === undefined || (pages !== null && pages <= 0)) {
      next.pageCount = 'Bitte eine positive ganze Zahl angeben.';
    }
    const year = parseOptionalInt(form.publishedYear);
    if (year === undefined || (year !== null && (year < 1000 || year > 2100))) {
      next.publishedYear = 'Jahr zwischen 1000 und 2100.';
    }
    if (form.isbn.trim() !== '' && !normalizeIsbn(form.isbn).valid) {
      next.isbn = 'Ungültige ISBN (Prüfziffer stimmt nicht).';
    }
    if (form.language.trim() !== '' && form.language.trim().length < 2) {
      next.language = 'Mindestens 2 Zeichen (z. B. de).';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const bookPayload = () => {
    const isbn = form.isbn.trim() === '' ? null : normalizeIsbn(form.isbn);
    return {
      title: form.title.trim(),
      subtitle: form.subtitle.trim() || null,
      authors: splitList(form.authors),
      seriesName: form.seriesName.trim() || null,
      seriesNumber: form.seriesName.trim() ? (parseDecimal(form.seriesNumber) ?? null) : null,
      isbn10: isbn?.isbn10 ?? null,
      isbn13: isbn?.isbn13 ?? null,
      pageCount: parseOptionalInt(form.pageCount) ?? null,
      publishedYear: parseOptionalInt(form.publishedYear) ?? null,
      genres: splitList(form.genres),
      description: form.description.trim() || null,
      language: form.language.trim() || null,
      publisher: form.publisher.trim() || null,
      metadataSource: form.metadataSource,
      metadataExternalId: form.metadataExternalId,
    };
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      let saved: LibraryEntry;

      if (entry) {
        const statusPatch =
          form.status !== entry.status
            ? statusTransitionPatch(entry, form.status)
            : {};
        saved = await api.updateEntry(entry.id, {
          ...statusPatch,
          rating: form.rating,
          notes: form.notes.trim() || null,
          book: {
            ...bookPayload(),
            ...(remoteCoverUrl ? { coverSourceUrl: remoteCoverUrl } : {}),
          },
        });
      } else {
        const now = new Date().toISOString();
        const transition = statusTransitionPatch(
          { startedAt: null, finishedAt: null },
          form.status
        );
        saved = await api.createEntry({
          id: uuidv4(),
          book: {
            id: uuidv4(),
            ...bookPayload(),
            coverSourceUrl: remoteCoverUrl,
          },
          status: form.status,
          rating: form.rating,
          notes: form.notes.trim() || null,
          addedAt: now,
          startedAt: transition.startedAt ?? null,
          finishedAt: transition.finishedAt ?? null,
        });
      }

      // Cover: eigener Upload hat Vorrang; bei Bearbeitung zusätzlich externes Cover nachladen
      try {
        if (coverFile) {
          await api.uploadCover(saved.bookId, coverFile);
        } else if (entry && remoteCoverUrl) {
          await api.fetchCover(saved.bookId, remoteCoverUrl);
        }
      } catch (coverError) {
        toast.warning(`Buch gespeichert, aber das Cover konnte nicht übernommen werden: ${errorMessage(coverError)}`);
      }

      invalidate();
      toast.success(isEdit ? 'Änderungen gespeichert.' : `„${saved.book.title}“ wurde hinzugefügt.`);
      onOpenChange(false);
      onSaved?.(saved);
    } catch (error) {
      setErrors({ form: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const previewCoverKey = useMemo(() => entry?.book.coverKey ?? null, [entry]);
  const previewUrl = coverFilePreview ?? remoteCoverUrl;

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent wide aria-describedby="book-form-description">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Buch bearbeiten' : 'Buch hinzufügen'}</DialogTitle>
          <DialogDescription id="book-form-description">
            {isEdit
              ? 'Metadaten, Reihe, Bewertung und Notizen anpassen.'
              : 'Per ISBN oder Titel suchen und Treffer übernehmen – oder alles manuell eintragen.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              {isEdit ? 'Metadaten neu laden (optional)' : '1. Metadaten suchen'}
            </h3>
            <MetadataSearchPanel
              initialQuery={initialQuery ?? (entry ? (entry.book.isbn13 ?? entry.book.title) : '')}
              onPick={applyCandidate}
            />
          </section>

          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">
                {isEdit ? 'Buchdaten' : '2. Buchdaten prüfen & ergänzen'}
              </h3>
              <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
                <div className="space-y-2">
                  <BookCover
                    coverKey={previewCoverKey}
                    previewUrl={previewUrl}
                    title={form.title || 'Neues Buch'}
                  />
                  <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
                    <ImagePlus className="h-3.5 w-3.5" />
                    Cover hochladen
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        if (file && file.size > 5 * 1024 * 1024) {
                          toast.error('Das Cover darf höchstens 5 MB groß sein.');
                          return;
                        }
                        setCoverFile(file);
                        if (file) setRemoteCoverUrl(null);
                      }}
                    />
                  </label>
                  {(coverFile || remoteCoverUrl) && (
                    <button
                      type="button"
                      onClick={() => {
                        setCoverFile(null);
                        setRemoteCoverUrl(null);
                      }}
                      className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" /> Auswahl verwerfen
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Titel *"
                    htmlFor="book-form-title"
                    error={errors.title}
                    className="sm:col-span-2"
                  >
                    <Input
                      id="book-form-title"
                      value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      required
                      maxLength={500}
                      aria-invalid={Boolean(errors.title)}
                    />
                  </Field>
                  <Field
                    label="Untertitel"
                    htmlFor="book-form-subtitle"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="book-form-subtitle"
                      value={form.subtitle}
                      onChange={(e) => set('subtitle', e.target.value)}
                      maxLength={500}
                    />
                  </Field>
                  <Field
                    label="Autor(en)"
                    htmlFor="book-form-authors"
                    hint="Mehrere durch Komma trennen"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="book-form-authors"
                      value={form.authors}
                      onChange={(e) => set('authors', e.target.value)}
                    />
                  </Field>
                  <Field label="Buchreihe" htmlFor="book-form-series">
                    <Input
                      id="book-form-series"
                      value={form.seriesName}
                      onChange={(e) => set('seriesName', e.target.value)}
                      maxLength={300}
                    />
                  </Field>
                  <Field
                    label="Band"
                    htmlFor="book-form-series-number"
                    hint="Dezimal möglich, z. B. 1,5"
                    error={errors.seriesNumber}
                  >
                    <Input
                      id="book-form-series-number"
                      value={form.seriesNumber}
                      onChange={(e) => set('seriesNumber', e.target.value)}
                      inputMode="decimal"
                      placeholder="1"
                      disabled={form.seriesName.trim() === ''}
                    />
                  </Field>
                  <Field
                    label="ISBN (10 oder 13)"
                    htmlFor="book-form-isbn"
                    error={errors.isbn}
                  >
                    <Input
                      id="book-form-isbn"
                      value={form.isbn}
                      onChange={(e) => set('isbn', e.target.value)}
                      inputMode="numeric"
                    />
                  </Field>
                  <Field label="Verlag" htmlFor="book-form-publisher">
                    <Input
                      id="book-form-publisher"
                      value={form.publisher}
                      onChange={(e) => set('publisher', e.target.value)}
                      maxLength={300}
                    />
                  </Field>
                  <Field
                    label="Seiten"
                    htmlFor="book-form-pages"
                    error={errors.pageCount}
                  >
                    <Input
                      id="book-form-pages"
                      value={form.pageCount}
                      onChange={(e) => set('pageCount', e.target.value)}
                      inputMode="numeric"
                    />
                  </Field>
                  <Field
                    label="Erscheinungsjahr"
                    htmlFor="book-form-year"
                    error={errors.publishedYear}
                  >
                    <Input
                      id="book-form-year"
                      value={form.publishedYear}
                      onChange={(e) => set('publishedYear', e.target.value)}
                      inputMode="numeric"
                    />
                  </Field>
                  <Field
                    label="Sprache"
                    htmlFor="book-form-language"
                    hint="z. B. de, en"
                    error={errors.language}
                  >
                    <Input
                      id="book-form-language"
                      value={form.language}
                      onChange={(e) => set('language', e.target.value)}
                      maxLength={16}
                    />
                  </Field>
                  <Field
                    label="Genres / Tags"
                    htmlFor="book-form-genres"
                    hint="Durch Komma trennen"
                  >
                    <Input
                      id="book-form-genres"
                      value={form.genres}
                      onChange={(e) => set('genres', e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Beschreibung"
                    htmlFor="book-form-description"
                    className="sm:col-span-2"
                  >
                    <Textarea
                      id="book-form-description"
                      value={form.description}
                      onChange={(e) => set('description', e.target.value)}
                      rows={4}
                      maxLength={20000}
                    />
                  </Field>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">{isEdit ? 'Mein Lesestand' : '3. Mein Lesestand'}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status" htmlFor="book-form-status">
                  <Select
                    id="book-form-status"
                    value={form.status}
                    onChange={(e) => set('status', e.target.value as ReadingStatus)}
                  >
                    {STATUS_ORDER.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Bewertung">
                  <div className="flex h-10 items-center">
                    <RatingStars value={form.rating} onChange={(value) => set('rating', value)} />
                  </div>
                </Field>
                <Field
                  label="Notizen"
                  htmlFor="book-form-notes"
                  className="sm:col-span-2"
                >
                  <Textarea
                    id="book-form-notes"
                    value={form.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    rows={3}
                    maxLength={50000}
                  />
                </Field>
              </div>
            </section>

            {errors.form && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errors.form}
              </p>
            )}
            <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
              Speichern
            </button>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Speichern' : 'Buch hinzufügen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && !error && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
