import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext } from '../context/AppContext';
import { useSyncContext } from '../sync/sync-context';
import type { SyncStatus } from '../sync/sync-engine';
import { useAppTheme, type AppTheme } from '../theme';
import { formatDateTime, formatRelativeSyncTime } from '../utils/format';
import { useBottomSafePadding } from '../utils/safe-area';

interface SyncStatusBadgeProps {
  compact?: boolean;
  onOpenSettings?: () => void;
}

interface StatusPresentation {
  badgeLabel: string;
  title: string;
  subtitle: string;
  fg: string;
  bg: string;
  icon: keyof typeof Ionicons.glyphMap;
}

function getStatusPresentation(
  status: SyncStatus,
  theme: AppTheme,
  params: {
    pendingCount: number;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    nowMs: number;
  }
): StatusPresentation {
  const rel = formatRelativeSyncTime(params.lastSyncAt, params.nowMs);
  const pendingWord =
    params.pendingCount === 1
      ? '1 lokale Änderung wartet'
      : `${params.pendingCount} lokale Änderungen warten`;

  switch (status) {
    case 'synced':
      return {
        badgeLabel: 'Synchron',
        title: 'Synchronisiert',
        subtitle: `Synchronisiert · ${rel} · 0 ausstehend`,
        fg: theme.success,
        bg: theme.successSoft,
        icon: 'checkmark-circle',
      };
    case 'syncing':
      return {
        badgeLabel: 'Synct…',
        title: 'Synchronisierung läuft',
        subtitle: 'Synchronisiere mit Server…',
        fg: theme.primary,
        bg: theme.accent,
        icon: 'sync',
      };
    case 'pending':
      return {
        badgeLabel: `${params.pendingCount} offen`,
        title: 'Änderungen vorgemerkt',
        subtitle: `${pendingWord} auf Sync`,
        fg: theme.warning,
        bg: theme.warningSoft,
        icon: 'cloud-upload-outline',
      };
    case 'offline':
      return {
        badgeLabel: params.pendingCount > 0 ? `Offline (${params.pendingCount})` : 'Offline',
        title: 'Offline-Modus',
        subtitle:
          params.pendingCount > 0
            ? `Offline – ${pendingWord} lokal gespeichert`
            : 'Offline – Änderungen lokal gespeichert',
        fg: theme.textMuted,
        bg: theme.muted,
        icon: 'cloud-offline-outline',
      };
    case 'auth_required':
      return {
        badgeLabel: 'Anmelden',
        title: 'Anmeldung abgelaufen',
        subtitle: 'Anmeldung abgelaufen – Bitte neu anmelden',
        fg: theme.isDark ? '#fb923c' : '#ea580c',
        bg: theme.warningSoft,
        icon: 'lock-closed-outline',
      };
    case 'error':
      return {
        badgeLabel: 'Sync-Fehler',
        title: 'Sync-Fehler',
        subtitle: `Sync-Fehler: ${params.lastSyncError ?? 'Unbekannter Fehler'}`,
        fg: theme.danger,
        bg: theme.dangerSoft,
        icon: 'warning-outline',
      };
  }
}

export function SyncStatusBadge({
  compact = false,
  onOpenSettings,
}: SyncStatusBadgeProps) {
  const theme = useAppTheme();
  const sheetBottomPadding = useBottomSafePadding(12);
  const { session, serverUrl, signIn } = useAppContext();
  const { snapshot, syncNow } = useSyncContext();

  const [modalVisible, setModalVisible] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [reloginPassword, setReloginPassword] = useState('');
  const [reloginBusy, setReloginBusy] = useState(false);
  const [reloginError, setReloginError] = useState<string | null>(null);

  useEffect(() => {
    if (!modalVisible) return;
    setNowMs(Date.now());
    setReloginError(null);
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => clearInterval(interval);
  }, [modalVisible]);

  const presentation = getStatusPresentation(snapshot.status, theme, {
    pendingCount: snapshot.pendingCount,
    lastSyncAt: snapshot.lastSyncAt,
    lastSyncError: snapshot.lastSyncError,
    nowMs,
  });

  const handleRelogin = async () => {
    if (!serverUrl || !session?.username || !reloginPassword) {
      setReloginError('Bitte Passwort eingeben.');
      return;
    }
    setReloginBusy(true);
    setReloginError(null);
    try {
      await signIn({
        serverUrl,
        username: session.username,
        password: reloginPassword,
      });
      setReloginPassword('');
      await syncNow('manual');
    } catch (error) {
      setReloginError(
        error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.'
      );
    } finally {
      setReloginBusy(false);
    }
  };

  const canTriggerSync =
    snapshot.isConfigured &&
    snapshot.isAuthenticated &&
    !snapshot.isSyncing;

  const primaryActionLabel =
    snapshot.status === 'offline'
      ? 'Erneut prüfen'
      : snapshot.status === 'error'
        ? 'Erneut versuchen'
        : 'Jetzt synchronisieren';

  return (
    <>
      <Pressable
        onPress={() => {
          setNowMs(Date.now());
          setModalVisible(true);
        }}
        style={({ pressed }) => [
          styles.pill,
          compact && styles.pillCompact,
          {
            backgroundColor: presentation.bg,
            borderColor: theme.border,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Sync-Status: ${presentation.subtitle}`}
      >
        {snapshot.isSyncing ? (
          <ActivityIndicator size="small" color={presentation.fg} />
        ) : (
          <Ionicons name={presentation.icon} size={15} color={presentation.fg} />
        )}
        <Text
          numberOfLines={1}
          style={[styles.pillText, { color: presentation.fg }]}
        >
          {presentation.badgeLabel}
        </Text>
      </Pressable>

      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            style={styles.backdropInner}
            onPress={() => setModalVisible(false)}
          >
            <Pressable
              style={[
                styles.sheet,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                  paddingBottom: sheetBottomPadding,
                },
              ]}
              onPress={() => undefined}
            >
              <View style={styles.sheetHeader}>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>
                  Synchronisations-Status
                </Text>
                <Pressable onPress={() => setModalVisible(false)} hitSlop={8}>
                  <Ionicons name="close" size={22} color={theme.text} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.sheetBody}
                keyboardShouldPersistTaps="handled"
              >
              {/* Status-Box */}
              <View
                style={[styles.statusCard, { backgroundColor: presentation.bg }]}
              >
                <View style={styles.statusIconWrap}>
                  {snapshot.isSyncing ? (
                    <ActivityIndicator size="small" color={presentation.fg} />
                  ) : (
                    <Ionicons
                      name={presentation.icon}
                      size={24}
                      color={presentation.fg}
                    />
                  )}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.statusTitle, { color: presentation.fg }]}>
                    {presentation.title}
                  </Text>
                  <Text style={[styles.statusSub, { color: theme.text }]}>
                    {presentation.subtitle}
                  </Text>
                </View>
              </View>

              {/* Details */}
              <View
                style={[
                  styles.metaBox,
                  { backgroundColor: theme.background, borderColor: theme.border },
                ]}
              >
                <MetaRow
                  label="Server"
                  value={serverUrl ?? 'Nicht konfiguriert'}
                  theme={theme}
                />
                <MetaRow
                  label="Letzter erfolgreicher Sync"
                  value={
                    snapshot.lastSyncAt
                      ? `${formatRelativeSyncTime(snapshot.lastSyncAt, nowMs)} (${formatDateTime(snapshot.lastSyncAt)})`
                      : 'Noch nie'
                  }
                  theme={theme}
                />
                <MetaRow
                  label="Ausstehende Änderungen"
                  value={String(snapshot.pendingCount)}
                  theme={theme}
                />
                {snapshot.lastSummary && (
                  <MetaRow
                    label="Letzter Lauf"
                    value={`↑ ${snapshot.lastSummary.pushedBooks + snapshot.lastSummary.pushedUserBooks} · ↓ ${snapshot.lastSummary.pulledBooks + snapshot.lastSummary.pulledUserBooks} · Cover ${snapshot.lastSummary.coversUploaded}/${snapshot.lastSummary.coversDownloaded}`}
                    theme={theme}
                  />
                )}
              </View>

              {snapshot.clockSkewWarning && (
                <View
                  style={[
                    styles.noticeBox,
                    { backgroundColor: theme.warningSoft },
                  ]}
                >
                  <Text style={[styles.noticeText, { color: theme.warning }]}>
                    Hinweis: Die Geräteuhr weicht deutlich vom Server ab. Zeitstempel wurden zum LWW-Schutz serverseitig gekappt.
                  </Text>
                </View>
              )}

              {/* Inline Re-Login bei abgelaufener Anmeldung */}
              {snapshot.status === 'auth_required' && serverUrl && session?.username && (
                <View
                  style={[
                    styles.reloginCard,
                    { backgroundColor: theme.background, borderColor: theme.border },
                  ]}
                >
                  <Text style={[styles.reloginInfo, { color: theme.textMuted }]}>
                    Alle lokal gespeicherten Bücher und ausstehenden Änderungen bleiben beim erneuten Anmelden vollständig erhalten.
                  </Text>
                  <Text style={[styles.reloginUser, { color: theme.text }]}>
                    Konto: {session.username}
                  </Text>
                  <TextInput
                    value={reloginPassword}
                    onChangeText={setReloginPassword}
                    placeholder="Passwort eingeben"
                    placeholderTextColor={theme.textMuted}
                    secureTextEntry
                    style={[
                      styles.reloginInput,
                      {
                        backgroundColor: theme.card,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                  />
                  {reloginError && (
                    <Text style={{ color: theme.danger, fontSize: 12 }}>
                      {reloginError}
                    </Text>
                  )}
                  <Pressable
                    onPress={() => void handleRelogin()}
                    disabled={reloginBusy}
                    style={[
                      styles.actionPrimary,
                      {
                        backgroundColor: theme.primary,
                        opacity: reloginBusy ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.actionPrimaryText,
                        { color: theme.primaryText },
                      ]}
                    >
                      {reloginBusy
                        ? 'Melde an…'
                        : 'Erneut anmelden & synchronisieren'}
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* Aktionen */}
              {canTriggerSync && (
                <Pressable
                  onPress={() => void syncNow('manual')}
                  style={[
                    styles.actionPrimary,
                    { backgroundColor: theme.primary },
                  ]}
                >
                  <Ionicons name="sync" size={18} color={theme.primaryText} />
                  <Text
                    style={[
                      styles.actionPrimaryText,
                      { color: theme.primaryText },
                    ]}
                  >
                    {primaryActionLabel}
                  </Text>
                </Pressable>
              )}

              {onOpenSettings && (
                <Pressable
                  onPress={() => {
                    setModalVisible(false);
                    onOpenSettings();
                  }}
                  style={[
                    styles.actionSecondary,
                    { borderColor: theme.border, backgroundColor: theme.background },
                  ]}
                >
                  <Ionicons
                    name="settings-outline"
                    size={17}
                    color={theme.text}
                  />
                  <Text style={[styles.actionSecondaryText, { color: theme.text }]}>
                    Server & Konto in Einstellungen öffnen
                  </Text>
                </Pressable>
              )}
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function MetaRow({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: AppTheme;
}) {
  return (
    <View style={styles.metaRow}>
      <Text style={{ color: theme.textMuted, fontSize: 12 }}>{label}</Text>
      <Text
        numberOfLines={2}
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
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillCompact: {
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pillText: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '700',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  backdropInner: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    maxHeight: '85%',
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  sheetBody: {
    paddingHorizontal: 18,
    gap: 12,
    paddingBottom: 8,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
  },
  statusIconWrap: {
    width: 28,
    alignItems: 'center',
  },
  statusTitle: {
    fontSize: 15,
    fontWeight: '800',
  },
  statusSub: {
    fontSize: 13,
    lineHeight: 18,
  },
  metaBox: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  noticeBox: {
    padding: 10,
    borderRadius: 10,
  },
  noticeText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  reloginCard: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  reloginInfo: {
    fontSize: 12,
    lineHeight: 17,
  },
  reloginUser: {
    fontSize: 13,
    fontWeight: '700',
  },
  reloginInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  actionPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  actionPrimaryText: {
    fontSize: 14,
    fontWeight: '700',
  },
  actionSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
  },
  actionSecondaryText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
