import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SyncStatusBadge } from '../components/SyncStatusBadge';
import { useAppContext } from '../context/AppContext';
import {
  checkServerHealth,
  normalizeServerUrl,
  type HealthCheckResult,
} from '../sync/health-check';
import { useSyncContext } from '../sync/sync-context';
import { useAppTheme } from '../theme';
import { formatDateTime, formatRelativeSyncTime } from '../utils/format';

export function SettingsScreen() {
  const theme = useAppTheme();
  const {
    session,
    serverUrl,
    deviceId,
    isAuthenticated,
    pendingChangesCount,
    saveServerUrl,
    signIn,
    registerAccount,
    signOut,
  } = useAppContext();
  const { snapshot: syncSnapshot, syncNow } = useSyncContext();

  const [urlInput, setUrlInput] = useState(serverUrl ?? '');
  const [testing, setTesting] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [healthResult, setHealthResult] = useState<HealthCheckResult | null>(null);

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (serverUrl !== null) {
      setUrlInput(serverUrl);
    }
  }, [serverUrl]);

  useEffect(() => {
    if (
      !isAuthenticated &&
      session &&
      !session.isLocalOnlyUser &&
      session.username &&
      username === ''
    ) {
      setUsername(session.username);
    }
  }, [isAuthenticated, session, username]);

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const res = await checkServerHealth(urlInput, 1500);
      setHealthResult(res);
      if (res.ok) {
        setUrlInput(res.url);
      }
    } finally {
      setTesting(false);
    }
  };

  const performSaveUrl = async (normalizedUrl: string) => {
    setSavingUrl(true);
    try {
      await saveServerUrl(normalizedUrl);
      setUrlInput(normalizedUrl);
      Alert.alert('Gespeichert', `Server-URL wurde auf ${normalizedUrl} gesetzt.`);
    } catch (error) {
      Alert.alert(
        'Fehler',
        error instanceof Error ? error.message : 'Server-URL konnte nicht gespeichert werden.'
      );
    } finally {
      setSavingUrl(false);
    }
  };

  const handleSaveServerUrl = async () => {
    const normalized = normalizeServerUrl(urlInput);
    if (!normalized.ok) {
      Alert.alert('Ungültige Server-URL', normalized.message);
      return;
    }

    if (serverUrl && serverUrl !== normalized.url) {
      Alert.alert(
        'Server-Instanz wechseln?',
        'Beim Wechsel auf einen anderen Server werden gespeicherte Tokens, lokale Bücher und der Cover-Cache auf diesem Gerät sauber zurückgesetzt.',
        [
          { text: 'Abbrechen', style: 'cancel' },
          {
            text: 'Zurücksetzen & speichern',
            style: 'destructive',
            onPress: () => void performSaveUrl(normalized.url),
          },
        ]
      );
      return;
    }

    await performSaveUrl(normalized.url);
  };

  const handleAuthSubmit = async () => {
    setAuthError(null);
    const normalized = normalizeServerUrl(urlInput);
    if (!normalized.ok) {
      setAuthError(normalized.message);
      return;
    }
    if (!username.trim() || !password) {
      setAuthError('Bitte Benutzername und Passwort eingeben.');
      return;
    }

    setAuthBusy(true);
    try {
      if (authMode === 'login') {
        await signIn({
          serverUrl: normalized.url,
          username: username.trim(),
          password,
        });
      } else {
        await registerAccount({
          serverUrl: normalized.url,
          username: username.trim(),
          password,
          displayName: displayName.trim() || undefined,
        });
      }
      setPassword('');
      void syncNow('manual');
      Alert.alert(
        'Angemeldet',
        'Sitzung wurde sicher in expo-secure-store gespeichert und Synchronisierung gestartet.'
      );
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Anmeldung fehlgeschlagen.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = () => {
    const warning =
      pendingChangesCount > 0
        ? `Es gibt ${pendingChangesCount} noch nicht synchronisierte lokale Änderungen. Beim Abmelden werden lokale Bücher und Cover von diesem Gerät gelöscht.`
        : 'Gespeicherte Tokens, lokale Bücher und der Cover-Cache werden sauber von diesem Gerät entfernt.';

    Alert.alert('Abmelden?', warning, [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Abmelden & zurücksetzen',
        style: 'destructive',
        onPress: () => void signOut(),
      },
    ]);
  };

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.container, { backgroundColor: theme.background }]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.screenTitle, { color: theme.text }]}>
          Einstellungen
        </Text>
        <Text style={[styles.screenSubtitle, { color: theme.textMuted }]}>
          Server-URL, Verbindungstest (max. 1,5 s) und Gerätekonto.
        </Text>

        {/* Server-Konfiguration */}
        <View
          style={[
            styles.card,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            Bibliolisa-Server
          </Text>
          <Text style={[styles.helper, { color: theme.textMuted }]}>
            Beliebige http://- (LAN) oder https://-URL (Reverse Proxy). Keine URL ist fest im Code hinterlegt.
          </Text>

          <TextInput
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="https://books.home.lan oder http://192.168.x.x:3000"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[
              styles.input,
              {
                backgroundColor: theme.background,
                borderColor: theme.border,
                color: theme.text,
              },
            ]}
          />

          <View style={styles.btnRow}>
            <Pressable
              onPress={() => void handleTestConnection()}
              disabled={testing}
              style={[
                styles.secondaryBtn,
                { backgroundColor: theme.accent, opacity: testing ? 0.7 : 1 },
              ]}
            >
              {testing ? (
                <ActivityIndicator size="small" color={theme.accentText} />
              ) : (
                <Ionicons name="pulse-outline" size={18} color={theme.accentText} />
              )}
              <Text style={[styles.secondaryBtnText, { color: theme.accentText }]}>
                Verbindung testen
              </Text>
            </Pressable>

            <Pressable
              onPress={() => void handleSaveServerUrl()}
              disabled={savingUrl}
              style={[
                styles.primaryBtn,
                { backgroundColor: theme.primary, opacity: savingUrl ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: theme.primaryText }]}>
                Speichern
              </Text>
            </Pressable>
          </View>

          {healthResult && (
            <View
              style={[
                styles.diagBox,
                {
                  backgroundColor: healthResult.ok
                    ? theme.successSoft
                    : theme.dangerSoft,
                },
              ]}
            >
              {healthResult.ok ? (
                <>
                  <Text style={[styles.diagTitle, { color: theme.success }]}>
                    Erreichbar · {healthResult.latencyMs} ms
                  </Text>
                  <Text style={[styles.diagText, { color: theme.text }]}>
                    Version: {healthResult.health.version} · Registrierung:{' '}
                    {healthResult.health.allowRegistration
                      ? 'offen'
                      : 'deaktiviert'}
                  </Text>
                  <Text style={[styles.diagText, { color: theme.textMuted }]}>
                    Provider: Open Library, Google Books
                    {healthResult.health.providers.hardcover
                      ? ', Hardcover'
                      : ''}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={[styles.diagTitle, { color: theme.danger }]}>
                    Diagnose ({healthResult.kind})
                  </Text>
                  <Text style={[styles.diagText, { color: theme.danger }]}>
                    {healthResult.message}
                  </Text>
                </>
              )}
            </View>
          )}
        </View>

        {/* Anmeldung / Konto */}
        <View
          style={[
            styles.card,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            Benutzerkonto (SecureStore)
          </Text>

          {isAuthenticated && session ? (
            <View style={styles.accountSummary}>
              <Text style={[styles.accountLine, { color: theme.text }]}>
                Angemeldet als{' '}
                <Text style={{ fontWeight: '800' }}>{session.username}</Text>
                {session.displayName ? ` (${session.displayName})` : ''}
              </Text>
              <Text style={[styles.helper, { color: theme.textMuted }]}>
                Rolle: {session.role ?? 'user'} · Tokens liegen verschlüsselt in expo-secure-store und überstehen App-Neustarts.
              </Text>
              <Pressable
                onPress={handleSignOut}
                style={[styles.logoutBtn, { backgroundColor: theme.dangerSoft }]}
              >
                <Ionicons name="log-out-outline" size={18} color={theme.danger} />
                <Text style={[styles.logoutBtnText, { color: theme.danger }]}>
                  Abmelden & Daten zurücksetzen
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.authForm}>
              {session && !session.isLocalOnlyUser ? (
                <View
                  style={[
                    styles.diagBox,
                    { backgroundColor: theme.warningSoft },
                  ]}
                >
                  <Text style={[styles.diagTitle, { color: theme.warning }]}>
                    Anmeldung abgelaufen
                  </Text>
                  <Text style={[styles.diagText, { color: theme.text }]}>
                    Bitte melde dich erneut für {session.username ?? 'dein Konto'} an. Alle lokal gespeicherten Bücher und ungesyncten Änderungen bleiben vollständig erhalten.
                  </Text>
                </View>
              ) : (
                <Text style={[styles.helper, { color: theme.textMuted }]}>
                  Aktuell arbeitest du im reinen Offline-Modus. Lokal erfasste Bücher werden beim ersten Login automatisch in dein Konto übernommen.
                </Text>
              )}

              <View style={styles.modeSwitch}>
                <Pressable
                  onPress={() => setAuthMode('login')}
                  style={[
                    styles.modeTab,
                    {
                      backgroundColor:
                        authMode === 'login' ? theme.primary : theme.muted,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color:
                        authMode === 'login' ? theme.primaryText : theme.text,
                      fontWeight: '700',
                      fontSize: 13,
                    }}
                  >
                    Anmelden
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setAuthMode('register')}
                  style={[
                    styles.modeTab,
                    {
                      backgroundColor:
                        authMode === 'register' ? theme.primary : theme.muted,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color:
                        authMode === 'register'
                          ? theme.primaryText
                          : theme.text,
                      fontWeight: '700',
                      fontSize: 13,
                    }}
                  >
                    Registrieren
                  </Text>
                </Pressable>
              </View>

              <TextInput
                value={username}
                onChangeText={setUsername}
                placeholder="Benutzername"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                  },
                ]}
              />

              {authMode === 'register' && (
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Anzeigename (optional)"
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.background,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                />
              )}

              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Passwort"
                placeholderTextColor={theme.textMuted}
                secureTextEntry
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                  },
                ]}
              />

              {authError && (
                <View
                  style={[
                    styles.diagBox,
                    { backgroundColor: theme.dangerSoft },
                  ]}
                >
                  <Text style={[styles.diagText, { color: theme.danger }]}>
                    {authError}
                  </Text>
                </View>
              )}

              <Pressable
                onPress={() => void handleAuthSubmit()}
                disabled={authBusy}
                style={[
                  styles.primaryBtn,
                  {
                    backgroundColor: theme.primary,
                    opacity: authBusy ? 0.7 : 1,
                    paddingVertical: 13,
                  },
                ]}
              >
                <Text
                  style={[styles.primaryBtnText, { color: theme.primaryText }]}
                >
                  {authBusy
                    ? 'Verbinde…'
                    : authMode === 'login'
                      ? 'Anmelden'
                      : 'Konto erstellen'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Synchronisation & Gerätestatus */}
        <View
          style={[
            styles.card,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              Synchronisation & Gerätestatus
            </Text>
            <SyncStatusBadge compact />
          </View>
          <InfoLine
            label="Modus"
            value={isAuthenticated ? 'Serverkonto verknüpft' : 'Offline-Lokal'}
            theme={theme}
          />
          <InfoLine
            label="Ausstehende Änderungen"
            value={String(syncSnapshot.pendingCount)}
            theme={theme}
          />
          <InfoLine
            label="Letzter Sync"
            value={
              syncSnapshot.lastSyncAt
                ? `${formatRelativeSyncTime(syncSnapshot.lastSyncAt)} (${formatDateTime(syncSnapshot.lastSyncAt)})`
                : formatDateTime(session?.lastSyncAt)
            }
            theme={theme}
          />
          {syncSnapshot.lastSummary && (
            <InfoLine
              label="Letzter Durchlauf"
              value={`↑ ${syncSnapshot.lastSummary.pushedBooks + syncSnapshot.lastSummary.pushedUserBooks} · ↓ ${syncSnapshot.lastSummary.pulledBooks + syncSnapshot.lastSummary.pulledUserBooks} · Cover ${syncSnapshot.lastSummary.coversUploaded}/${syncSnapshot.lastSummary.coversDownloaded}`}
              theme={theme}
            />
          )}
          <InfoLine label="Geräte-ID" value={deviceId || '–'} theme={theme} />

          {syncSnapshot.lastSyncError && (
            <View
              style={[
                styles.diagBox,
                { backgroundColor: theme.dangerSoft },
              ]}
            >
              <Text style={[styles.diagText, { color: theme.danger }]}>
                {syncSnapshot.lastSyncError}
              </Text>
            </View>
          )}

          {isAuthenticated && (
            <Pressable
              onPress={() => void syncNow('manual')}
              disabled={syncSnapshot.isSyncing}
              style={[
                styles.primaryBtn,
                {
                  backgroundColor: theme.primary,
                  opacity: syncSnapshot.isSyncing ? 0.7 : 1,
                  paddingVertical: 12,
                  flexDirection: 'row',
                  gap: 8,
                },
              ]}
            >
              {syncSnapshot.isSyncing ? (
                <ActivityIndicator size="small" color={theme.primaryText} />
              ) : (
                <Ionicons name="sync" size={17} color={theme.primaryText} />
              )}
              <Text style={[styles.primaryBtnText, { color: theme.primaryText }]}>
                {syncSnapshot.isSyncing
                  ? 'Synchronisiere…'
                  : 'Jetzt synchronisieren'}
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoLine({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ReturnType<typeof useAppTheme>;
}) {
  return (
    <View style={styles.infoLine}>
      <Text style={{ color: theme.textMuted, fontSize: 13 }}>{label}</Text>
      <Text
        style={{
          color: theme.text,
          fontSize: 12,
          fontWeight: '600',
          flexShrink: 1,
          textAlign: 'right',
        }}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 14,
    paddingBottom: 36,
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '800',
  },
  screenSubtitle: {
    fontSize: 13,
    marginTop: -8,
  },
  card: {
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  helper: {
    fontSize: 12,
    lineHeight: 17,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  primaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  diagBox: {
    padding: 10,
    borderRadius: 10,
    gap: 3,
  },
  diagTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  diagText: {
    fontSize: 12,
    lineHeight: 17,
  },
  accountSummary: {
    gap: 8,
  },
  accountLine: {
    fontSize: 15,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 4,
  },
  logoutBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  authForm: {
    gap: 10,
  },
  modeSwitch: {
    flexDirection: 'row',
    gap: 8,
  },
  modeTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: 10,
  },
  infoLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
});
