import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  FileSpreadsheet,
  Loader2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { ExportImportEnvelopeSchema, type ImportResult } from '@bibliolisa/shared';
import { api, errorMessage } from '@/api/client';
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
import { Card } from '@/components/ui/misc';
import { useInvalidateLibrary } from '@/hooks/useLibrary';

export function BackupPage() {
  const [downloading, setDownloading] = useState<'json' | 'csv' | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ name: string; payload: unknown; count: number } | null>(
    null
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidateLibrary();

  const download = async (kind: 'json' | 'csv') => {
    setDownloading(kind);
    try {
      const filename = await api.downloadExport(kind);
      toast.success(`Export „${filename}“ heruntergeladen.`);
    } catch (error) {
      toast.error(`Export fehlgeschlagen: ${errorMessage(error)}`);
    } finally {
      setDownloading(null);
    }
  };

  const onFileSelected = async (file: File | undefined) => {
    setResult(null);
    setImportError(null);
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setImportError('Die Datei ist größer als 10 MB.');
      return;
    }

    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const envelope = ExportImportEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        setImportError(
          'Das ist kein gültiges Bibliolisa-JSON-Backup (Version 1). Bitte eine Datei aus dem JSON-Export wählen.'
        );
        return;
      }
      setPending({ name: file.name, payload: parsed, count: envelope.data.entries.length });
    } catch {
      setImportError('Die Datei konnte nicht als JSON gelesen werden.');
    }
  };

  const runImport = async () => {
    if (!pending) return;
    setImporting(true);
    try {
      const summary = await api.importJson(pending.payload);
      setResult(summary);
      setFileName(pending.name);
      setPending(null);
      invalidate();
      toast.success('Import abgeschlossen.');
    } catch (error) {
      setImportError(errorMessage(error));
      setPending(null);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Backup & Export</h1>
        <p className="text-sm text-muted-foreground">
          Sichere deine Bibliothek oder spiele ein vorhandenes Backup wieder ein.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex flex-col gap-3 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <FileJson className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h2 className="font-semibold">JSON-Backup</h2>
            <p className="text-sm text-muted-foreground">
              Vollständiges Backup mit allen Metadaten, Status, Bewertungen und Notizen – zum
              Wiederherstellen geeignet.
            </p>
          </div>
          <Button onClick={() => void download('json')} disabled={downloading !== null}>
            {downloading === 'json' && <Loader2 className="h-4 w-4 animate-spin" />}
            JSON herunterladen
          </Button>
        </Card>

        <Card className="flex flex-col gap-3 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/15 text-success">
            <FileSpreadsheet className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h2 className="font-semibold">CSV-Export</h2>
            <p className="text-sm text-muted-foreground">
              Tabelle für Excel, LibreOffice oder Google Sheets (UTF-8, mit Schutz vor
              Formel-Injection).
            </p>
          </div>
          <Button variant="outline" onClick={() => void download('csv')} disabled={downloading !== null}>
            {downloading === 'csv' && <Loader2 className="h-4 w-4 animate-spin" />}
            CSV herunterladen
          </Button>
        </Card>
      </div>

      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Upload className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold">JSON-Backup importieren</h2>
            <p className="text-sm text-muted-foreground">
              Bereits vorhandene Bücher werden aktualisiert statt dupliziert (idempotent). Es
              werden nur Einträge in deinem eigenen Index angelegt.
            </p>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          id="import-file"
          onChange={(event) => void onFileSelected(event.target.files?.[0])}
        />
        <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={importing}>
          <Upload className="h-4 w-4" /> Backup-Datei auswählen …
        </Button>

        {importError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {importError}
          </p>
        )}

        {result && (
          <div className="space-y-3 rounded-lg border bg-muted/40 p-4" role="status">
            <p className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="h-5 w-5" /> Import abgeschlossen
              {fileName && <span className="text-sm font-normal text-muted-foreground">({fileName})</span>}
            </p>
            <dl className="grid grid-cols-3 gap-3 text-center">
              {[
                ['Neu importiert', result.imported],
                ['Aktualisiert', result.updated],
                ['Übersprungen', result.skipped],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-card p-3 shadow-sm">
                  <dd className="text-2xl font-bold tabular-nums">{value}</dd>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
            {result.errors.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-destructive">
                  {result.errors.length} Fehler beim Import
                </summary>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {result.errors.slice(0, 50).map((error) => (
                    <li key={`${error.index}-${error.message}`}>
                      Eintrag #{error.index + 1}: {error.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && !importing && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backup importieren?</DialogTitle>
            <DialogDescription>
              „{pending?.name}“ enthält {pending?.count} {pending?.count === 1 ? 'Eintrag' : 'Einträge'}.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              Vorhandene Bücher in deiner Bibliothek werden bei Übereinstimmung aktualisiert. Es
              wird nichts gelöscht.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={importing}>
              Abbrechen
            </Button>
            <Button onClick={() => void runImport()} disabled={importing}>
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Jetzt importieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
