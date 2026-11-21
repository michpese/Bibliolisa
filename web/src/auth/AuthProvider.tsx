import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@bibliolisa/shared';
import {
  api,
  clearSession,
  getAccessTokenExpiresAtMs,
  refreshSession,
  setSessionLostHandler,
  type LoginInput,
  type RegisterInput,
} from '@/api/client';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Erneuert das Access Token (und damit das Cover-Media-Cookie) vor Ablauf der 15 Minuten. */
const REFRESH_LEAD_MS = 2 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 20 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const queryClient = useQueryClient();
  const timerRef = useRef<number | null>(null);

  const markAnonymous = useCallback(() => {
    clearSession();
    setUser(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  const scheduleRefresh: () => void = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const expiresAt = getAccessTokenExpiresAtMs();
    if (!expiresAt) return;
    const delay = Math.max(
      MIN_REFRESH_DELAY_MS,
      expiresAt - Date.now() - REFRESH_LEAD_MS
    );
    timerRef.current = window.setTimeout(() => {
      void refreshSession()
        .then((result) => {
          if (result) {
            setUser(result.user);
            scheduleRefresh();
          } else {
            markAnonymous();
          }
        })
        .catch(() => {
          // Netzwerkfehler: später erneut versuchen
          timerRef.current = window.setTimeout(() => scheduleRefresh(), 30_000);
        });
    }, delay);
  }, [markAnonymous]);

  // Initiale Session-Wiederherstellung über das HttpOnly-Refresh-Cookie
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setUser(result.user);
          setStatus('authenticated');
          scheduleRefresh();
        } else {
          setStatus('anonymous');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleRefresh]);

  // Session-Verlust (z. B. widerrufenes Refresh-Token) -> sauber abmelden
  useEffect(() => {
    setSessionLostHandler(markAnonymous);
    return () => setSessionLostHandler(null);
  }, [markAnonymous]);

  // Nach Tab-Wechsel / Standby prüfen, ob das Token bald abläuft
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || status !== 'authenticated') {
        return;
      }
      if (getAccessTokenExpiresAtMs() - Date.now() < REFRESH_LEAD_MS) {
        void refreshSession()
          .then((result) => {
            if (result) {
              setUser(result.user);
              scheduleRefresh();
            } else {
              markAnonymous();
            }
          })
          .catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [status, scheduleRefresh, markAnonymous]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const login = useCallback(
    async (input: LoginInput) => {
      const result = await api.login(input);
      queryClient.clear();
      setUser(result.user);
      setStatus('authenticated');
      scheduleRefresh();
    },
    [queryClient, scheduleRefresh]
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await api.register(input);
      queryClient.clear();
      setUser(result.user);
      setStatus('authenticated');
      scheduleRefresh();
    },
    [queryClient, scheduleRefresh]
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Auch bei Fehler lokal abmelden
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    markAnonymous();
  }, [markAnonymous]);

  const refreshUser = useCallback(async () => {
    const me = await api.me();
    setUser(me);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout, refreshUser }),
    [status, user, login, register, logout, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth muss innerhalb von AuthProvider verwendet werden.');
  }
  return ctx;
}
