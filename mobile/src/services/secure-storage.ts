import * as SecureStore from 'expo-secure-store';

const KEY_ACCESS_TOKEN = 'bibliolisa.accessToken';
const KEY_REFRESH_TOKEN = 'bibliolisa.refreshToken';
const KEY_ACCESS_EXPIRES_AT = 'bibliolisa.accessTokenExpiresAt';

export interface StoredAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

/**
 * Speichert Authentifizierungs-Tokens ausschließlich in expo-secure-store (Android Keystore),
 * niemals in SQLite.
 */
export async function saveAuthTokens(tokens: StoredAuthTokens): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_ACCESS_TOKEN, tokens.accessToken),
    SecureStore.setItemAsync(KEY_REFRESH_TOKEN, tokens.refreshToken),
    SecureStore.setItemAsync(KEY_ACCESS_EXPIRES_AT, tokens.accessTokenExpiresAt),
  ]);
}

export async function getAuthTokens(): Promise<StoredAuthTokens | null> {
  const [accessToken, refreshToken, accessTokenExpiresAt] = await Promise.all([
    SecureStore.getItemAsync(KEY_ACCESS_TOKEN),
    SecureStore.getItemAsync(KEY_REFRESH_TOKEN),
    SecureStore.getItemAsync(KEY_ACCESS_EXPIRES_AT),
  ]);

  if (!accessToken || !refreshToken || !accessTokenExpiresAt) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
  };
}

export async function clearAuthTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_ACCESS_TOKEN),
    SecureStore.deleteItemAsync(KEY_REFRESH_TOKEN),
    SecureStore.deleteItemAsync(KEY_ACCESS_EXPIRES_AT),
  ]);
}

/**
 * Prüft, ob das Access Token abgelaufen ist oder innerhalb des Pufferfensters abläuft.
 */
export function isAccessTokenExpiringSoon(
  accessTokenExpiresAt: string,
  bufferSeconds = 60,
  nowMs = Date.now()
): boolean {
  const expiresMs = Date.parse(accessTokenExpiresAt);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return expiresMs - nowMs <= bufferSeconds * 1000;
}
