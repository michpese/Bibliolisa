import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import {
  generateRecommendations,
  type RecommendationCategory,
  type RecommendationItem,
  type RecommendationResult,
} from '@bibliolisa/shared';
import { BookCoverImage } from '../components/BookCoverImage';
import { useAppContext } from '../context/AppContext';
import {
  listAllActiveLocalEntries,
  updateLocalLibraryEntry,
} from '../db/library.repo';
import type { LocalLibraryEntry } from '../db/types';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';
import { useSyncContext } from '../sync/sync-context';
import { useAppTheme } from '../theme';
import {
  formatAuthors,
  formatSeriesLabel,
  statusTransitionPatch,
} from '../utils/format';

type RecNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'RecommendationsTab'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const CATEGORY_META: Array<{
  key: RecommendationCategory;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  {
    key: 'continue_series',
    title: 'Begonnene Reihen',
    description: 'Der nächste Band, wo du aufgehört hast.',
    icon: 'layers-outline',
  },
  {
    key: 'affinity',
    title: 'Empfohlen für dich',
    description: 'Passend zu deinen Lieblingsautoren und -genres.',
    icon: 'thumbs-up-outline',
  },
  {
    key: 'quick_read',
    title: 'Schneller Read',
    description: 'Kompakte Bücher unter 300 Seiten.',
    icon: 'time-outline',
  },
  {
    key: 'dust_collector',
    title: 'Staubfänger',
    description: 'Schon lange auf deinem Lesestapel.',
    icon: 'flame-outline',
  },
  {
    key: 'surprise_me',
    title: 'Überrasch mich',
    description: 'Zufällige Auswahl aus deinem Ungelesen-Stapel.',
    icon: 'dice-outline',
  },
];

function formatTimeHms(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function RecommendationsScreen() {
  const theme = useAppTheme();
  const navigation = useNavigation<RecNavProp>();
  const { db, userId, libraryVersion, notifyDataChanged } = useAppContext();
  const { snapshot: syncSnapshot, syncNow } = useSyncContext();

  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [localEntriesById, setLocalEntriesById] = useState<
    Map<string, LocalLibraryEntry>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastReloadedAt, setLastReloadedAt] = useState<Date | null>(null);
  const [feedbackText, setFeedbackText] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const refreshingRef = useRef(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  const compute = useCallback(
    async (overrideSeed?: number) => {
      if (!db || !userId) return;
      const entries = await listAllActiveLocalEntries(db, userId);
      const entryMap = new Map<string, LocalLibraryEntry>();
      for (const e of entries) {
        entryMap.set(e.id, e);
      }
      const effectiveSeed = overrideSeed ?? seed;
      const computed = generateRecommendations(entries, {
        limitPerCategory: 5,
        seed: effectiveSeed,
        includeEntry: true,
      });
      if (!mountedRef.current) return;
      setLocalEntriesById(entryMap);
      setResult(computed);
    },
    [db, seed, userId]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await compute();
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [compute, libraryVersion]);

  const handleReload = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);

    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }

    const startedAt = Date.now();
    try {
      if (syncSnapshot.isConfigured && syncSnapshot.isAuthenticated) {
        try {
          await syncNow('pull_to_refresh');
        } catch {
          // Offline-Fallback: lokale Empfehlungen trotzdem neu berechnen
        }
      }

      let nextSeed = Math.floor(Math.random() * 1_000_000_000);
      if (nextSeed === seed) {
        nextSeed = (nextSeed + 1) % 1_000_000_000;
      }
      if (!mountedRef.current) return;
      setSeed(nextSeed);
      await compute(nextSeed);

      const remaining = 300 - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      if (!mountedRef.current) return;

      const now = new Date();
      setLastReloadedAt(now);
      setFeedbackText(`Empfehlungen aktualisiert (${formatTimeHms(now)})`);
      feedbackTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setFeedbackText(null);
        }
        feedbackTimerRef.current = null;
      }, 2500);
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [
    compute,
    seed,
    syncNow,
    syncSnapshot.isAuthenticated,
    syncSnapshot.isConfigured,
  ]);

  const handleStartReading = async (item: RecommendationItem) => {
    if (!db || !userId) return;
    const entry = localEntriesById.get(item.userBookId);
    if (!entry) return;
    await updateLocalLibraryEntry(
      db,
      userId,
      entry.id,
      statusTransitionPatch(entry, 'reading')
    );
    await notifyDataChanged();
  };

  const isEmpty =
    result !== null &&
    CATEGORY_META.every((cat) => result.categories[cat.key].length === 0);

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.container, { backgroundColor: theme.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void handleReload()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.screenTitle, { color: theme.text }]}>
              Was lese ich als Nächstes?
            </Text>
            <Text style={[styles.screenSubtitle, { color: theme.textMuted }]}>
              {lastReloadedAt
                ? `Vorschläge aus deinem ungelesenen Stapel · Stand ${formatTimeHms(lastReloadedAt)}`
                : 'Vorschläge aus deinem ungelesenen Stapel – auch komplett offline.'}
            </Text>
          </View>
          <Pressable
            onPress={() => void handleReload()}
            disabled={refreshing}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Empfehlungen neu laden"
            style={({ pressed }) => [
              styles.refreshBtn,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                opacity: pressed ? 0.65 : refreshing ? 0.8 : 1,
              },
            ]}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Ionicons name="refresh" size={18} color={theme.primary} />
            )}
          </Pressable>
        </View>

        {feedbackText && (
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.feedbackBanner,
              {
                backgroundColor: theme.successSoft,
                borderColor: theme.success,
              },
            ]}
          >
            <Ionicons name="checkmark-circle" size={16} color={theme.success} />
            <Text style={[styles.feedbackText, { color: theme.success }]}>
              {feedbackText}
            </Text>
          </View>
        )}

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={theme.primary} />
          </View>
        ) : isEmpty ? (
          <View
            style={[
              styles.emptyCard,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <Ionicons name="sparkles-outline" size={40} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              Noch keine Empfehlungen verfügbar
            </Text>
            <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
              Füge ungelesene Bücher hinzu – dann schlägt Bibliolisa passende Titel vor.
            </Text>
          </View>
        ) : (
          result &&
          CATEGORY_META.map((cat) => {
            const items = result.categories[cat.key];
            if (items.length === 0 && cat.key !== 'surprise_me') {
              return null;
            }
            return (
              <View key={cat.key} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View
                    style={[styles.iconBox, { backgroundColor: theme.accent }]}
                  >
                    <Ionicons
                      name={cat.icon}
                      size={20}
                      color={theme.accentText}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>
                      {cat.title}
                    </Text>
                    <Text
                      style={[
                        styles.sectionDesc,
                        { color: theme.textMuted },
                      ]}
                    >
                      {cat.description}
                    </Text>
                  </View>
                  {cat.key === 'surprise_me' && (
                    <Pressable
                      onPress={() =>
                        setSeed((prev) => {
                          let next = Math.floor(Math.random() * 1_000_000_000);
                          if (next === prev) {
                            next = (next + 1) % 1_000_000_000;
                          }
                          return next;
                        })
                      }
                      style={({ pressed }) => [
                        styles.diceBtn,
                        {
                          backgroundColor: theme.accent,
                          opacity: pressed ? 0.65 : 1,
                        },
                      ]}
                    >
                      <Ionicons
                        name="dice-outline"
                        size={16}
                        color={theme.accentText}
                      />
                      <Text
                        style={[
                          styles.diceBtnText,
                          { color: theme.accentText },
                        ]}
                      >
                        Würfeln
                      </Text>
                    </Pressable>
                  )}
                </View>

                {items.length === 0 ? (
                  <Text
                    style={[styles.emptyCatText, { color: theme.textMuted }]}
                  >
                    Keine ungelesenen Bücher in dieser Kategorie.
                  </Text>
                ) : (
                  <View style={styles.cardsColumn}>
                    {items.map((item) => {
                      const localEntry = localEntriesById.get(item.userBookId);
                      const book = localEntry?.book ?? item.entry?.book;
                      if (!book) return null;
                      const seriesLabel = formatSeriesLabel(book);
                      return (
                        <Pressable
                          key={`${cat.key}-${item.userBookId}`}
                          onPress={() =>
                            navigation.navigate('BookDetail', {
                              userBookId: item.userBookId,
                            })
                          }
                          style={[
                            styles.recCard,
                            {
                              backgroundColor: theme.card,
                              borderColor: theme.border,
                            },
                          ]}
                        >
                          <BookCoverImage
                            title={book.title}
                            localUri={localEntry?.coverLocalUri}
                            previewUrl={book.coverSourceUrl}
                            width={60}
                            height={90}
                          />
                          <View style={styles.recBody}>
                            <Text
                              numberOfLines={2}
                              style={[styles.recTitle, { color: theme.text }]}
                            >
                              {book.title}
                            </Text>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.recAuthor,
                                { color: theme.textMuted },
                              ]}
                            >
                              {formatAuthors(book)}
                            </Text>
                            {seriesLabel && (
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.recSeries,
                                  { color: theme.accentText },
                                ]}
                              >
                                {seriesLabel}
                              </Text>
                            )}
                            <View
                              style={[
                                styles.reasonBox,
                                { backgroundColor: theme.accent },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.reasonText,
                                  { color: theme.accentText },
                                ]}
                              >
                                {item.reasonText}
                              </Text>
                            </View>
                            <Pressable
                              onPress={() => void handleStartReading(item)}
                              style={[
                                styles.startReadingBtn,
                                { borderColor: theme.border },
                              ]}
                            >
                              <Ionicons
                                name="play-outline"
                                size={14}
                                color={theme.primary}
                              />
                              <Text
                                style={[
                                  styles.startReadingText,
                                  { color: theme.primary },
                                ]}
                              >
                                Jetzt lesen
                              </Text>
                            </Pressable>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 18,
    paddingBottom: 32,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  screenTitle: {
    fontSize: 23,
    fontWeight: '800',
  },
  screenSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: -6,
  },
  feedbackText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '700',
  },
  centered: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyCard: {
    padding: 28,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sectionDesc: {
    fontSize: 12,
  },
  diceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  diceBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  emptyCatText: {
    fontSize: 13,
  },
  cardsColumn: {
    gap: 10,
  },
  recCard: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  recBody: {
    flex: 1,
    gap: 4,
  },
  recTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  recAuthor: {
    fontSize: 12,
  },
  recSeries: {
    fontSize: 12,
    fontWeight: '600',
  },
  reasonBox: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 2,
  },
  reasonText: {
    fontSize: 12,
    lineHeight: 16,
  },
  startReadingBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  startReadingText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
