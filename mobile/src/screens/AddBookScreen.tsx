import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import {
  normalizeIsbn,
  type MetadataCandidate,
  type MetadataProviderId,
  type NormalizedIsbn,
  type ProviderStatus,
} from '@bibliolisa/shared';
import { BarcodeScanner } from '../components/BarcodeScanner';
import { BookCoverImage } from '../components/BookCoverImage';
import {
  BookForm,
  bookFormValuesFromCandidate,
  createEmptyBookFormValues,
  type BookFormSubmitPayload,
  type BookFormValues,
} from '../components/BookForm';
import { useAppContext } from '../context/AppContext';
import {
  createLocalLibraryEntry,
  findActiveLocalEntryByIsbn,
} from '../db/library.repo';
import type { LocalLibraryEntry } from '../db/types';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';
import {
  lookupMetadataByIsbn,
  searchMetadata,
} from '../services/api-client';
import {
  cacheExternalCoverPreview,
  saveLocalCover,
} from '../services/cover-cache';
import { checkServerHealth } from '../sync/health-check';
import { useAppTheme } from '../theme';
import {
  formatSeriesNumber,
  PROVIDER_LABELS,
  statusTransitionPatch,
} from '../utils/format';
import { generateUuid } from '../utils/uuid';

type AddBookNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'AddBookTab'>,
  NativeStackNavigationProp<RootStackParamList>
>;

interface CandidateResultItem {
  candidate: MetadataCandidate;
  merged: boolean;
}

const PROVIDER_STATUS_TEXT: Record<ProviderStatus['status'], string> = {
  ok: 'Treffer',
  empty: 'Leer',
  error: 'Fehler',
  timeout: 'Timeout',
  disabled: 'Aus',
};

export function AddBookScreen() {
  const theme = useAppTheme();
  const navigation = useNavigation<AddBookNavProp>();
  const {
    db,
    userId,
    serverUrl,
    isAuthenticated,
    notifyDataChanged,
  } = useAppContext();

  const [scannerOpen, setScannerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [lookupBanner, setLookupBanner] = useState<{
    tone: 'info' | 'warning';
    text: string;
  } | null>(null);
  const [results, setResults] = useState<CandidateResultItem[] | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [providerFilter, setProviderFilter] = useState<MetadataProviderId | 'all'>('all');
  const [existingMatch, setExistingMatch] = useState<LocalLibraryEntry | null>(null);

  const [formValues, setFormValues] = useState<BookFormValues>(() =>
    createEmptyBookFormValues()
  );
  const [submitting, setSubmitting] = useState(false);

  const checkLocalDuplicate = async (isbn13: string | null, isbn10: string | null) => {
    if (!db || !userId || (!isbn13 && !isbn10)) {
      setExistingMatch(null);
      return;
    }
    const found = await findActiveLocalEntryByIsbn(db, userId, isbn13, isbn10);
    setExistingMatch(found);
  };

  const prefillIsbnInManualForm = (norm: NormalizedIsbn) => {
    setFormValues((prev) => ({
      ...prev,
      isbn13: norm.isbn13 ?? prev.isbn13,
      isbn10: norm.isbn10 ?? prev.isbn10,
    }));
  };

  const runMetadataLookup = async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;

    const isbn = normalizeIsbn(trimmed);
    if (isbn.valid) {
      prefillIsbnInManualForm(isbn);
      await checkLocalDuplicate(isbn.isbn13, isbn.isbn10);
    } else {
      setExistingMatch(null);
    }

    // Nahtloser Offline-Fallback ohne Netzwerkverbindung / ohne Server-Login
    if (!serverUrl || !isAuthenticated) {
      setResults(null);
      setProviderStatuses([]);
      setLookupBanner({
        tone: 'info',
        text: isbn.valid
          ? `Offline-Modus: ISBN ${isbn.isbn13 ?? isbn.isbn10} wurde ins manuelle Formular übernommen.`
          : 'Offline-Modus: Ohne verbundene Server-Anmeldung kannst du das Buch direkt manuell erfassen.',
      });
      if (!isbn.valid) {
        setFormValues((prev) => ({
          ...prev,
          title: prev.title || trimmed,
        }));
      }
      return;
    }

    setSearching(true);
    setLookupBanner(null);
    setProviderFilter('all');

    try {
      const health = await checkServerHealth(serverUrl, 1500);
      if (!health.ok) {
        setResults(null);
        setProviderStatuses([]);
        setLookupBanner({
          tone: 'warning',
          text: isbn.valid
            ? `Server nicht erreichbar (${health.message}) – ISBN ${isbn.isbn13 ?? isbn.isbn10} wurde ins manuelle Formular übernommen.`
            : `Server nicht erreichbar (${health.message}) – bitte direkt manuell erfassen.`,
        });
        if (!isbn.valid) {
          setFormValues((prev) => ({
            ...prev,
            title: prev.title || trimmed,
          }));
        }
        return;
      }

      if (isbn.valid) {
        const res = await lookupMetadataByIsbn(
          serverUrl,
          isbn.isbn13 ?? isbn.isbn10 ?? trimmed
        );
        const items: CandidateResultItem[] = [];
        if (res.merged) {
          items.push({ candidate: res.merged, merged: true });
        }
        for (const c of res.candidates) {
          items.push({ candidate: c, merged: false });
        }
        setResults(items);
        setProviderStatuses(res.providerStatuses);
        if (items.length === 0) {
          setLookupBanner({
            tone: 'info',
            text: `Keine Online-Treffer für ISBN ${isbn.isbn13 ?? isbn.isbn10} – du kannst alle Felder unten manuell ausfüllen.`,
          });
        }
      } else {
        const res = await searchMetadata(serverUrl, trimmed, 10);
        const items = res.candidates.map((candidate) => ({
          candidate,
          merged: false,
        }));
        setResults(items);
        setProviderStatuses(res.providerStatuses);
        if (items.length === 0) {
          setFormValues((prev) => ({
            ...prev,
            title: prev.title || trimmed,
          }));
          setLookupBanner({
            tone: 'info',
            text: 'Keine Online-Treffer gefunden – direkt im manuellen Formular fortfahren.',
          });
        }
      }
    } catch (error) {
      setResults(null);
      setLookupBanner({
        tone: 'warning',
        text:
          error instanceof Error
            ? `${error.message} – manuelles Formular ist bereit.`
            : 'Metadaten-Abruf fehlgeschlagen – manuelles Formular ist bereit.',
      });
    } finally {
      setSearching(false);
    }
  };

  const handleBarcodeScanned = (isbn: NormalizedIsbn) => {
    setScannerOpen(false);
    const code = isbn.isbn13 ?? isbn.isbn10 ?? '';
    setSearchQuery(code);
    void runMetadataLookup(code);
  };

  const handlePickCandidate = (candidate: MetadataCandidate) => {
    setFormValues(bookFormValuesFromCandidate(candidate));
    setResults(null);
    setLookupBanner({
      tone: 'info',
      text: `Metadaten von ${PROVIDER_LABELS[candidate.source]} übernommen. Du kannst alle Felder vor dem Speichern anpassen.`,
    });
    const norm = candidate.isbn13
      ? normalizeIsbn(candidate.isbn13)
      : candidate.isbn10
        ? normalizeIsbn(candidate.isbn10)
        : null;
    if (norm?.valid) {
      void checkLocalDuplicate(norm.isbn13, norm.isbn10);
    }
  };

  const handleCreateBook = async (payload: BookFormSubmitPayload) => {
    if (!db || !userId) {
      throw new Error('Datenbank ist noch nicht bereit.');
    }

    setSubmitting(true);
    try {
      const bookId = generateUuid();
      let coverLocalUri: string | null = null;
      let coverPendingUpload = false;

      if (payload.coverPickedNew && payload.coverLocalUri) {
        coverLocalUri = await saveLocalCover(payload.coverLocalUri, bookId);
        coverPendingUpload = true;
      } else if (payload.book.coverSourceUrl) {
        coverLocalUri = await Promise.race([
          cacheExternalCoverPreview(payload.book.coverSourceUrl, bookId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
      }

      const created = await createLocalLibraryEntry(
        db,
        userId,
        {
          id: generateUuid(),
          book: { ...payload.book, id: bookId },
          ...statusTransitionPatch(
            { startedAt: null, finishedAt: null },
            payload.status
          ),
          status: payload.status,
          rating: payload.rating,
          notes: payload.notes,
        },
        {
          generateUuid,
          coverLocalUri,
          coverPendingUpload,
        }
      );

      await notifyDataChanged(null);
      setFormValues(createEmptyBookFormValues());
      setSearchQuery('');
      setResults(null);
      setProviderStatuses([]);
      setLookupBanner(null);
      setExistingMatch(null);

      Alert.alert(
        'Buch gespeichert',
        `„${created.book.title}“ wurde lokal in deiner Bibliothek gespeichert.`,
        [
          {
            text: 'Details öffnen',
            onPress: () =>
              navigation.navigate('BookDetail', { userBookId: created.id }),
          },
          {
            text: 'Zur Bibliothek',
            onPress: () => navigation.navigate('LibraryTab'),
          },
        ]
      );
    } finally {
      setSubmitting(false);
    }
  };

  const visibleResults = (results ?? []).filter(
    (item) =>
      providerFilter === 'all' ||
      item.merged ||
      item.candidate.source === providerFilter
  );

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.container, { backgroundColor: theme.background }]}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
        <Text style={[styles.screenTitle, { color: theme.text }]}>
          Buch hinzufügen
        </Text>
        <Text style={[styles.screenSubtitle, { color: theme.textMuted }]}>
          ISBN per Kamera scannen, online abrufen oder vollständig offline erfassen.
        </Text>

        {/* Scanner & Suche */}
        <View
          style={[
            styles.lookupCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Pressable
            onPress={() => setScannerOpen(true)}
            style={[styles.scanButton, { backgroundColor: theme.primary }]}
          >
            <Ionicons name="barcode-outline" size={22} color={theme.primaryText} />
            <Text style={[styles.scanButtonText, { color: theme.primaryText }]}>
              ISBN mit Kamera scannen
            </Text>
          </Pressable>

          <View style={styles.searchRow}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="ISBN, Titel oder Autor eingeben…"
              placeholderTextColor={theme.textMuted}
              returnKeyType="search"
              onSubmitEditing={() => void runMetadataLookup(searchQuery)}
              style={[
                styles.searchInput,
                {
                  backgroundColor: theme.background,
                  borderColor: theme.border,
                  color: theme.text,
                },
              ]}
            />
            <Pressable
              onPress={() => void runMetadataLookup(searchQuery)}
              disabled={searching || searchQuery.trim() === ''}
              style={[
                styles.searchSubmitBtn,
                {
                  backgroundColor: theme.accent,
                  opacity:
                    searching || searchQuery.trim() === '' ? 0.5 : 1,
                },
              ]}
            >
              {searching ? (
                <ActivityIndicator size="small" color={theme.accentText} />
              ) : (
                <Ionicons name="search" size={20} color={theme.accentText} />
              )}
            </Pressable>
          </View>

          {lookupBanner && (
            <View
              style={[
                styles.banner,
                {
                  backgroundColor:
                    lookupBanner.tone === 'warning'
                      ? theme.warningSoft
                      : theme.accent,
                },
              ]}
            >
              <Text
                style={[
                  styles.bannerText,
                  {
                    color:
                      lookupBanner.tone === 'warning'
                        ? theme.warning
                        : theme.accentText,
                  },
                ]}
              >
                {lookupBanner.text}
              </Text>
            </View>
          )}

          {existingMatch && (
            <Pressable
              onPress={() =>
                navigation.navigate('BookDetail', {
                  userBookId: existingMatch.id,
                })
              }
              style={[styles.banner, { backgroundColor: theme.warningSoft }]}
            >
              <Text style={[styles.bannerText, { color: theme.warning }]}>
                Hinweis: „{existingMatch.book.title}“ ist bereits in deiner Bibliothek. Tippen zum Öffnen.
              </Text>
            </Pressable>
          )}

          {/* Provider-Auswahl */}
          {providerStatuses.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.providerRow}
            >
              <Pressable
                onPress={() => setProviderFilter('all')}
                style={[
                  styles.providerChip,
                  {
                    backgroundColor:
                      providerFilter === 'all' ? theme.primary : theme.muted,
                  },
                ]}
              >
                <Text
                  style={{
                    color:
                      providerFilter === 'all' ? theme.primaryText : theme.text,
                    fontSize: 12,
                    fontWeight: '600',
                  }}
                >
                  Alle
                </Text>
              </Pressable>
              {providerStatuses.map((ps) => {
                const active = providerFilter === ps.provider;
                return (
                  <Pressable
                    key={ps.provider}
                    disabled={!ps.enabled}
                    onPress={() => setProviderFilter(ps.provider)}
                    style={[
                      styles.providerChip,
                      {
                        backgroundColor: active ? theme.primary : theme.muted,
                        opacity: ps.enabled ? 1 : 0.45,
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color: active ? theme.primaryText : theme.text,
                        fontSize: 12,
                        fontWeight: '600',
                      }}
                    >
                      {PROVIDER_LABELS[ps.provider]} · {PROVIDER_STATUS_TEXT[ps.status]}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {/* Online-Treffer */}
          {visibleResults.length > 0 && (
            <View style={styles.resultsList}>
              {visibleResults.map((item, idx) => {
                const { candidate } = item;
                const seriesText = candidate.seriesName
                  ? `${candidate.seriesName}${
                      candidate.seriesNumber !== null
                        ? ` · Band ${formatSeriesNumber(candidate.seriesNumber)}`
                        : ''
                    }`
                  : null;
                return (
                  <View
                    key={`${candidate.source}-${candidate.externalId}-${idx}`}
                    style={[
                      styles.candidateCard,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <BookCoverImage
                      title={candidate.title}
                      previewUrl={candidate.coverUrl}
                      width={52}
                      height={78}
                    />
                    <View style={styles.candidateInfo}>
                      <Text
                        numberOfLines={2}
                        style={[styles.candidateTitle, { color: theme.text }]}
                      >
                        {candidate.title}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[styles.candidateMeta, { color: theme.textMuted }]}
                      >
                        {candidate.authors.join(', ') || 'Unbekannter Autor'}
                        {candidate.publishedYear
                          ? ` · ${candidate.publishedYear}`
                          : ''}
                      </Text>
                      {seriesText && (
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.candidateSeries,
                            { color: theme.accentText },
                          ]}
                        >
                          {seriesText}
                        </Text>
                      )}
                      <View style={styles.candidateActions}>
                        <View
                          style={[
                            styles.sourceBadge,
                            { backgroundColor: theme.accent },
                          ]}
                        >
                          <Text
                            style={{
                              fontSize: 11,
                              fontWeight: '700',
                              color: theme.accentText,
                            }}
                          >
                            {item.merged
                              ? 'Beste Kombination'
                              : PROVIDER_LABELS[candidate.source]}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => handlePickCandidate(candidate)}
                          style={[
                            styles.pickBtn,
                            { backgroundColor: theme.primary },
                          ]}
                        >
                          <Text
                            style={{
                              color: theme.primaryText,
                              fontSize: 12,
                              fontWeight: '700',
                            }}
                          >
                            Übernehmen
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Vollständiges manuelles Offline-Formular */}
        <View style={styles.manualHeader}>
          <Text style={[styles.manualTitle, { color: theme.text }]}>
            Buchdetails (manuell / geprüft)
          </Text>
          <Pressable
            onPress={() => {
              setFormValues(createEmptyBookFormValues());
              setLookupBanner(null);
              setExistingMatch(null);
            }}
          >
            <Text style={{ color: theme.primary, fontSize: 13, fontWeight: '600' }}>
              Formular leeren
            </Text>
          </Pressable>
        </View>

        <BookForm
          mode="create"
          initialValues={formValues}
          submitLabel="Lokal speichern"
          submitting={submitting}
          onSubmit={handleCreateBook}
        />
        </ScrollView>
      </KeyboardAvoidingView>

      <BarcodeScanner
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleBarcodeScanned}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
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
  lookupCard: {
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
  },
  scanButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  searchSubmitBtn: {
    width: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    padding: 10,
    borderRadius: 10,
  },
  bannerText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  providerRow: {
    gap: 6,
  },
  providerChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  resultsList: {
    gap: 8,
  },
  candidateCard: {
    flexDirection: 'row',
    gap: 10,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  candidateInfo: {
    flex: 1,
    gap: 4,
  },
  candidateTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  candidateMeta: {
    fontSize: 12,
  },
  candidateSeries: {
    fontSize: 12,
    fontWeight: '600',
  },
  candidateActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sourceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pickBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  manualHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  manualTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
});
