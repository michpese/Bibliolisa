import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Laptop,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { WebSyncBadge, getWebSyncPresentation } from '@/components/WebSyncBadge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
import { syncKeys, useRemoveSyncDevice, useSyncStatus } from '@/hooks/useSyncStatus';
import { formatDateTime } from '@/lib/format';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Hell', icon: Sun },
  { value: 'dark', label: 'Dunkel', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function SettingsPage() {
  const { user } = useAuth();
  const { preference, setPreference } = useTheme();
  const location = useLocation();

  useEffect(() => {
    if (location.hash === '#sync') {
      document.getElementById('sync')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
        <p className="text-sm text-muted-foreground">
          Konto, Darstellung, Synchronisation und angemeldete Geräte.
        </p>
      </div>

      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Konto</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Benutzername</dt>
            <dd className="font-medium">{user?.username}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Anzeigename</dt>
            <dd className="font-medium">{user?.displayName ?? '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Rolle</dt>
            <dd>
              <Badge className="bg-accent text-accent-foreground">
                {user?.role === 'admin' ? 'Administrator' : 'Benutzer'}
              </Badge>
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Darstellung</h2>
        <div className="inline-flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Farbschema">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={preference === value}
              onClick={() => setPreference(value)}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors',
                preference === value
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      </Card>

      <SyncStatusCard />
      <SessionsCard />
      <PasswordCard />
    </div>
  );
}

function SyncStatusCard() {
  const [confirmDeviceId, setConfirmDeviceId] = useState<string | null>(null);
  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    lastCheckedAt,
    lastSyncFeedback,
    isManualSyncing,
    triggerManualSync,
  } = useSyncStatus();
  const removeDevice = useRemoveSyncDevice();

  const busy = isLoading || isFetching || isManualSyncing;
  const presentation = getWebSyncPresentation(data, {
    isLoading,
    isFetching: busy,
    isError,
    error,
  });

  return (
    <Card id="sync" className="scroll-mt-20 space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Synchronisation</h2>
          <p className="text-sm text-muted-foreground">
            Bibliotheksabgleich zwischen Server, Webapp und verknüpften Mobilgeräten.
          </p>
        </div>
        <WebSyncBadge hideSettingsLink />
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : (
        data && (
          <>
            <dl className="grid gap-3 rounded-lg border bg-muted/30 p-3.5 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Aktive Bücher gesamt</dt>
                <dd className="font-semibold tabular-nums">
                  {data.totalBooks}
                  {data.deletedBooks > 0 ? ` (${data.deletedBooks} im Papierkorb)` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Gesamtstatus</dt>
                <dd className="font-medium">{presentation.title}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Letzte Server-Änderung</dt>
                <dd className="font-medium">
                  {data.libraryLastModifiedAt
                    ? formatDateTime(data.libraryLastModifiedAt)
                    : 'Noch keine Einträge'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Letzte Prüfung (Webapp)</dt>
                <dd className="font-medium">{formatDateTime(lastCheckedAt)}</dd>
              </div>
            </dl>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Geräte-Synchronisation
              </h3>
              {data.devices.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  Aktuell ist kein Mobilgerät mit diesem Konto synchronisiert oder angemeldet.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {data.devices.map((device) => {
                    const isConfirming = confirmDeviceId === device.deviceId;
                    const shortId =
                      device.deviceId.length > 8
                        ? `${device.deviceId.slice(0, 8)}…`
                        : device.deviceId;
                    return (
                      <li key={device.deviceId} className="space-y-2 p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <Smartphone className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2 font-medium">
                              <span>{device.deviceName ?? 'Android-Gerät'}</span>
                              <span
                                title={`Geräte-ID: ${device.deviceId}`}
                                className="font-mono text-xs font-normal text-muted-foreground"
                              >
                                ID: {shortId}
                              </span>
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
                                    ? 'Sync offen'
                                    : `${device.pendingServerChanges} ausstehend`}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Letzter Sync:{' '}
                              {device.lastSyncAt ? formatDateTime(device.lastSyncAt) : 'Noch nie'} ·
                              Letzter Transfer: ↑ {device.lastPushedCount} gepusht / ↓{' '}
                              {device.lastPulledCount} gepullt
                            </p>
                            {device.clockSkewWarning && (
                              <p className="text-xs text-warning">
                                Hinweis: Geräteuhr weicht vom Server ab (Zeitstempel-Schutz aktiv).
                              </p>
                            )}
                          </div>
                          {!isConfirming && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="iconSm"
                              title={
                                device.sessionActive
                                  ? 'Sitzung beenden & Gerät entfernen'
                                  : 'Gerät entfernen'
                              }
                              aria-label="Gerät entfernen"
                              onClick={() => setConfirmDeviceId(device.deviceId)}
                              disabled={removeDevice.isPending}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                        {isConfirming && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                            <span className="text-destructive">
                              {device.sessionActive
                                ? 'Sitzung beenden und Gerät aus der Synchronisation entfernen?'
                                : 'Gerät aus der Synchronisation entfernen?'}
                            </span>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmDeviceId(null)}
                                disabled={removeDevice.isPending}
                              >
                                Abbrechen
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() =>
                                  removeDevice.mutate(device.deviceId, {
                                    onSettled: () => setConfirmDeviceId(null),
                                  })
                                }
                                disabled={removeDevice.isPending}
                              >
                                {removeDevice.isPending && (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                )}
                                Entfernen
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Reine Offline-Änderungen, die ausschließlich lokal auf einem gerade nicht verbundenen Handy liegen, erkennt der Server erst nach dem nächsten Sync der Android-App.
              </p>
            </div>
          </>
        )
      )}

      <div className="space-y-3 pt-1">
        <div>
          <Button onClick={() => void triggerManualSync()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Jetzt synchronisieren
          </Button>
        </div>

        {lastSyncFeedback && (
          <div
            role="status"
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm',
              lastSyncFeedback.tone === 'success' &&
                'border-success/30 bg-success/10 text-success',
              lastSyncFeedback.tone === 'warning' &&
                'border-warning/30 bg-warning/10 text-warning',
              lastSyncFeedback.tone === 'info' &&
                'border-border bg-muted/60 text-foreground',
              lastSyncFeedback.tone === 'error' &&
                'border-destructive/30 bg-destructive/10 text-destructive'
            )}
          >
            {lastSyncFeedback.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : lastSyncFeedback.tone === 'info' ? (
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="space-y-0.5">
              <p className="font-medium">{lastSyncFeedback.message}</p>
              <p className="text-xs opacity-80">
                Geprüft am {formatDateTime(lastSyncFeedback.checkedAt)}
              </p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function SessionsCard() {
  const client = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: () => {
      toast.success('Gerät abgemeldet.');
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: syncKeys.status });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Angemeldete Geräte</h2>
        <p className="text-sm text-muted-foreground">
          Hier siehst du alle aktiven Sitzungen (Web und Android) und kannst sie beenden.
        </p>
      </div>

      {sessions.isLoading && <Skeleton className="h-16 w-full" />}
      {sessions.isError && (
        <p className="text-sm text-destructive">{errorMessage(sessions.error)}</p>
      )}

      <ul className="divide-y">
        {sessions.data?.sessions.map((session) => {
          const Icon = session.clientType === 'mobile' ? Smartphone : Laptop;
          return (
            <li key={session.id} className="flex items-center gap-3 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {session.deviceName ?? (session.clientType === 'mobile' ? 'Android-App' : 'Webbrowser')}
                  {session.isCurrent && (
                    <Badge className="bg-success/15 text-success">Dieses Gerät</Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Zuletzt aktiv: {formatDateTime(session.lastUsedAt ?? session.createdAt)} · läuft ab:{' '}
                  {formatDateTime(session.expiresAt)}
                </p>
              </div>
              {!session.isCurrent && (
                <Button
                  variant="ghost"
                  size="iconSm"
                  title="Gerät abmelden"
                  aria-label="Gerät abmelden"
                  onClick={() => revoke.mutate(session.id)}
                  disabled={revoke.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PasswordCard() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      }),
    onSuccess: () => {
      toast.success('Passwort geändert.');
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: syncKeys.status });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (next.length < 8) {
      setError('Das neue Passwort muss mindestens 8 Zeichen lang sein.');
      return;
    }
    if (next !== confirm) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }
    setError(null);
    change.mutate();
  };

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold">Passwort ändern</h2>
      <form className="grid max-w-md gap-3" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="current-password">Aktuelles Passwort</Label>
          <Input
            id="current-password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">Neues Passwort</Label>
          <Input
            id="new-password"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">Neues Passwort wiederholen</Label>
          <Input
            id="confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
          />
          Alle anderen Geräte abmelden
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={change.isPending}>
            {change.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Passwort ändern
          </Button>
        </div>
      </form>
    </Card>
  );
}
