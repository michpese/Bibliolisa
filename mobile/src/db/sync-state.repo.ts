import type { AuthUser, UserRole } from '@bibliolisa/shared';
import type { SqlExecutor } from './types';

export interface AppSessionState {
  deviceId: string;
  userId: string;
  serverUrl: string | null;
  username: string | null;
  displayName: string | null;
  role: UserRole | null;
  isLocalOnlyUser: boolean;
  lastSyncCursor: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
}

export async function getSyncStateValue(
  db: SqlExecutor,
  key: string
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_state WHERE key = ?',
    key
  );
  return row ? row.value : null;
}

export async function setSyncStateValue(
  db: SqlExecutor,
  key: string,
  value: string | null
): Promise<void> {
  if (value === null) {
    await db.runAsync('DELETE FROM sync_state WHERE key = ?', key);
    return;
  }
  await db.runAsync(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

export async function getAppSessionState(db: SqlExecutor): Promise<AppSessionState> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM sync_state'
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  const rawRole = map.get('user_role');
  const role: UserRole | null =
    rawRole === 'admin' || rawRole === 'user' ? rawRole : null;

  return {
    deviceId: map.get('device_id') ?? '',
    userId: map.get('user_id') ?? '',
    serverUrl: map.get('server_url') || null,
    username: map.get('username') || null,
    displayName: map.get('display_name') || null,
    role,
    isLocalOnlyUser: (map.get('is_local_only_user') ?? '1') === '1',
    lastSyncCursor: map.get('last_sync_cursor') || null,
    lastSyncAt: map.get('last_sync_at') || null,
    lastSyncStatus: map.get('last_sync_status') ?? 'offline',
    lastSyncError: map.get('last_sync_error') || null,
  };
}

export async function countPendingChanges(
  db: SqlExecutor,
  userId: string
): Promise<number> {
  const ubRow = await db.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM user_books WHERE user_id = ? AND is_dirty = 1',
    userId
  );
  const bookRow = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM books b
     WHERE (b.is_dirty = 1 OR b.cover_pending_upload = 1)
       AND EXISTS (
         SELECT 1 FROM user_books ub WHERE ub.book_id = b.id AND ub.user_id = ?
       )`,
    userId
  );
  return (ubRow?.cnt ?? 0) + (bookRow?.cnt ?? 0);
}

/**
 * Überträgt vor dem ersten Login rein offline erfasste Bücher auf das angemeldete Serverkonto.
 */
export async function adoptLocalDataForUser(
  db: SqlExecutor,
  user: AuthUser
): Promise<void> {
  await db.withTransactionAsync(async () => {
    const previousUserRow = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'user_id'"
    );
    const previousUserId = previousUserRow?.value ?? null;

    if (previousUserId && previousUserId !== user.id) {
      await db.runAsync(
        'UPDATE user_books SET user_id = ? WHERE user_id = ?',
        user.id,
        previousUserId
      );
      await db.runAsync(
        'UPDATE books SET created_by_user_id = ? WHERE created_by_user_id = ? OR created_by_user_id IS NULL',
        user.id,
        previousUserId
      );
    }

    const updates: Array<[string, string | null]> = [
      ['user_id', user.id],
      ['username', user.username],
      ['display_name', user.displayName ?? null],
      ['user_role', user.role],
      ['is_local_only_user', '0'],
    ];

    for (const [key, value] of updates) {
      if (value === null) {
        await db.runAsync('DELETE FROM sync_state WHERE key = ?', key);
      } else {
        await db.runAsync(
          `INSERT INTO sync_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          value
        );
      }
    }
  });
}

export interface ResetLocalDataOptions {
  keepServerUrl?: boolean;
  newUser?: AuthUser | null;
}

/**
 * Leert lokale Bücher und Sync-Metadaten sauber bei Logout, Konto- oder Serverwechsel.
 */
export async function resetLocalLibraryData(
  db: SqlExecutor,
  options: ResetLocalDataOptions,
  generateUuid: () => string
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM user_books');
    await db.runAsync('DELETE FROM books');

    const keysToDelete = [
      'last_sync_cursor',
      'last_sync_at',
      'last_sync_error',
      'username',
      'display_name',
      'user_role',
    ];
    if (!options.keepServerUrl) {
      keysToDelete.push('server_url');
    }

    for (const key of keysToDelete) {
      await db.runAsync('DELETE FROM sync_state WHERE key = ?', key);
    }

    const nextUser = options.newUser ?? null;
    const entries: Array<[string, string]> = nextUser
      ? [
          ['user_id', nextUser.id],
          ['username', nextUser.username],
          ['user_role', nextUser.role],
          ['is_local_only_user', '0'],
          ['last_sync_status', 'offline'],
        ]
      : [
          ['user_id', generateUuid()],
          ['is_local_only_user', '1'],
          ['last_sync_status', 'offline'],
        ];

    if (nextUser?.displayName) {
      entries.push(['display_name', nextUser.displayName]);
    }

    for (const [key, value] of entries) {
      await db.runAsync(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value
      );
    }
  });
}
