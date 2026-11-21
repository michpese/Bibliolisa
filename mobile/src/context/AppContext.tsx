import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getDatabase } from '../db/client';
import { restoreLocalLibraryEntry } from '../db/library.repo';
import {
  adoptLocalDataForUser,
  countPendingChanges,
  getAppSessionState,
  resetLocalLibraryData,
  setSyncStateValue,
  type AppSessionState,
} from '../db/sync-state.repo';
import type { SqlExecutor } from '../db/types';
import {
  loginMobileAccount,
  logoutMobileBestEffort,
  registerMobileAccount,
} from '../services/api-client';
import { clearCoverCache } from '../services/cover-cache';
import { clearAuthTokens, getAuthTokens } from '../services/secure-storage';
import { normalizeServerUrl } from '../sync/health-check';
import { generateUuid } from '../utils/uuid';

export interface DeletedUndoInfo {
  id: string;
  title: string;
}

export interface AppContextValue {
  ready: boolean;
  initError: string | null;
  db: SqlExecutor | null;
  session: AppSessionState | null;
  userId: string;
  deviceId: string;
  serverUrl: string | null;
  isAuthenticated: boolean;
  pendingChangesCount: number;
  libraryVersion: number;
  lastDeleted: DeletedUndoInfo | null;
  notifyDataChanged: (deletedUndo?: DeletedUndoInfo | null) => Promise<void>;
  dismissUndoBanner: () => void;
  undoLastDelete: () => Promise<void>;
  saveServerUrl: (rawUrl: string) => Promise<string>;
  signIn: (params: {
    serverUrl: string;
    username: string;
    password: string;
  }) => Promise<void>;
  registerAccount: (params: {
    serverUrl: string;
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [db, setDb] = useState<SqlExecutor | null>(null);
  const [session, setSession] = useState<AppSessionState | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pendingChangesCount, setPendingChangesCount] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [lastDeleted, setLastDeleted] = useState<DeletedUndoInfo | null>(null);

  const refreshState = useCallback(async (executor: SqlExecutor) => {
    const [nextSession, tokens] = await Promise.all([
      getAppSessionState(executor),
      getAuthTokens(),
    ]);
    const pending = await countPendingChanges(executor, nextSession.userId);
    setSession(nextSession);
    setPendingChangesCount(pending);
    setIsAuthenticated(!nextSession.isLocalOnlyUser && tokens !== null);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const executor = await getDatabase();
        if (!active) return;
        setDb(executor);
        await refreshState(executor);
        if (!active) return;
        setReady(true);
      } catch (error) {
        if (!active) return;
        setInitError(
          error instanceof Error
            ? error.message
            : 'Lokale Datenbank konnte nicht initialisiert werden.'
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshState]);

  const notifyDataChanged = useCallback(
    async (deletedUndo?: DeletedUndoInfo | null) => {
      if (deletedUndo !== undefined) {
        setLastDeleted(deletedUndo);
      }
      if (db) {
        await refreshState(db);
      }
      setLibraryVersion((v) => v + 1);
    },
    [db, refreshState]
  );

  const dismissUndoBanner = useCallback(() => {
    setLastDeleted(null);
  }, []);

  const undoLastDelete = useCallback(async () => {
    if (!db || !session || !lastDeleted) return;
    await restoreLocalLibraryEntry(db, session.userId, lastDeleted.id);
    setLastDeleted(null);
    await refreshState(db);
    setLibraryVersion((v) => v + 1);
  }, [db, lastDeleted, refreshState, session]);

  const saveServerUrl = useCallback(
    async (rawUrl: string): Promise<string> => {
      if (!db || !session) {
        throw new Error('Datenbank noch nicht bereit.');
      }
      const normalized = normalizeServerUrl(rawUrl);
      if (!normalized.ok) {
        throw new Error(normalized.message);
      }

      const previousUrl = session.serverUrl;
      const instanceChanged =
        previousUrl !== null && previousUrl !== normalized.url;

      if (instanceChanged) {
        await clearAuthTokens();
        await clearCoverCache();
        await resetLocalLibraryData(db, { keepServerUrl: false }, generateUuid);
      }

      await setSyncStateValue(db, 'server_url', normalized.url);
      await refreshState(db);
      if (instanceChanged) {
        setLastDeleted(null);
        setLibraryVersion((v) => v + 1);
      }
      return normalized.url;
    },
    [db, refreshState, session]
  );

  const applyAuthenticatedUser = useCallback(
    async (executor: SqlExecutor, currentSession: AppSessionState, normalizedUrl: string, user: Awaited<ReturnType<typeof loginMobileAccount>>) => {
      const serverChanged =
        currentSession.serverUrl !== null &&
        currentSession.serverUrl !== normalizedUrl;

      if (serverChanged || (!currentSession.isLocalOnlyUser && currentSession.userId !== user.id)) {
        await clearCoverCache();
        await resetLocalLibraryData(
          executor,
          { keepServerUrl: false, newUser: user },
          generateUuid
        );
      } else {
        await adoptLocalDataForUser(executor, user);
      }

      await setSyncStateValue(executor, 'server_url', normalizedUrl);
      await refreshState(executor);
      setLastDeleted(null);
      setLibraryVersion((v) => v + 1);
    },
    [refreshState]
  );

  const signIn = useCallback(
    async (params: { serverUrl: string; username: string; password: string }) => {
      if (!db || !session) {
        throw new Error('Datenbank noch nicht bereit.');
      }
      const normalized = normalizeServerUrl(params.serverUrl);
      if (!normalized.ok) {
        throw new Error(normalized.message);
      }

      const user = await loginMobileAccount(normalized.url, {
        username: params.username,
        password: params.password,
        deviceId: session.deviceId,
      });

      await applyAuthenticatedUser(db, session, normalized.url, user);
    },
    [applyAuthenticatedUser, db, session]
  );

  const registerAccount = useCallback(
    async (params: {
      serverUrl: string;
      username: string;
      password: string;
      displayName?: string;
    }) => {
      if (!db || !session) {
        throw new Error('Datenbank noch nicht bereit.');
      }
      const normalized = normalizeServerUrl(params.serverUrl);
      if (!normalized.ok) {
        throw new Error(normalized.message);
      }

      const user = await registerMobileAccount(normalized.url, {
        username: params.username,
        password: params.password,
        displayName: params.displayName,
        deviceId: session.deviceId,
      });

      await applyAuthenticatedUser(db, session, normalized.url, user);
    },
    [applyAuthenticatedUser, db, session]
  );

  const signOut = useCallback(async () => {
    if (!db || !session) return;

    if (session.serverUrl) {
      await logoutMobileBestEffort(session.serverUrl);
    }

    await clearAuthTokens();
    await clearCoverCache();
    await resetLocalLibraryData(db, { keepServerUrl: true }, generateUuid);
    await refreshState(db);
    setLastDeleted(null);
    setLibraryVersion((v) => v + 1);
  }, [db, refreshState, session]);

  return (
    <AppContext.Provider
      value={{
        ready,
        initError,
        db,
        session,
        userId: session?.userId ?? '',
        deviceId: session?.deviceId ?? '',
        serverUrl: session?.serverUrl ?? null,
        isAuthenticated,
        pendingChangesCount,
        libraryVersion,
        lastDeleted,
        notifyDataChanged,
        dismissUndoBanner,
        undoLastDelete,
        saveServerUrl,
        signIn,
        registerAccount,
        signOut,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext muss innerhalb von AppProvider verwendet werden.');
  }
  return ctx;
}
