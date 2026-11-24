import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SyncStatusResponse, WebSyncOverallStatus } from '@bibliolisa/shared';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RefreshCw,
  Settings,
  Smartphone,
} from 'lucide-react';
import { errorMessage } from '@/api/client';
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
import { Badge } from '@/components/ui/misc';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface WebSyncPresentation {
  pillLabel: string;
  title: string;
  description: string;
  pillClass: string;
  bannerClass: string;
  icon: typeof CheckCircle2;
}

export function getWebSyncPresentation(
  data: SyncStatusResponse | undefined,
  options: { isLoading: boolean; isFetching: boolean; isError: boolean; error: unknown }
): WebSyncPresentation {
  if (options.isLoading || options.isFetching) {
    return {
      pillLabel: 'Synct…',
      title: 'Synchronisationsstand wird geprüft',
      description: 'Der aktuelle Bibliotheks- und Gerätestand wird vom Server abgerufen.',
      pillClass: 'border-primary/30 bg-primary/15 text-primary',
      bannerClass: 'border-primary/30 bg-primary/10 text-primary',
      icon: Loader2,
    };
  }

  if (options.isError || !data) {
    return {
      pillLabel: 'Sync-Fehler',
      title: 'Sync-Status nicht verfügbar',
      description: options.isError
        ? errorMessage(options.error)
        : 'Der Synchronisationsstand konnte nicht geladen werden.',
      pillClass: 'border-destructive/30 bg-destructive/15 text-destructive',
      bannerClass: 'border-destructive/30 bg-destructive/10 text-destructive',
      icon: AlertTriangle,
    };
  }

  return getPresentationForOverallStatus(data);
}

function getPresentationForOverallStatus(
  data: SyncStatusResponse
): WebSyncPresentation {
  const status: WebSyncOverallStatus = data.status;
  switch (status) {
    case 'synced':
      return {
        pillLabel: 'Synchron',
        title: 'Mit Handy-App synchron',
        description:
          'Alle verknüpften Mobilgeräte befinden sich auf dem aktuellen Server-Stand.',
        pillClass: 'border-success/30 bg-success/15 text-success',
        bannerClass: 'border-success/30 bg-success/10 text-success',
        icon: CheckCircle2,
      };
    case 'server_ahead': {
      const countText =
        data.pendingForMobileCount === 1
          ? '1 Server-Änderung wartet'
          : `${data.pendingForMobileCount} Server-Änderungen warten`;
      return {
        pillLabel: `Handy ausstehend (${data.pendingForMobileCount})`,
        title: 'Handy-Synchronisation ausstehend',
        description: `${countText} auf den nächsten Abgleich durch die Android-App.`,
        pillClass: 'border-warning/30 bg-warning/15 text-warning',
        bannerClass: 'border-warning/30 bg-warning/10 text-warning',
        icon: Clock,
      };
    }
    case 'never_synced':
      return {
        pillLabel: 'Handy nicht gesynct',
        title: 'Handy-App noch nicht synchronisiert',
        description:
          'Mindestens ein aktives Mobilgerät ist angemeldet, hat aber noch keinen vollständigen Sync abgeschlossen.',
        pillClass: 'border-warning/30 bg-warning/15 text-warning',
        bannerClass: 'border-warning/30 bg-warning/10 text-warning',
        icon: AlertTriangle,
      };
    case 'no_mobile_device':
      return {
        pillLabel: 'Kein Handy',
        title: 'Kein Mobilgerät verknüpft',
        description:
          'Für dieses Konto ist aktuell keine aktive Android-App-Sitzung angemeldet.',
        pillClass: 'border-border bg-muted text-muted-foreground',
        bannerClass: 'border-border bg-muted/60 text-foreground',
        icon: Smartphone,
      };
  }
}

export function WebSyncBadge({
  hideSettingsLink = false,
  className,
}: {
  hideSettingsLink?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    lastCheckedAt,
    isManualSyncing,
    triggerManualSync,
  } = useSyncStatus();

  const busy = isLoading || isFetching || isManualSyncing;
  const presentation = getWebSyncPresentation(data, {
    isLoading,
    isFetching: busy,
    isError,
    error,
  });
  const Icon = presentation.icon;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-opacity hover:opacity-85',
          presentation.pillClass,
          className
        )}
        title={presentation.description}
        aria-label={`Sync-Status: ${presentation.pillLabel}`}
      >
        <Icon className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        <span>{presentation.pillLabel}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Synchronisations-Status</DialogTitle>
            <DialogDescription>
              Überblick über den Abgleich zwischen Server/Webapp und deinen Mobilgeräten.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div
              className={cn(
                'flex items-start gap-3 rounded-lg border p-3.5',
                presentation.bannerClass
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', busy && 'animate-spin')} />
              <div className="space-y-0.5 text-sm">
                <p className="font-semibold">{presentation.title}</p>
                <p className="text-xs opacity-90">{presentation.description}</p>
              </div>
            </div>

            {data && (
              <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Aktive Bücher</dt>
                  <dd className="font-semibold tabular-nums">
                    {data.totalBooks}
                    {data.deletedBooks > 0 ? ` (${data.deletedBooks} im Papierkorb)` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Letzte Prüfung</dt>
                  <dd className="font-medium">{formatDateTime(lastCheckedAt)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">
                    Letzte Bibliotheksänderung (Server)
                  </dt>
                  <dd className="font-medium">
                    {data.libraryLastModifiedAt
                      ? formatDateTime(data.libraryLastModifiedAt)
                      : 'Noch keine Bücher vorhanden'}
                  </dd>
                </div>
              </dl>
            )}

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Verknüpfte Mobilgeräte
              </h3>
              {!data || data.devices.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  Bisher ist kein Mobilgerät mit diesem Konto verknüpft. Melde dich in der Android-App an, um deine Bibliothek zu synchronisieren.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.devices.map((device) => (
                    <li
                      key={device.deviceId}
                      className="space-y-1 rounded-lg border bg-background p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                          <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                          {device.deviceName ?? 'Android-Gerät'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            className={
                              device.sessionActive
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }
                          >
                            {device.sessionActive ? 'Aktiv' : 'Abgemeldet'}
                          </Badge>
                          <Badge
                            className={
                              device.isUpToDate
                                ? 'bg-success/15 text-success'
                                : 'bg-warning/15 text-warning'
                            }
                          >
                            {device.isUpToDate
                              ? 'Aktuell'
                              : device.lastSyncAt === null || !device.lastSyncCompleted
                                ? 'Ausstehend'
                                : `${device.pendingServerChanges} offen`}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-muted-foreground">
                        Letzter Sync:{' '}
                        {device.lastSyncAt ? formatDateTime(device.lastSyncAt) : 'Noch nie'} · ↑{' '}
                        {device.lastPushedCount} gepusht / ↓ {device.lastPulledCount} gepullt
                      </p>
                      {device.clockSkewWarning && (
                        <p className="text-warning">
                          Hinweis: Abweichende Geräteuhr erkannt (Server-Zeitstempel-Schutz aktiv).
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Hinweis: Reine Offline-Änderungen auf einem derzeit nicht verbundenen Handy werden für den Server erst sichtbar, sobald die Android-App den nächsten Sync ausführt.
              </p>
            </div>
          </DialogBody>

          <DialogFooter className="sm:justify-between">
            {!hideSettingsLink ? (
              <Button variant="outline" asChild onClick={() => setOpen(false)}>
                <Link to="/settings#sync">
                  <Settings className="h-4 w-4" /> Einstellungen öffnen
                </Link>
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={() => void triggerManualSync()} disabled={busy}>
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              Jetzt synchronisieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
