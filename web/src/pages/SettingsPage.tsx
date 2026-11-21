import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Loader2, Monitor, Moon, Smartphone, Sun, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
        <p className="text-sm text-muted-foreground">Konto, Darstellung und angemeldete Geräte.</p>
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

      <SessionsCard />
      <PasswordCard />
    </div>
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
