import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { ReadingStatus } from '@bibliolisa/shared';
import { BookCoverImage } from '../components/BookCoverImage';
import {
  BookForm,
  type BookFormSubmitPayload,
  type BookFormValues,
} from '../components/BookForm';
import { RatingStars } from '../components/RatingStars';
import { useAppContext } from '../context/AppContext';
import {
  getLocalLibraryEntryById,
  softDeleteLocalLibraryEntry,
  updateLocalLibraryEntry,
} from '../db/library.repo';
import type { LocalLibraryEntry } from '../db/types';
import type { RootStackParamList } from '../navigation/types';
import { saveLocalCover } from '../services/cover-cache';
import { useAppTheme } from '../theme';
import {
  formatAuthors,
  formatDate,
  formatSeriesLabel,
  STATUS_LABELS,
  STATUS_ORDER,
  statusTransitionPatch,
} from '../utils/format';
import { useBottomSafePadding, useSafeAreaInsets } from '../utils/safe-area';

type DetailRouteProp = RouteProp<RootStackParamList, 'BookDetail'>;
type DetailNavProp = NativeStackNavigationProp<RootStackParamList, 'BookDetail'>;

function toEditFormValues(entry: LocalLibraryEntry): BookFormValues {
  const { book } = entry;
  return {
    title: book.title,
    subtitle: book.subtitle ?? '',
    authorsText: book.authors.join(', '),
    seriesName: book.seriesName ?? '',
    seriesNumberText:
      book.seriesNumber !== null ? String(book.seriesNumber) : '',
    isbn13: book.isbn13 ?? '',
    isbn10: book.isbn10 ?? '',
    pageCountText: book.pageCount !== null ? String(book.pageCount) : '',
    publishedYearText:
      book.publishedYear !== null ? String(book.publishedYear) : '',
    genresText: book.genres.join(', '),
    language: book.language ?? '',
    publisher: book.publisher ?? '',
    description: book.description ?? '',
    coverSourceUrl: book.coverSourceUrl,
    coverLocalUri: entry.coverLocalUri,
    coverPickedNew: false,
    metadataSource: book.metadataSource,
    metadataExternalId: book.metadataExternalId,
    status: entry.status,
    rating: entry.rating,
    notes: entry.notes ?? '',
  };
}

export function BookDetailScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const bottomSafePadding = useBottomSafePadding(24);
  const route = useRoute<DetailRouteProp>();
  const navigation = useNavigation<DetailNavProp>();
  const { db, userId, libraryVersion, notifyDataChanged } = useAppContext();

  const [entry, setEntry] = useState<LocalLibraryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadEntry = useCallback(async () => {
    if (!db || !userId) return;
    const loaded = await getLocalLibraryEntryById(
      db,
      userId,
      route.params.userBookId
    );
    setEntry(loaded);
    setNotesDraft(loaded?.notes ?? '');
  }, [db, route.params.userBookId, userId]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadEntry();
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadEntry, libraryVersion]);

  const handleStatusChange = async (nextStatus: ReadingStatus) => {
    if (!db || !userId || !entry || entry.status === nextStatus) return;
    const patch = statusTransitionPatch(entry, nextStatus);
    const updated = await updateLocalLibraryEntry(db, userId, entry.id, patch);
    setEntry(updated);
    await notifyDataChanged();
  };

  const handleRatingChange = async (nextRating: number | null) => {
    if (!db || !userId || !entry) return;
    const updated = await updateLocalLibraryEntry(db, userId, entry.id, {
      rating: nextRating,
    });
    setEntry(updated);
    await notifyDataChanged();
  };

  const handleSaveNotes = async () => {
    if (!db || !userId || !entry) return;
    setSavingNotes(true);
    try {
      const updated = await updateLocalLibraryEntry(db, userId, entry.id, {
        notes: notesDraft.trim() || null,
      });
      setEntry(updated);
      setNotesDraft(updated.notes ?? '');
      await notifyDataChanged();
    } finally {
      setSavingNotes(false);
    }
  };

  const handleEditSubmit = async (payload: BookFormSubmitPayload) => {
    if (!db || !userId || !entry) return;
    setSavingEdit(true);
    try {
      let nextCoverLocalUri: string | null | undefined = undefined;
      let nextCoverPendingUpload: boolean | undefined = undefined;
      const coverCleared =
        !payload.coverPickedNew &&
        payload.coverLocalUri === null &&
        !payload.book.coverSourceUrl &&
        (entry.coverLocalUri !== null || entry.book.coverKey !== null);

      if (payload.coverPickedNew && payload.coverLocalUri) {
        nextCoverLocalUri = await saveLocalCover(
          payload.coverLocalUri,
          entry.bookId
        );
        nextCoverPendingUpload = true;
      } else if (coverCleared) {
        nextCoverLocalUri = null;
        nextCoverPendingUpload = false;
      }

      const updated = await updateLocalLibraryEntry(
        db,
        userId,
        entry.id,
        {
          book: coverCleared
            ? { ...payload.book, coverKey: null }
            : payload.book,
        },
        {
          coverLocalUri: nextCoverLocalUri,
          coverPendingUpload: nextCoverPendingUpload,
        }
      );
      setEntry(updated);
      setEditModalVisible(false);
      await notifyDataChanged();
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = () => {
    if (!db || !userId || !entry) return;
    Alert.alert(
      'Buch entfernen?',
      `Möchtest du „${entry.book.title}“ aus deinem persönlichen Index entfernen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Entfernen',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await softDeleteLocalLibraryEntry(db, userId, entry.id);
              await notifyDataChanged({
                id: entry.id,
                title: entry.book.title,
              });
              navigation.goBack();
            })();
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (!entry) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.notFoundText, { color: theme.textMuted }]}>
          Dieser Bibliothekseintrag existiert nicht mehr.
        </Text>
      </View>
    );
  }

  const { book } = entry;
  const seriesLabel = formatSeriesLabel(book);
  const notesChanged = (notesDraft.trim() || null) !== (entry.notes ?? null);

  return (
    <>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: theme.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={[styles.content, { paddingBottom: bottomSafePadding }]}
          keyboardShouldPersistTaps="handled"
        >
      {/* Buch-Header */}
      <View
        style={[
          styles.heroCard,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <BookCoverImage
          title={book.title}
          localUri={entry.coverLocalUri}
          previewUrl={book.coverSourceUrl}
          width={100}
          height={150}
        />
        <View style={styles.heroInfo}>
          <Text style={[styles.title, { color: theme.text }]}>{book.title}</Text>
          {book.subtitle && (
            <Text style={[styles.subtitle, { color: theme.textMuted }]}>
              {book.subtitle}
            </Text>
          )}
          <Text style={[styles.authors, { color: theme.text }]}>
            {formatAuthors(book)}
          </Text>
          {seriesLabel && (
            <View style={[styles.seriesPill, { backgroundColor: theme.accent }]}>
              <Text style={[styles.seriesPillText, { color: theme.accentText }]}>
                {seriesLabel}
              </Text>
            </View>
          )}
          {entry.isDirty && (
            <Text style={[styles.dirtyTag, { color: theme.warning }]}>
              ● Lokal geändert (offline gespeichert)
            </Text>
          )}
          {entry.coverPendingUpload && (
            <Text style={[styles.dirtyTag, { color: theme.warning }]}>
              ● Cover wartet auf Upload
            </Text>
          )}
        </View>
      </View>

      {/* Lesestatus */}
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Lesestatus
        </Text>
        <View style={styles.statusGrid}>
          {STATUS_ORDER.map((status) => {
            const selected = entry.status === status;
            const palette = theme.statusColors[status];
            return (
              <Pressable
                key={status}
                onPress={() => void handleStatusChange(status)}
                style={[
                  styles.statusBtn,
                  {
                    backgroundColor: selected ? theme.primary : palette.bg,
                    borderColor: selected ? theme.primary : theme.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusBtnText,
                    { color: selected ? theme.primaryText : palette.fg },
                  ]}
                >
                  {STATUS_LABELS[status]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Bewertung */}
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <View style={styles.rowBetween}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            Bewertung
          </Text>
          <RatingStars
            value={entry.rating}
            onChange={(next) => void handleRatingChange(next)}
            size={26}
            showValue
          />
        </View>
      </View>

      {/* Notizen */}
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Persönliche Notizen
        </Text>
        <TextInput
          value={notesDraft}
          onChangeText={setNotesDraft}
          placeholder="Gedanken, Zitate oder Lesefortschritt festhalten…"
          placeholderTextColor={theme.textMuted}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          style={[
            styles.notesInput,
            {
              backgroundColor: theme.background,
              borderColor: theme.border,
              color: theme.text,
            },
          ]}
        />
        {notesChanged && (
          <Pressable
            onPress={() => void handleSaveNotes()}
            disabled={savingNotes}
            style={[styles.saveNotesBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={[styles.saveNotesBtnText, { color: theme.primaryText }]}>
              {savingNotes ? 'Speichere…' : 'Notizen speichern'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Bibliographische Details */}
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Buch-Metadaten
        </Text>
        {book.isbn13 && (
          <DetailRow label="ISBN-13" value={book.isbn13} theme={theme} />
        )}
        {book.isbn10 && (
          <DetailRow label="ISBN-10" value={book.isbn10} theme={theme} />
        )}
        {book.pageCount !== null && (
          <DetailRow
            label="Seitenzahl"
            value={`${book.pageCount} Seiten`}
            theme={theme}
          />
        )}
        {book.publishedYear !== null && (
          <DetailRow
            label="Erscheinungsjahr"
            value={String(book.publishedYear)}
            theme={theme}
          />
        )}
        {book.publisher && (
          <DetailRow label="Verlag" value={book.publisher} theme={theme} />
        )}
        {book.language && (
          <DetailRow label="Sprache" value={book.language} theme={theme} />
        )}
        <DetailRow
          label="Hinzugefügt"
          value={formatDate(entry.addedAt)}
          theme={theme}
        />
        {entry.startedAt && (
          <DetailRow
            label="Gestartet"
            value={formatDate(entry.startedAt)}
            theme={theme}
          />
        )}
        {entry.finishedAt && (
          <DetailRow
            label="Beendet"
            value={formatDate(entry.finishedAt)}
            theme={theme}
          />
        )}

        {book.genres.length > 0 && (
          <View style={styles.genresRow}>
            {book.genres.map((genre) => (
              <View
                key={genre}
                style={[styles.genreChip, { backgroundColor: theme.muted }]}
              >
                <Text style={[styles.genreChipText, { color: theme.text }]}>
                  {genre}
                </Text>
              </View>
            ))}
          </View>
        )}

        {book.description && (
          <Text style={[styles.description, { color: theme.textMuted }]}>
            {book.description}
          </Text>
        )}
      </View>

      {/* Aktionen */}
      <View style={styles.actionsRow}>
        <Pressable
          onPress={() => setEditModalVisible(true)}
          style={[
            styles.actionBtn,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Ionicons name="create-outline" size={18} color={theme.primary} />
          <Text style={[styles.actionBtnText, { color: theme.text }]}>
            Metadaten bearbeiten
          </Text>
        </Pressable>

        <Pressable
          onPress={handleDelete}
          style={[
            styles.actionBtn,
            { backgroundColor: theme.dangerSoft, borderColor: theme.dangerSoft },
          ]}
        >
          <Ionicons name="trash-outline" size={18} color={theme.danger} />
          <Text style={[styles.actionBtnText, { color: theme.danger }]}>
            Entfernen
          </Text>
        </Pressable>
      </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Bearbeiten-Modal */}
      <Modal
        visible={editModalVisible}
        animationType="slide"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setEditModalVisible(false)}
      >
        <View
          style={[
            styles.modalContainer,
            { backgroundColor: theme.background, paddingTop: insets.top },
          ]}
        >
          <View
            style={[
              styles.modalHeader,
              { borderBottomColor: theme.border, backgroundColor: theme.card },
            ]}
          >
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Buch bearbeiten
            </Text>
            <Pressable onPress={() => setEditModalVisible(false)}>
              <Ionicons name="close" size={24} color={theme.text} />
            </Pressable>
          </View>
          <KeyboardAvoidingView
            style={styles.modalContainer}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <ScrollView
              contentContainerStyle={[
                styles.modalScroll,
                { paddingBottom: bottomSafePadding },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              <BookForm
                mode="edit"
                initialValues={toEditFormValues(entry)}
                submitLabel="Änderungen speichern"
                submitting={savingEdit}
                onSubmit={handleEditSubmit}
                onCancel={() => setEditModalVisible(false)}
              />
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

function DetailRow({
  label,
  value,
  theme,
}: {
  label: string;
  value: string;
  theme: ReturnType<typeof useAppTheme>;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: theme.textMuted }]}>
        {label}
      </Text>
      <Text style={[styles.detailValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  notFoundText: {
    fontSize: 15,
    textAlign: 'center',
  },
  heroCard: {
    flexDirection: 'row',
    gap: 14,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  heroInfo: {
    flex: 1,
    gap: 5,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    lineHeight: 24,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  authors: {
    fontSize: 14,
    fontWeight: '600',
  },
  seriesPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginTop: 2,
  },
  seriesPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  dirtyTag: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  sectionCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  notesInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    minHeight: 96,
    fontSize: 14,
  },
  saveNotesBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  saveNotesBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  detailLabel: {
    fontSize: 13,
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  genresRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  genreChip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  genreChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  modalScroll: {
    padding: 16,
    paddingBottom: 40,
  },
});
