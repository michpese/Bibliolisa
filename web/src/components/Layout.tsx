import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Download,
  Library,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { BookFormDialog } from '@/components/BookFormDialog';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/', label: 'Bibliothek', icon: Library, end: true },
  { to: '/recommendations', label: 'Empfehlungen', icon: Sparkles, end: false },
  { to: '/backup', label: 'Backup', icon: Download, end: false },
  { to: '/settings', label: 'Einstellungen', icon: Settings, end: false },
] as const;

function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const next = preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light';
  const Icon = preference === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
  const label =
    preference === 'system'
      ? 'Theme: System'
      : preference === 'dark'
        ? 'Theme: Dunkel'
        : 'Theme: Hell';

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(next)}
      title={`${label} (Klick zum Wechseln)`}
      aria-label={`${label}. Klicken zum Wechseln.`}
    >
      <Icon className="h-5 w-5" />
    </Button>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
        <div className="container flex h-14 items-center gap-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BookOpen className="h-4 w-4" />
            </span>
            <span className="hidden sm:inline">Bibliolisa</span>
          </NavLink>

          <nav className="ml-2 hidden items-center gap-1 md:flex" aria-label="Hauptnavigation">
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <Button onClick={() => setAddOpen(true)} size="sm" className="h-9">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Buch hinzufügen</span>
              <span className="sm:hidden">Neu</span>
            </Button>
            <ThemeToggle />
            <span className="hidden max-w-[10rem] truncate text-sm text-muted-foreground lg:inline">
              {user?.displayName ?? user?.username}
            </span>
            <Button
              variant="ghost"
              size="icon"
              title="Abmelden"
              aria-label="Abmelden"
              onClick={() => {
                void logout().then(() => navigate('/login', { replace: true }));
              }}
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container flex-1 pb-24 pt-5 md:pb-10">
        <Outlet />
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur md:hidden"
        aria-label="Hauptnavigation (mobil)"
      >
        <ul className="grid grid-cols-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
                    isActive ? 'text-primary' : 'text-muted-foreground'
                  )
                }
              >
                <Icon className="h-5 w-5" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <BookFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(entry) => navigate(`/books/${entry.id}`)}
      />
    </div>
  );
}
