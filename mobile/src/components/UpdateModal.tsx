import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext } from '../context/AppContext';
import { useUpdateContext } from '../context/UpdateContext';
import {
  downloadReleaseApk,
  launchAndroidApkInstaller,
  openReleaseInBrowser,
  openUnknownSourcesSettings,
  UpdateDownloadCancelledError,
  type ApkDownloadProgress,
} from '../services/app-updater';
import {
  formatFileSize,
  formatReleaseNotesForDisplay,
} from '../services/app-updater-utils';
import { useAppTheme } from '../theme';
import { formatDate } from '../utils/format';
import { useBottomSafePadding } from '../utils/safe-area';

type UpdatePhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'ready_to_install'
  | 'error';

export function UpdateModal() {
  const theme = useAppTheme();
  const footerBottomPadding = useBottomSafePadding(12);
  const { pendingChangesCount } = useAppContext();
  const {
    currentVersion,
    availableRelease,
    modalVisible,
    closeUpdateModal,
    skipAvailableRelease,
  } = useUpdateContext();

  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [progress, setProgress] = useState<ApkDownloadProgress | null>(null);
  const [localApkUri, setLocalApkUri] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [launchingInstaller, setLaunchingInstaller] = useState(false);

  const cancelDownloadRef = useRef<(() => Promise<void>) | null>(null);
  const activeRunIdRef = useRef(0);

  const releaseVersionKey = availableRelease?.version ?? null;
  useEffect(() => {
    if (cancelDownloadRef.current) {
      void cancelDownloadRef.current().catch(() => undefined);
      cancelDownloadRef.current = null;
    }
    activeRunIdRef.current += 1;
    setPhase('idle');
    setProgress(null);
    setLocalApkUri(null);
    setErrorMsg(null);
    setLaunchingInstaller(false);
  }, [releaseVersionKey]);

  useEffect(() => {
    if (!modalVisible) {
      if (cancelDownloadRef.current) {
        void cancelDownloadRef.current().catch(() => undefined);
        cancelDownloadRef.current = null;
      }
      activeRunIdRef.current += 1;
      setPhase('idle');
      setProgress(null);
      setLocalApkUri(null);
      setErrorMsg(null);
      setLaunchingInstaller(false);
    }
  }, [modalVisible]);

  const noteBlocks = useMemo(
    () =>
      availableRelease
        ? formatReleaseNotesForDisplay(availableRelease.body)
        : [],
    [availableRelease]
  );

  if (!availableRelease) {
    return null;
  }

  const isBusy = phase === 'downloading' || phase === 'verifying';
  const canInstallApk =
    Platform.OS === 'android' && availableRelease.apkAsset !== null;
  const apkSizeLabel =
    availableRelease.apkAsset && availableRelease.apkAsset.size > 0
      ? formatFileSize(availableRelease.apkAsset.size)
      : null;

  const handleClose = () => {
    if (isBusy) return;
    closeUpdateModal();
  };

  const triggerInstaller = async (uri: string, runId: number) => {
    setLaunchingInstaller(true);
    try {
      await launchAndroidApkInstaller(uri);
    } catch (error) {
      if (activeRunIdRef.current !== runId) return;
      setErrorMsg(
        error instanceof Error
          ? error.message
          : 'Der Android-Paketinstaller konnte nicht geöffnet werden.'
      );
    } finally {
      if (activeRunIdRef.current === runId) {
        setLaunchingInstaller(false);
      }
    }
  };

  const handleStartDownload = async () => {
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;

    setErrorMsg(null);
    setPhase('downloading');
    setProgress({
      bytesWritten: 0,
      bytesTotal: availableRelease.apkAsset?.size ?? 0,
      ratio: 0,
    });

    try {
      const downloaded = await downloadReleaseApk({
        release: availableRelease,
        onProgress: (nextProgress) => {
          if (activeRunIdRef.current === runId) {
            setProgress(nextProgress);
          }
        },
        onVerifying: () => {
          if (activeRunIdRef.current === runId) {
            setPhase('verifying');
          }
        },
        onHandleReady: (cancel) => {
          if (activeRunIdRef.current === runId) {
            cancelDownloadRef.current = cancel;
          }
        },
      });

      cancelDownloadRef.current = null;
      if (activeRunIdRef.current !== runId) return;

      setLocalApkUri(downloaded.localUri);
      setPhase('ready_to_install');
      await triggerInstaller(downloaded.localUri, runId);
    } catch (error) {
      cancelDownloadRef.current = null;
      if (activeRunIdRef.current !== runId) return;

      if (error instanceof UpdateDownloadCancelledError) {
        setPhase('idle');
        setProgress(null);
        setErrorMsg(null);
        return;
      }

      setPhase('error');
      setErrorMsg(
        error instanceof Error
          ? error.message
          : 'Das Update konnte nicht heruntergeladen werden.'
      );
    }
  };

  const handleCancelDownload = async () => {
    const cancel = cancelDownloadRef.current;
    cancelDownloadRef.current = null;
    activeRunIdRef.current += 1;
    if (cancel) {
      await cancel().catch(() => undefined);
    }
    setPhase('idle');
    setProgress(null);
    setErrorMsg(null);
  };

  const percent = progress ? Math.round(progress.ratio * 100) : 0;

  return (
    <Modal
      visible={modalVisible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={styles.backdropDismiss}
          onPress={handleClose}
          disabled={isBusy}
        />

        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View
                style={[styles.iconBadge, { backgroundColor: theme.accent }]}
              >
                <Ionicons
                  name="arrow-down-circle"
                  size={24}
                  color={theme.primary}
                />
              </View>
              <View style={styles.headerTextWrap}>
                <Text style={[styles.title, { color: theme.text }]}>
                  Update verfügbar
                </Text>
                <View style={styles.versionRow}>
                  <View
                    style={[
                      styles.versionPill,
                      { backgroundColor: theme.accent },
                    ]}
                  >
                    <Text
                      style={[styles.versionPillText, { color: theme.accentText }]}
                    >
                      v{currentVersion} → v{availableRelease.version}
                    </Text>
                  </View>
                  <Text style={[styles.metaText, { color: theme.textMuted }]}>
                    {formatDate(availableRelease.publishedAt)}
                    {apkSizeLabel ? ` · ${apkSizeLabel}` : ''}
                  </Text>
                </View>
              </View>
            </View>

            <Pressable
              onPress={handleClose}
              disabled={isBusy}
              hitSlop={8}
              style={{ opacity: isBusy ? 0.35 : 1 }}
              accessibilityLabel="Dialog schließen"
            >
              <Ionicons name="close" size={22} color={theme.text} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
          >
            {/* Garantierte Benutzerdaten-Sicherheit */}
            <View
              style={[
                styles.safetyCard,
                {
                  backgroundColor: theme.successSoft,
                  borderColor: theme.success,
                },
              ]}
            >
              <View style={styles.safetyHeader}>
                <Ionicons
                  name="shield-checkmark"
                  size={20}
                  color={theme.success}
                />
                <Text style={[styles.safetyTitle, { color: theme.success }]}>
                  Deine Benutzerdaten bleiben erhalten
                </Text>
              </View>
              <Text style={[styles.safetyBody, { color: theme.text }]}>
                Beim Update werden alle gespeicherten Bücher, Bewertungen,
                Notizen, Cover, Server-Einstellungen und deine Anmeldung
                vollständig beibehalten – es werden keine Benutzerdaten
                überschrieben.
              </Text>
              {pendingChangesCount > 0 && (
                <Text style={[styles.safetyPending, { color: theme.success }]}>
                  Auch{' '}
                  {pendingChangesCount === 1
                    ? 'deine 1 noch nicht synchronisierte lokale Änderung bleibt'
                    : `deine ${pendingChangesCount} noch nicht synchronisierten lokalen Änderungen bleiben`}{' '}
                  sicher auf dem Gerät erhalten.
                </Text>
              )}
            </View>

            {/* Changelog / Highlights */}
            <View
              style={[
                styles.notesCard,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={[styles.notesSectionHeader, { color: theme.text }]}>
                Was ist neu
              </Text>

              {noteBlocks.length === 0 ? (
                <Text style={[styles.paragraphText, { color: theme.textMuted }]}>
                  Release {availableRelease.tagName} ist auf GitHub verfügbar.
                </Text>
              ) : (
                noteBlocks.map((block, index) => {
                  if (block.type === 'heading') {
                    return (
                      <Text
                        key={`h-${index}`}
                        style={[
                          styles.noteHeading,
                          { color: theme.text },
                          index === 0 && { marginTop: 2 },
                        ]}
                      >
                        {block.text}
                      </Text>
                    );
                  }
                  if (block.type === 'bullet') {
                    return (
                      <View key={`b-${index}`} style={styles.bulletRow}>
                        <Text
                          style={[styles.bulletDot, { color: theme.primary }]}
                        >
                          •
                        </Text>
                        <Text
                          style={[styles.bulletText, { color: theme.text }]}
                        >
                          {block.boldPrefix ? (
                            <Text style={{ fontWeight: '700' }}>
                              {block.boldPrefix}{' '}
                            </Text>
                          ) : null}
                          {block.text}
                        </Text>
                      </View>
                    );
                  }
                  return (
                    <Text
                      key={`p-${index}`}
                      style={[styles.paragraphText, { color: theme.textMuted }]}
                    >
                      {block.text}
                    </Text>
                  );
                })
              )}
            </View>
          </ScrollView>

          {/* Aktionsbereich */}
          <View
            style={[
              styles.footer,
              {
                borderTopColor: theme.border,
                paddingBottom: footerBottomPadding,
              },
            ]}
          >
            {phase === 'idle' && (
              <>
                {canInstallApk ? (
                  <Pressable
                    onPress={() => void handleStartDownload()}
                    style={[
                      styles.primaryBtn,
                      { backgroundColor: theme.primary },
                    ]}
                  >
                    <Ionicons
                      name="download-outline"
                      size={18}
                      color={theme.primaryText}
                    />
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: theme.primaryText },
                      ]}
                    >
                      Herunterladen & installieren
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() =>
                      void openReleaseInBrowser(availableRelease.htmlUrl)
                    }
                    style={[
                      styles.primaryBtn,
                      { backgroundColor: theme.primary },
                    ]}
                  >
                    <Ionicons
                      name="open-outline"
                      size={18}
                      color={theme.primaryText}
                    />
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: theme.primaryText },
                      ]}
                    >
                      Auf GitHub öffnen
                    </Text>
                  </Pressable>
                )}

                <View style={styles.secondaryRow}>
                  <Pressable
                    onPress={closeUpdateModal}
                    style={[
                      styles.secondaryBtn,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.secondaryBtnText, { color: theme.text }]}
                    >
                      Später
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void skipAvailableRelease()}
                    style={[
                      styles.secondaryBtn,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.secondaryBtnText,
                        { color: theme.textMuted },
                      ]}
                    >
                      Überspringen
                    </Text>
                  </Pressable>
                </View>

                <Pressable
                  onPress={() =>
                    void openReleaseInBrowser(availableRelease.htmlUrl)
                  }
                  style={styles.linkBtn}
                >
                  <Text style={[styles.linkBtnText, { color: theme.primary }]}>
                    Release-Seite im Browser öffnen
                  </Text>
                </Pressable>
              </>
            )}

            {phase === 'downloading' && (
              <View style={styles.progressSection}>
                <View style={styles.progressHeader}>
                  <Text style={[styles.progressLabel, { color: theme.text }]}>
                    Lade APK herunter…
                  </Text>
                  <Text
                    style={[styles.progressPercent, { color: theme.primary }]}
                  >
                    {progress && progress.bytesTotal > 0 ? `${percent}%` : ''}
                  </Text>
                </View>

                <View
                  style={[styles.progressTrack, { backgroundColor: theme.muted }]}
                >
                  <View
                    style={[
                      styles.progressFill,
                      {
                        backgroundColor: theme.primary,
                        width: `${progress ? Math.max(4, Math.min(100, percent)) : 4}%`,
                      },
                    ]}
                  />
                </View>

                {progress && (
                  <Text
                    style={[styles.progressMeta, { color: theme.textMuted }]}
                  >
                    {formatFileSize(progress.bytesWritten)}
                    {progress.bytesTotal > 0
                      ? ` von ${formatFileSize(progress.bytesTotal)}`
                      : ''}
                  </Text>
                )}

                <Pressable
                  onPress={() => void handleCancelDownload()}
                  style={[
                    styles.secondaryBtn,
                    {
                      backgroundColor: theme.dangerSoft,
                      borderColor: theme.dangerSoft,
                    },
                  ]}
                >
                  <Text
                    style={[styles.secondaryBtnText, { color: theme.danger }]}
                  >
                    Download abbrechen
                  </Text>
                </Pressable>
              </View>
            )}

            {phase === 'verifying' && (
              <View style={styles.verifyingBox}>
                <ActivityIndicator size="small" color={theme.primary} />
                <Text style={[styles.verifyingText, { color: theme.text }]}>
                  Prüfe heruntergeladene APK…
                </Text>
              </View>
            )}

            {phase === 'ready_to_install' && (
              <View style={styles.readySection}>
                <View
                  style={[
                    styles.guidanceBox,
                    {
                      backgroundColor: theme.accent,
                      borderColor: theme.border,
                    },
                  ]}
                >
                  <Text style={[styles.guidanceText, { color: theme.text }]}>
                    Der Android-Installer wurde geöffnet. Bestätige dort
                    „Aktualisieren“ – alle vorhandenen Daten bleiben erhalten.
                    Falls Android die Installation blockiert, erlaube einmalig
                    „Unbekannte Apps installieren“ für Bibliolisa.
                  </Text>
                </View>

                {errorMsg && (
                  <View
                    style={[
                      styles.errorBox,
                      { backgroundColor: theme.dangerSoft },
                    ]}
                  >
                    <Text style={[styles.errorText, { color: theme.danger }]}>
                      {errorMsg}
                    </Text>
                  </View>
                )}

                {localApkUri && (
                  <Pressable
                    onPress={() =>
                      void triggerInstaller(localApkUri, activeRunIdRef.current)
                    }
                    disabled={launchingInstaller}
                    style={[
                      styles.primaryBtn,
                      {
                        backgroundColor: theme.primary,
                        opacity: launchingInstaller ? 0.7 : 1,
                      },
                    ]}
                  >
                    {launchingInstaller ? (
                      <ActivityIndicator
                        size="small"
                        color={theme.primaryText}
                      />
                    ) : (
                      <Ionicons
                        name="build-outline"
                        size={17}
                        color={theme.primaryText}
                      />
                    )}
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: theme.primaryText },
                      ]}
                    >
                      Installer erneut öffnen
                    </Text>
                  </Pressable>
                )}

                <View style={styles.secondaryRow}>
                  <Pressable
                    onPress={() => void openUnknownSourcesSettings()}
                    style={[
                      styles.secondaryBtn,
                      {
                        flex: 2,
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.secondaryBtnText, { color: theme.text }]}
                    >
                      Berechtigung in Einstellungen öffnen
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={closeUpdateModal}
                    style={[
                      styles.secondaryBtn,
                      {
                        flex: 1,
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.secondaryBtnText,
                        { color: theme.textMuted },
                      ]}
                    >
                      Schließen
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {phase === 'error' && (
              <View style={styles.readySection}>
                <View
                  style={[
                    styles.errorBox,
                    { backgroundColor: theme.dangerSoft },
                  ]}
                >
                  <Text style={[styles.errorText, { color: theme.danger }]}>
                    {errorMsg ?? 'Download oder Prüfung ist fehlgeschlagen.'}
                  </Text>
                </View>

                <Pressable
                  onPress={() => void handleStartDownload()}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: theme.primary },
                  ]}
                >
                  <Ionicons
                    name="refresh"
                    size={17}
                    color={theme.primaryText}
                  />
                  <Text
                    style={[
                      styles.primaryBtnText,
                      { color: theme.primaryText },
                    ]}
                  >
                    Erneut versuchen
                  </Text>
                </Pressable>

                <View style={styles.secondaryRow}>
                  <Pressable
                    onPress={() =>
                      void openReleaseInBrowser(availableRelease.htmlUrl)
                    }
                    style={[
                      styles.secondaryBtn,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.secondaryBtnText, { color: theme.text }]}
                    >
                      Im Browser laden
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={closeUpdateModal}
                    style={[
                      styles.secondaryBtn,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.secondaryBtnText,
                        { color: theme.textMuted },
                      ]}
                    >
                      Schließen
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    justifyContent: 'flex-end',
  },
  backdropDismiss: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    maxHeight: '88%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  iconBadge: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  versionPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  versionPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  metaText: {
    fontSize: 12,
  },
  scrollArea: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 12,
  },
  safetyCard: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  safetyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  safetyTitle: {
    fontSize: 13.5,
    fontWeight: '800',
    flexShrink: 1,
  },
  safetyBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  safetyPending: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  notesCard: {
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  notesSectionHeader: {
    fontSize: 14,
    fontWeight: '800',
  },
  noteHeading: {
    fontSize: 13,
    fontWeight: '700',
    marginTop: 6,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
  },
  bulletDot: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
  },
  bulletText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
  },
  paragraphText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 22,
    gap: 10,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  linkBtn: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  linkBtnText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  progressSection: {
    gap: 8,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  progressPercent: {
    fontSize: 13,
    fontWeight: '800',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
  },
  progressMeta: {
    fontSize: 12,
    textAlign: 'right',
  },
  verifyingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
  },
  verifyingText: {
    fontSize: 13.5,
    fontWeight: '700',
  },
  readySection: {
    gap: 10,
  },
  guidanceBox: {
    padding: 11,
    borderRadius: 12,
    borderWidth: 1,
  },
  guidanceText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  errorBox: {
    padding: 10,
    borderRadius: 10,
  },
  errorText: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: '600',
  },
});
