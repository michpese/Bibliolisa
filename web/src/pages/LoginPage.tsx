import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Loader2 } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export function LoginPage() {
  const { status, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    retry: 1,
    staleTime: 60_000,
  });
  const registrationOpen = health.data?.allowRegistration ?? true;

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') {
    return <Navigate to={from} replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await login({ username: username.trim(), password });
      } else {
        await register({
          username: username.trim(),
          password,
          displayName: displayName.trim() || null,
        });
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-accent/60 via-background to-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
            <BookOpen className="h-7 w-7" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bibliolisa</h1>
            <p className="text-sm text-muted-foreground">Dein persönlicher Bücher-Index</p>
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-xl">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {(['login', 'register'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                disabled={value === 'register' && !registrationOpen}
                title={
                  value === 'register' && !registrationOpen
                    ? 'Registrierung ist auf diesem Server deaktiviert.'
                    : undefined
                }
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={cn(
                  'rounded-md py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  mode === value
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {value === 'login' ? 'Anmelden' : 'Registrieren'}
              </button>
            ))}
          </div>

          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="username">Benutzername</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                required
              />
            </div>
            {mode === 'register' && (
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Anzeigename (optional)</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  maxLength={80}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="password">Passwort</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'register' ? 8 : undefined}
                required
              />
              {mode === 'register' && (
                <p className="text-xs text-muted-foreground">Mindestens 8 Zeichen.</p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" size="lg" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
            </Button>
          </form>
        </div>

        {health.isError && (
          <p className="mt-4 text-center text-xs text-destructive">
            Der Server ist aktuell nicht erreichbar.
          </p>
        )}
      </div>
    </div>
  );
}
