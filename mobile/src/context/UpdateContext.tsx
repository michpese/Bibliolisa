import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as Network from 'expo-network';
import { getSyncStateValue, setSyncStateValue } from '../db/sync-state.repo';
import type { SqlExecutor } from '../db/types';
import {
  cleanupCachedUpdateApks,
  getInstalledAppInfo,
} from '../services/app-updater';
import {
  CachedAppReleaseSchema,
  checkForAppUpdate,
  type AppReleaseInfo,
} from '../services/app-updater-utils';
import { useAppContext } from './AppContext';

const KEY_AUTO_CHECK = 'update_auto_check';
const KEY_SKIPPED_VERSION = 'update_skipped_version';
const KEY_LAST_CHECKED_AT = 'update_last_checked_at';
const KEY_ETAG = 'update_etag';
const KEY_CACHED_RELEASE = 'update_cached_release';

export type UpdateCheckSource = 'auto' | 'manual';

export interface UpdateContextValue {
  currentVersion: string;
  buildCode: string | null;
  autoCheckEnabled: boolean;
  isChecking: boolean;
  lastCheckedAt: string | null;
  availableRelease: AppReleaseInfo | null;
  lastCheckMessage: string | null;
  lastCheckError: string | null;
  modalVisible: boolean;
  checkNow: (source?: UpdateCheckSource) => Promise<void>;
  setAutoCheckEnabled: (enabled: boolean) => Promise<void>;
  skipAvailableRelease: () => Promise<void>;
  openUpdateModal: () => void;
  closeUpdateModal: () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

function parseCachedRelease(raw: string | null): AppReleaseInfo | null {
  if (!raw) return null;
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = CachedAppReleaseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function isInternetAvailable(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch {
    return true;
  }
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { ready, db } = useAppContext();
  const [{ version: currentVersion, buildCode }] = useState(() =>
    getInstalledAppInfo()
  );

  const [autoCheckEnabled, setAutoCheckState] = useState(true);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [availableRelease, setAvailableRelease] =
    useState<AppReleaseInfo | null>(null);
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);
  const [lastCheckError, setLastCheckError] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const inFlightRef = useRef<Promise<void> | null>(null);
  const startupInitializedRef = useRef(false);

  const runCheck = useCallback(
    async (executor: SqlExecutor, source: UpdateCheckSource): Promise<void> => {
      if (inFlightRef.current) {
        return inFlightRef.current;
      }

      const task = (async () => {
        if (mountedRef.current) {
          setIsChecking(true);
          if (source === 'manual') {
            setLastCheckError(null);
            setLastCheckMessage(null);
          }
        }

        try {
          const online = await isInternetAvailable();
          if (!online) {
            if (source === 'manual' && mountedRef.current) {
              setLastCheckError(
                'Keine Internetverbindung. Bitte verbinde dich mit einem Netzwerk und versuche es erneut.'
              );
            }
            return;
          }

          const [savedEtag, savedReleaseRaw, skippedVersion] =
            await Promise.all([
              getSyncStateValue(executor, KEY_ETAG),
              getSyncStateValue(executor, KEY_CACHED_RELEASE),
              getSyncStateValue(executor, KEY_SKIPPED_VERSION),
            ]);

          const cachedRelease = parseCachedRelease(savedReleaseRaw);

          const result = await checkForAppUpdate({
            currentVersion,
            etag: savedEtag,
            cachedRelease,
          });

          const checkedAt = new Date().toISOString();
          await setSyncStateValue(executor, KEY_LAST_CHECKED_AT, checkedAt);
          if (mountedRef.current) {
            setLastCheckedAt(checkedAt);
          }

          if (result.status === 'update_available') {
            await Promise.all([
              setSyncStateValue(executor, KEY_ETAG, result.etag),
              !result.fromCache
                ? setSyncStateValue(
                    executor,
                    KEY_CACHED_RELEASE,
                    JSON.stringify(result.release)
                  )
                : Promise.resolve(),
              source === 'manual' && skippedVersion === result.release.version
                ? setSyncStateValue(executor, KEY_SKIPPED_VERSION, null)
                : Promise.resolve(),
            ]);

            if (mountedRef.current) {
              setAvailableRelease(result.release);
              setLastCheckError(null);
              if (source === 'manual') {
                setLastCheckMessage(
                  `Neue Version v${result.release.version} verfügbar.`
                );
                setModalVisible(true);
              } else if (skippedVersion !== result.release.version) {
                setModalVisible(true);
              }
            }
            return;
          }

          if (result.status === 'up_to_date') {
            await Promise.all([
              setSyncStateValue(executor, KEY_ETAG, result.etag),
              !result.fromCache && result.release
                ? setSyncStateValue(
                    executor,
                    KEY_CACHED_RELEASE,
                    JSON.stringify(result.release)
                  )
                : Promise.resolve(),
            ]);

            if (mountedRef.current) {
              setAvailableRelease(null);
              if (source === 'manual') {
                setLastCheckError(null);
                setLastCheckMessage(
                  `Du nutzt bereits die neueste Version (v${currentVersion}).`
                );
              }
            }
            return;
          }

          if (result.status === 'no_release') {
            await Promise.all([
              setSyncStateValue(executor, KEY_ETAG, null),
              setSyncStateValue(executor, KEY_CACHED_RELEASE, null),
            ]);

            if (mountedRef.current) {
              setAvailableRelease(null);
              if (source === 'manual') {
                setLastCheckError(null);
                setLastCheckMessage(
                  'Aktuell ist noch kein öffentliches Release auf GitHub verfügbar.'
                );
              }
            }
            return;
          }

          if (source === 'manual' && mountedRef.current) {
            setLastCheckError(result.message);
          }
        } finally {
          inFlightRef.current = null;
          if (mountedRef.current) {
            setIsChecking(false);
          }
        }
      })();

      inFlightRef.current = task;
      return task;
    },
    [currentVersion]
  );

  useEffect(() => {
    if (!ready || !db || startupInitializedRef.current) {
      return;
    }
    startupInitializedRef.current = true;

    let active = true;
    void cleanupCachedUpdateApks();

    void (async () => {
      try {
        const [autoRaw, lastCheckedRaw] = await Promise.all([
          getSyncStateValue(db, KEY_AUTO_CHECK),
          getSyncStateValue(db, KEY_LAST_CHECKED_AT),
        ]);
        if (!active || !mountedRef.current) return;

        const enabled = autoRaw !== '0';
        setAutoCheckState(enabled);
        setLastCheckedAt(lastCheckedRaw);

        if (enabled) {
          await runCheck(db, 'auto');
        }
      } catch {
        // Automatischer Start-Check darf App-Start niemals beeinträchtigen
      }
    })();

    return () => {
      active = false;
    };
  }, [db, ready, runCheck]);

  const checkNow = useCallback(
    async (source: UpdateCheckSource = 'manual'): Promise<void> => {
      if (!db) return;
      await runCheck(db, source);
    },
    [db, runCheck]
  );

  const setAutoCheckEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      setAutoCheckState(enabled);
      if (db) {
        await setSyncStateValue(db, KEY_AUTO_CHECK, enabled ? '1' : '0');
      }
    },
    [db]
  );

  const skipAvailableRelease = useCallback(async (): Promise<void> => {
    const versionToSkip = availableRelease?.version ?? null;
    setModalVisible(false);
    if (db && versionToSkip) {
      await setSyncStateValue(db, KEY_SKIPPED_VERSION, versionToSkip);
    }
  }, [availableRelease, db]);

  const openUpdateModal = useCallback(() => {
    if (availableRelease) {
      setModalVisible(true);
    }
  }, [availableRelease]);

  const closeUpdateModal = useCallback(() => {
    setModalVisible(false);
  }, []);

  return (
    <UpdateContext.Provider
      value={{
        currentVersion,
        buildCode,
        autoCheckEnabled,
        isChecking,
        lastCheckedAt,
        availableRelease,
        lastCheckMessage,
        lastCheckError,
        modalVisible,
        checkNow,
        setAutoCheckEnabled,
        skipAvailableRelease,
        openUpdateModal,
        closeUpdateModal,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdateContext(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) {
    throw new Error(
      'useUpdateContext muss innerhalb von UpdateProvider verwendet werden.'
    );
  }
  return ctx;
}
