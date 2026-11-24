import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Network from 'expo-network';
import { useAppContext } from '../context/AppContext';
import {
  ensureFreshAccessToken,
  fetchBookCoverOnServer,
  getMobileDeviceName,
  isAuthError,
  isNetworkError,
  MobileApiError,
  refreshMobileTokens,
  syncWithServer,
  uploadBookCover,
} from '../services/api-client';
import {
  cleanupOrphanCovers,
  downloadCachedCover,
  getCachedCoverUri,
} from '../services/cover-cache';
import { getAuthTokens } from '../services/secure-storage';
import { checkServerHealth } from './health-check';
import {
  SyncEngine,
  type SyncStateSnapshot,
  type SyncTrigger,
} from './sync-engine';

const FOREGROUND_COOLDOWN_MS = 30_000;
const LOCAL_WRITE_DEBOUNCE_MS = 2_000;
const RECONNECT_DEBOUNCE_MS = 1_500;

const INITIAL_SNAPSHOT: SyncStateSnapshot = {
  status: 'offline',
  pendingCount: 0,
  lastSyncAt: null,
  lastSyncError: null,
  clockSkewWarning: false,
  clockSkewMs: null,
  isSyncing: false,
  isConfigured: false,
  isAuthenticated: false,
  lastSummary: null,
};

export interface SyncContextValue {
  snapshot: SyncStateSnapshot;
  syncNow: (trigger?: SyncTrigger) => Promise<SyncStateSnapshot>;
  refreshSyncStatus: () => Promise<SyncStateSnapshot>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

function isMobileOrFsNetworkError(error: unknown): boolean {
  if (isNetworkError(error)) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('network request failed') ||
      msg.includes('unabletodownload') ||
      msg.includes('failed to connect') ||
      msg.includes('sockettimeout') ||
      msg.includes('unknownhost') ||
      msg.includes('timed out') ||
      msg.includes('connection reset')
    ) {
      return !/\b[45]\d{2}\b/.test(msg);
    }
  }
  return false;
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const {
    ready,
    db,
    userId,
    serverUrl,
    isAuthenticated,
    localWriteVersion,
    refreshFromSync,
  } = useAppContext();

  const [snapshot, setSnapshot] = useState<SyncStateSnapshot>(INITIAL_SNAPSHOT);

  const refreshFromSyncRef = useRef(refreshFromSync);
  useEffect(() => {
    refreshFromSyncRef.current = refreshFromSync;
  }, [refreshFromSync]);

  const engine = useMemo(() => {
    if (!ready || !db) {
      return null;
    }

    return new SyncEngine({
      db,
      deviceName: getMobileDeviceName(),
      checkHealth: checkServerHealth,
      ensureAccessToken: ensureFreshAccessToken,
      hasStoredTokens: async () => (await getAuthTokens()) !== null,
      syncRequest: (url, payload) => syncWithServer(url, payload),
      isWifiConnected: async () => {
        try {
          const state = await Network.getNetworkStateAsync();
          return (
            state.isConnected === true &&
            state.type === Network.NetworkStateType.WIFI
          );
        } catch {
          return false;
        }
      },
      isAuthError,
      isNetworkError: isMobileOrFsNetworkError,
      coverAdapter: {
        getCachedCoverUri,
        async downloadCover({ serverUrl: url, coverKey, accessToken }) {
          try {
            return await downloadCachedCover({
              serverUrl: url,
              coverKey,
              accessToken,
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (!/\b401\b/.test(msg)) {
              throw error;
            }
            const refreshed = await refreshMobileTokens(url);
            if (!refreshed) {
              throw new MobileApiError(
                401,
                'SESSION_EXPIRED',
                'Anmeldung abgelaufen – bitte erneut anmelden.'
              );
            }
            try {
              return await downloadCachedCover({
                serverUrl: url,
                coverKey,
                accessToken: refreshed.accessToken,
              });
            } catch (retryError) {
              const retryMsg =
                retryError instanceof Error
                  ? retryError.message
                  : String(retryError);
              if (/\b401\b/.test(retryMsg)) {
                throw new MobileApiError(
                  401,
                  'SESSION_EXPIRED',
                  'Anmeldung abgelaufen – bitte erneut anmelden.'
                );
              }
              throw retryError;
            }
          }
        },
        uploadCover: ({ serverUrl: url, bookId, localUri }) =>
          uploadBookCover(url, bookId, localUri),
        fetchRemoteCoverOnServer: ({ serverUrl: url, bookId, url: remoteUrl }) =>
          fetchBookCoverOnServer(url, bookId, remoteUrl),
        cleanupOrphans: cleanupOrphanCovers,
      },
      onDataChanged: async () => {
        await refreshFromSyncRef.current();
      },
      onStateChange: (next) => {
        setSnapshot(next);
      },
    });
  }, [db, ready]);

  // 1. Initialisierung, Account-/Server-Wechsel & Startup-Sync
  const lastAuthSessionKeyRef = useRef<string>('');
  useEffect(() => {
    if (!engine) return;
    let active = true;

    const authKey = `${userId}|${serverUrl ?? ''}|${isAuthenticated ? '1' : '0'}`;
    void engine.refreshStatus().then(() => {
      if (!active) return;
      if (isAuthenticated && serverUrl && lastAuthSessionKeyRef.current !== authKey) {
        lastAuthSessionKeyRef.current = authKey;
        void engine.sync('startup');
      } else {
        lastAuthSessionKeyRef.current = authKey;
      }
    });

    return () => {
      active = false;
    };
  }, [engine, isAuthenticated, serverUrl, userId]);

  // 2. Foreground-Resume mit 30-Sekunden-Cooldown
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastForegroundCheckAtRef = useRef<number>(0);
  useEffect(() => {
    if (!engine) return;

    const subscription = AppState.addEventListener('change', (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (
        (prev === 'background' || prev === 'inactive') &&
        nextState === 'active'
      ) {
        const now = Date.now();
        if (now - lastForegroundCheckAtRef.current >= FOREGROUND_COOLDOWN_MS) {
          lastForegroundCheckAtRef.current = now;
          void engine.sync('foreground');
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [engine]);

  // 3. Lokale Schreibvorgänge: sofort pending anzeigen + 2s-Debounced WLAN-Sync
  const lastProcessedWriteVersionRef = useRef<number>(localWriteVersion);
  useEffect(() => {
    if (!engine) return;
    if (localWriteVersion === lastProcessedWriteVersionRef.current) {
      return;
    }
    lastProcessedWriteVersionRef.current = localWriteVersion;

    void engine.refreshStatus();

    const timer = setTimeout(() => {
      void engine.sync('local_write');
    }, LOCAL_WRITE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [engine, localWriteVersion]);

  // 4. WLAN-Reconnect-Trigger über expo-network
  const wasWifiRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!engine) return;

    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    void Network.getNetworkStateAsync()
      .then((initial) => {
        if (!active) return;
        wasWifiRef.current =
          initial.isConnected === true &&
          initial.type === Network.NetworkStateType.WIFI;
      })
      .catch(() => {
        wasWifiRef.current = null;
      });

    const subscription = Network.addNetworkStateListener((state) => {
      const isWifiNow =
        state.isConnected === true &&
        state.type === Network.NetworkStateType.WIFI;
      const wasWifi = wasWifiRef.current;
      wasWifiRef.current = isWifiNow;

      if (wasWifi === false && isWifiNow) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void engine.sync('reconnect');
        }, RECONNECT_DEBOUNCE_MS);
      }
    });

    return () => {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      subscription.remove();
    };
  }, [engine]);

  const syncNow = useCallback(
    async (trigger: SyncTrigger = 'manual'): Promise<SyncStateSnapshot> => {
      if (!engine) {
        return INITIAL_SNAPSHOT;
      }
      return engine.sync(trigger);
    },
    [engine]
  );

  const refreshSyncStatus = useCallback(async (): Promise<SyncStateSnapshot> => {
    if (!engine) {
      return INITIAL_SNAPSHOT;
    }
    return engine.refreshStatus();
  }, [engine]);

  return (
    <SyncContext.Provider value={{ snapshot, syncNow, refreshSyncStatus }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error('useSyncContext muss innerhalb von SyncProvider verwendet werden.');
  }
  return ctx;
}
