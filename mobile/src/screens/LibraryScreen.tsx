import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
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
  getDefaultSortOrder,
  type LibraryFacetsResponse,
  type LibrarySortField,
  type ReadingStatus,
  type SortOrder,
} from '@bibliolisa/shared';
import { BookCoverImage } from '../components/BookCoverImage';
import { RatingStars } from '../components/RatingStars';
import { useAppContext } from '../context/AppContext';
import {
  getLocalLibraryFacets,
  listLocalLibraryEntries,
  type LocalLibraryFilters,
} from '../db/library.repo';
import type { LocalLibraryEntry } from '../db/types';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';
import { useAppTheme } from '../theme';
import {
  formatAuthors,
  formatSeriesLabel,
  SORT_OPTIONS,
  STATUS_ORDER,
  STATUS_SHORT_LABELS,
} from '../utils/format';

type LibraryNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'LibraryTab'>,
  NativeStackNavigationProp<RootStackParamList>
>;

export function LibraryScreen() {
  const theme = useAppTheme();
  const navigation = useNavigation<LibraryNavProp>();
  const {
    db,
    userId,
    libraryVersion,
    pendingChangesCount,
    lastDeleted,
    undoLastDelete,
    dismissUndoBanner,
  } = useAppContext();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReadingStatus | undefined>(undefined);
  const [genreFilter, setGenreFilter] = useState<string | undefined>(undefined);
  const [seriesFilter, setSeriesFilter] = useState<string | undefined>(undefined);
  const [authorFilter, setAuthorFilter] = useState<string | undefined>(undefined);
  const [minRatingFilter, setMinRatingFilter] = useState<number | undefined>(undefined);
  const [sortField, setSortField] = useState<LibrarySortField>('series');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const [entries, setEntries] = useState<LocalLibraryEntry[]>([]);
  const [facets, setFacets] = useState<LibraryFacetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [filterModalVisible, setFilterModalVisible] = useState(false);

  const loadData = useCallback(async () => {
    if (!db || !userId) return;
    const filters: LocalLibraryFilters = {
      q: searchQuery.trim() || undefined,
      status: statusFilter,
      genre: genreFilter,
      series: seriesFilter,
      author: authorFilter,
      minRating: minRatingFilter,
      sort: sortField,
      order: sortOrder,
    };
    const [nextEntries, nextFacets] = await Promise.all([
      listLocalLibraryEntries(db, userId, filters),
      getLocalLibraryFacets(db, userId),
    ]);
    setEntries(nextEntries);
    setFacets(nextFacets);
  }, [
    authorFilter,
    db,
    genreFilter,
    minRatingFilter,
    searchQuery,
    seriesFilter,
    sortField,
    sortOrder,
    statusFilter,
    userId,
  ]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadData();
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadData, libraryVersion]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  };

  const activeFilterCount =
    (genreFilter ? 1 : 0) +
    (seriesFilter ? 1 : 0) +
    (authorFilter ? 1 : 0) +
    (minRatingFilter ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilter(undefined);
    setGenreFilter(undefined);
    setSeriesFilter(undefined);
    setAuthorFilter(undefined);
    setMinRatingFilter(undefined);
    setSearchQuery('');
  };

  const currentSortLabel =
    SORT_OPTIONS.find((opt) => opt.value === sortField)?.label ?? 'Reihe';

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.container, { backgroundColor: theme.background }]}
    >
      {/* Kopfzeile */}
      <View style={styles.topHeader}>
        <View>
          <Text style={[styles.screenTitle, { color: theme.text }]}>
            Bibliolisa
          </Text>
          <Text style={[styles.screenSubtitle, { color: theme.textMuted }]}>
            {facets?.total ?? 0} {(facets?.total ?? 0) === 1 ? 'Buch' : 'Bücher'}
            {pendingChangesCount > 0
              ? ` · ${pendingChangesCount} lokal vorgemerkt`
              : ' · Offline bereit'}
          </Text>
        </View>
        <Pressable
          onPress={() => navigation.navigate('AddBookTab')}
          style={[styles.headerAddBtn, { backgroundColor: theme.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Buch hinzufügen"
        >
          <Ionicons name="add" size={20} color={theme.primaryText} />
          <Text style={[styles.headerAddBtnText, { color: theme.primaryText }]}>
            Neu
          </Text>
        </Pressable>
      </View>

      {/* Suchfeld */}
      <View
        style={[
          styles.searchBar,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <Ionicons name="search-outline" size={18} color={theme.textMuted} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Titel, Autor, Reihe, ISBN oder Notiz…"
          placeholderTextColor={theme.textMuted}
          style={[styles.searchInput, { color: theme.text }]}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={theme.textMuted} />
          </Pressable>
        )}
      </View>

      {/* Status-Chips */}
      <View style={styles.chipsWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          <Pressable
            onPress={() => setStatusFilter(undefined)}
            style={[
              styles.chip,
              {
                backgroundColor:
                  statusFilter === undefined ? theme.primary : theme.card,
                borderColor:
                  statusFilter === undefined ? theme.primary : theme.border,
              },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                {
                  color:
                    statusFilter === undefined ? theme.primaryText : theme.text,
                },
              ]}
            >
              Alle ({facets?.total ?? 0})
            </Text>
          </Pressable>
          {STATUS_ORDER.map((status) => {
            const selected = statusFilter === status;
            const count = facets?.statusCounts[status] ?? 0;
            return (
              <Pressable
                key={status}
                onPress={() =>
                  setStatusFilter((prev) =>
                    prev === status ? undefined : status
                  )
                }
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? theme.primary : theme.card,
                    borderColor: selected ? theme.primary : theme.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: selected ? theme.primaryText : theme.text },
                  ]}
                >
                  {STATUS_SHORT_LABELS[status]} ({count})
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Sortierung & Erweiterte Filter */}
      <View style={styles.toolbarRow}>
        <Pressable
          onPress={() => setSortModalVisible(true)}
          style={[
            styles.toolbarBtn,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Ionicons name="swap-vertical-outline" size={16} color={theme.primary} />
          <Text style={[styles.toolbarBtnText, { color: theme.text }]}>
            {currentSortLabel} ({sortOrder === 'asc' ? '↑' : '↓'})
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setFilterModalVisible(true)}
          style={[
            styles.toolbarBtn,
            {
              backgroundColor:
                activeFilterCount > 0 ? theme.accent : theme.card,
              borderColor:
                activeFilterCount > 0 ? theme.primary : theme.border,
            },
          ]}
        >
          <Ionicons
            name="funnel-outline"
            size={16}
            color={activeFilterCount > 0 ? theme.accentText : theme.primary}
          />
          <Text
            style={[
              styles.toolbarBtnText,
              {
                color: activeFilterCount > 0 ? theme.accentText : theme.text,
              },
            ]}
          >
            Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </Pressable>

        {(activeFilterCount > 0 || statusFilter !== undefined || searchQuery !== '') && (
          <Pressable onPress={clearAllFilters} style={styles.resetLink}>
            <Text style={[styles.resetLinkText, { color: theme.primary }]}>
              Zurücksetzen
            </Text>
          </Pressable>
        )}
      </View>

      {/* Rückgängig-Banner nach Soft-Delete */}
      {lastDeleted && (
        <View
          style={[
            styles.undoBanner,
            { backgroundColor: theme.card, borderColor: theme.primary },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.undoText, { color: theme.text }]}
          >
            „{lastDeleted.title}“ entfernt
          </Text>
          <View style={styles.undoActions}>
            <Pressable
              onPress={() => void undoLastDelete()}
              style={[styles.undoBtn, { backgroundColor: theme.accent }]}
            >
              <Text style={[styles.undoBtnText, { color: theme.accentText }]}>
                Rückgängig
              </Text>
            </Pressable>
            <Pressable onPress={dismissUndoBanner} hitSlop={8}>
              <Ionicons name="close" size={18} color={theme.textMuted} />
            </Pressable>
          </View>
        </View>
      )}

      {/* Liste */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          contentContainerStyle={
            entries.length === 0 ? styles.emptyListContainer : styles.listContent
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void handleRefresh()}
              tintColor={theme.primary}
            />
          }
          ListEmptyComponent={
            <View
              style={[
                styles.emptyCard,
                { backgroundColor: theme.card, borderColor: theme.border },
              ]}
            >
              <Ionicons name="library-outline" size={42} color={theme.textMuted} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                {(facets?.total ?? 0) === 0
                  ? 'Deine Bibliothek ist noch leer'
                  : 'Keine passenden Bücher gefunden'}
              </Text>
              <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
                {(facets?.total ?? 0) === 0
                  ? 'Scanne eine ISBN oder erfasse dein erstes Buch komplett offline.'
                  : 'Passe Suchbegriff oder Filter an, um alle Bücher zu sehen.'}
              </Text>
              {(facets?.total ?? 0) === 0 && (
                <Pressable
                  onPress={() => navigation.navigate('AddBookTab')}
                  style={[styles.emptyCta, { backgroundColor: theme.primary }]}
                >
                  <Text
                    style={[styles.emptyCtaText, { color: theme.primaryText }]}
                  >
                    Erstes Buch hinzufügen
                  </Text>
                </Pressable>
              )}
            </View>
          }
          renderItem={({ item }) => {
            const seriesLabel = formatSeriesLabel(item.book);
            const statusColor = theme.statusColors[item.status];
            return (
              <Pressable
                onPress={() =>
                  navigation.navigate('BookDetail', { userBookId: item.id })
                }
                style={({ pressed }) => [
                  styles.card,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                    opacity: pressed ? 0.88 : 1,
                  },
                ]}
              >
                <BookCoverImage
                  title={item.book.title}
                  localUri={item.coverLocalUri}
                  previewUrl={item.book.coverSourceUrl}
                  width={60}
                  height={90}
                />
                <View style={styles.cardBody}>
                  <View style={styles.cardTitleRow}>
                    <Text
                      numberOfLines={2}
                      style={[styles.bookTitle, { color: theme.text }]}
                    >
                      {item.book.title}
                    </Text>
                    {item.isDirty && (
                      <View
                        style={[
                          styles.dirtyDot,
                          { backgroundColor: theme.warning },
                        ]}
                      />
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[styles.bookAuthor, { color: theme.textMuted }]}
                  >
                    {formatAuthors(item.book)}
                  </Text>
                  {seriesLabel && (
                    <Text
                      numberOfLines={1}
                      style={[styles.bookSeries, { color: theme.accentText }]}
                    >
                      {seriesLabel}
                    </Text>
                  )}
                  <View style={styles.cardFooter}>
                    <View
                      style={[
                        styles.statusBadge,
                        { backgroundColor: statusColor.bg },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusBadgeText,
                          { color: statusColor.fg },
                        ]}
                      >
                        {STATUS_SHORT_LABELS[item.status]}
                      </Text>
                    </View>
                    {item.rating !== null && (
                      <RatingStars value={item.rating} readonly size={14} />
                    )}
                  </View>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {/* Sortier-Modal */}
      <Modal
        visible={sortModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setSortModalVisible(false)}
        >
          <Pressable
            style={[
              styles.modalSheet,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
            onPress={() => undefined}
          >
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Sortierung wählen
            </Text>
            {SORT_OPTIONS.map((opt) => {
              const selected = sortField === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    if (selected) {
                      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
                    } else {
                      setSortField(opt.value);
                      setSortOrder(getDefaultSortOrder(opt.value));
                    }
                    setSortModalVisible(false);
                  }}
                  style={[
                    styles.modalOption,
                    selected && { backgroundColor: theme.accent },
                  ]}
                >
                  <Text
                    style={[
                      styles.modalOptionText,
                      { color: selected ? theme.accentText : theme.text },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {selected && (
                    <Text style={{ color: theme.accentText, fontWeight: '700' }}>
                      {sortOrder === 'asc' ? 'Aufsteigend ↑' : 'Absteigend ↓'}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Filter-Modal */}
      <Modal
        visible={filterModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.filterSheet,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <View style={styles.filterHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                Lokale Filter
              </Text>
              <Pressable onPress={() => setFilterModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.text} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.filterScroll}>
              <Text style={[styles.filterGroupTitle, { color: theme.text }]}>
                Mindestbewertung
              </Text>
              <View style={styles.wrapRow}>
                {[undefined, 3, 4, 5].map((rating) => {
                  const selected = minRatingFilter === rating;
                  return (
                    <Pressable
                      key={rating ?? 'all'}
                      onPress={() => setMinRatingFilter(rating)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: selected ? theme.primary : theme.muted,
                          borderColor: selected ? theme.primary : theme.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          {
                            color: selected ? theme.primaryText : theme.text,
                          },
                        ]}
                      >
                        {rating === undefined ? 'Alle' : `≥ ${rating} ★`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {facets && facets.series.length > 0 && (
                <>
                  <Text style={[styles.filterGroupTitle, { color: theme.text }]}>
                    Buchreihe
                  </Text>
                  <View style={styles.wrapRow}>
                    {facets.series.slice(0, 20).map((s) => {
                      const selected =
                        seriesFilter?.toLowerCase() === s.value.toLowerCase();
                      return (
                        <Pressable
                          key={s.value}
                          onPress={() =>
                            setSeriesFilter(selected ? undefined : s.value)
                          }
                          style={[
                            styles.chip,
                            {
                              backgroundColor: selected
                                ? theme.primary
                                : theme.muted,
                              borderColor: selected
                                ? theme.primary
                                : theme.border,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              {
                                color: selected
                                  ? theme.primaryText
                                  : theme.text,
                              },
                            ]}
                          >
                            {s.value} ({s.count})
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              {facets && facets.genres.length > 0 && (
                <>
                  <Text style={[styles.filterGroupTitle, { color: theme.text }]}>
                    Genre / Tag
                  </Text>
                  <View style={styles.wrapRow}>
                    {facets.genres.slice(0, 20).map((g) => {
                      const selected =
                        genreFilter?.toLowerCase() === g.value.toLowerCase();
                      return (
                        <Pressable
                          key={g.value}
                          onPress={() =>
                            setGenreFilter(selected ? undefined : g.value)
                          }
                          style={[
                            styles.chip,
                            {
                              backgroundColor: selected
                                ? theme.primary
                                : theme.muted,
                              borderColor: selected
                                ? theme.primary
                                : theme.border,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              {
                                color: selected
                                  ? theme.primaryText
                                  : theme.text,
                              },
                            ]}
                          >
                            {g.value} ({g.count})
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              {facets && facets.authors.length > 0 && (
                <>
                  <Text style={[styles.filterGroupTitle, { color: theme.text }]}>
                    Autor
                  </Text>
                  <View style={styles.wrapRow}>
                    {facets.authors.slice(0, 20).map((a) => {
                      const selected =
                        authorFilter?.toLowerCase() === a.value.toLowerCase();
                      return (
                        <Pressable
                          key={a.value}
                          onPress={() =>
                            setAuthorFilter(selected ? undefined : a.value)
                          }
                          style={[
                            styles.chip,
                            {
                              backgroundColor: selected
                                ? theme.primary
                                : theme.muted,
                              borderColor: selected
                                ? theme.primary
                                : theme.border,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              {
                                color: selected
                                  ? theme.primaryText
                                  : theme.text,
                              },
                            ]}
                          >
                            {a.value} ({a.count})
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}
            </ScrollView>

            <View style={styles.filterFooter}>
              <Pressable
                onPress={() => {
                  setGenreFilter(undefined);
                  setSeriesFilter(undefined);
                  setAuthorFilter(undefined);
                  setMinRatingFilter(undefined);
                }}
                style={[styles.footerBtn, { borderColor: theme.border, borderWidth: 1 }]}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>
                  Leeren
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setFilterModalVisible(false)}
                style={[styles.footerBtn, { backgroundColor: theme.primary }]}
              >
                <Text style={{ color: theme.primaryText, fontWeight: '700' }}>
                  Anwenden ({entries.length})
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  screenSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  headerAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  headerAddBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  chipsWrapper: {
    marginTop: 10,
  },
  chipsScroll: {
    paddingHorizontal: 16,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  toolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  toolbarBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  resetLink: {
    marginLeft: 'auto',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  resetLinkText: {
    fontSize: 12,
    fontWeight: '700',
  },
  undoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  undoText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    marginRight: 8,
  },
  undoActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  undoBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  undoBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
  },
  emptyListContainer: {
    flexGrow: 1,
    padding: 16,
    justifyContent: 'center',
  },
  emptyCard: {
    alignItems: 'center',
    padding: 28,
    borderRadius: 16,
    borderWidth: 1,
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
  emptyCta: {
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
  },
  emptyCtaText: {
    fontSize: 14,
    fontWeight: '700',
  },
  card: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  cardBody: {
    flex: 1,
    justifyContent: 'space-between',
    gap: 4,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
  },
  bookTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  dirtyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  bookAuthor: {
    fontSize: 13,
  },
  bookSeries: {
    fontSize: 12,
    fontWeight: '600',
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    margin: 16,
    marginBottom: 28,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 6,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 10,
  },
  modalOptionText: {
    fontSize: 15,
    fontWeight: '600',
  },
  filterSheet: {
    maxHeight: '80%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    padding: 16,
  },
  filterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  filterScroll: {
    gap: 12,
    paddingBottom: 16,
  },
  filterGroupTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  wrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 10,
  },
  footerBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
});
