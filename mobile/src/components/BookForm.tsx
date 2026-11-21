import React, { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import {
  BookInputSchema,
  normalizeIsbn,
  type BookInput,
  type MetadataCandidate,
  type MetadataSource,
  type ReadingStatus,
} from '@bibliolisa/shared';
import { useAppTheme } from '../theme';
import {
  parseDecimal,
  parseOptionalInt,
  splitList,
  STATUS_ORDER,
  STATUS_SHORT_LABELS,
} from '../utils/format';
import { BookCoverImage } from './BookCoverImage';
import { RatingStars } from './RatingStars';

export interface BookFormValues {
  title: string;
  subtitle: string;
  authorsText: string;
  seriesName: string;
  seriesNumberText: string;
  isbn13: string;
  isbn10: string;
  pageCountText: string;
  publishedYearText: string;
  genresText: string;
  language: string;
  publisher: string;
  description: string;
  coverSourceUrl: string | null;
  coverLocalUri: string | null;
  coverPickedNew: boolean;
  metadataSource: MetadataSource;
  metadataExternalId: string | null;
  status: ReadingStatus;
  rating: number | null;
  notes: string;
}

export interface BookFormSubmitPayload {
  book: BookInput;
  status: ReadingStatus;
  rating: number | null;
  notes: string | null;
  coverLocalUri: string | null;
  coverPickedNew: boolean;
}

export function createEmptyBookFormValues(isbnPrefill = ''): BookFormValues {
  const normalized = isbnPrefill ? normalizeIsbn(isbnPrefill) : null;
  return {
    title: '',
    subtitle: '',
    authorsText: '',
    seriesName: '',
    seriesNumberText: '',
    isbn13: normalized?.valid ? (normalized.isbn13 ?? '') : isbnPrefill,
    isbn10: normalized?.valid ? (normalized.isbn10 ?? '') : '',
    pageCountText: '',
    publishedYearText: '',
    genresText: '',
    language: '',
    publisher: '',
    description: '',
    coverSourceUrl: null,
    coverLocalUri: null,
    coverPickedNew: false,
    metadataSource: 'manual',
    metadataExternalId: null,
    status: 'unread',
    rating: null,
    notes: '',
  };
}

export function bookFormValuesFromCandidate(
  candidate: MetadataCandidate
): BookFormValues {
  return {
    title: candidate.title,
    subtitle: candidate.subtitle ?? '',
    authorsText: candidate.authors.join(', '),
    seriesName: candidate.seriesName ?? '',
    seriesNumberText:
      candidate.seriesNumber !== null ? String(candidate.seriesNumber) : '',
    isbn13: candidate.isbn13 ?? '',
    isbn10: candidate.isbn10 ?? '',
    pageCountText:
      candidate.pageCount !== null ? String(candidate.pageCount) : '',
    publishedYearText:
      candidate.publishedYear !== null ? String(candidate.publishedYear) : '',
    genresText: candidate.genres.join(', '),
    language: candidate.language ?? '',
    publisher: candidate.publisher ?? '',
    description: candidate.description ?? '',
    coverSourceUrl: candidate.coverUrl,
    coverLocalUri: null,
    coverPickedNew: false,
    metadataSource: candidate.source,
    metadataExternalId: candidate.externalId,
    status: 'unread',
    rating: null,
    notes: '',
  };
}

interface BookFormProps {
  mode: 'create' | 'edit';
  initialValues: BookFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (payload: BookFormSubmitPayload) => Promise<void> | void;
  onCancel?: () => void;
}

export function BookForm({
  mode,
  initialValues,
  submitLabel,
  submitting = false,
  onSubmit,
  onCancel,
}: BookFormProps) {
  const theme = useAppTheme();
  const [values, setValues] = useState<BookFormValues>(initialValues);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setValues(initialValues);
    setErrorMsg(null);
  }, [initialValues]);

  const updateField = <K extends keyof BookFormValues>(
    key: K,
    val: BookFormValues[K]
  ) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  };

  const handlePickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setValues((prev) => ({
        ...prev,
        coverLocalUri: result.assets[0]!.uri,
        coverPickedNew: true,
      }));
    }
  };

  const handleTakeCoverPhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Berechtigung fehlt',
        'Für Cover-Fotos wird Kamerazugriff benötigt.'
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setValues((prev) => ({
        ...prev,
        coverLocalUri: result.assets[0]!.uri,
        coverPickedNew: true,
      }));
    }
  };

  const handleClearCover = () => {
    setValues((prev) => ({
      ...prev,
      coverLocalUri: null,
      coverSourceUrl: null,
      coverPickedNew: false,
    }));
  };

  const handleValidateAndSubmit = async () => {
    setErrorMsg(null);

    const seriesNumber = parseDecimal(values.seriesNumberText);
    if (seriesNumber === undefined) {
      setErrorMsg('Bandnummer muss eine gültige Zahl sein (z. B. 1 oder 1,5).');
      return;
    }

    const pageCount = parseOptionalInt(values.pageCountText);
    if (pageCount === undefined) {
      setErrorMsg('Seitenzahl muss eine ganze Zahl sein.');
      return;
    }

    const publishedYear = parseOptionalInt(values.publishedYearText);
    if (publishedYear === undefined) {
      setErrorMsg('Erscheinungsjahr muss eine vierstellige Jahreszahl sein.');
      return;
    }

    let isbn13: string | null = values.isbn13.trim() || null;
    let isbn10: string | null = values.isbn10.trim() || null;

    if (isbn13) {
      const norm = normalizeIsbn(isbn13);
      if (!norm.valid) {
        setErrorMsg('Ungültige ISBN-13-Prüfziffer.');
        return;
      }
      isbn13 = norm.isbn13;
      if (!isbn10 && norm.isbn10) {
        isbn10 = norm.isbn10;
      }
    }
    if (isbn10) {
      const norm = normalizeIsbn(isbn10);
      if (!norm.valid) {
        setErrorMsg('Ungültige ISBN-10-Prüfziffer.');
        return;
      }
      isbn10 = norm.isbn10;
      if (!isbn13 && norm.isbn13) {
        isbn13 = norm.isbn13;
      }
    }

    const parsedBook = BookInputSchema.safeParse({
      title: values.title,
      subtitle: values.subtitle.trim() || null,
      authors: splitList(values.authorsText),
      seriesName: values.seriesName.trim() || null,
      seriesNumber,
      isbn10,
      isbn13,
      pageCount,
      publishedYear,
      genres: splitList(values.genresText),
      description: values.description.trim() || null,
      coverSourceUrl: values.coverSourceUrl,
      language: values.language.trim() || null,
      publisher: values.publisher.trim() || null,
      metadataSource: values.metadataSource,
      metadataExternalId: values.metadataExternalId,
    });

    if (!parsedBook.success) {
      const firstIssue = parsedBook.error.issues[0];
      setErrorMsg(firstIssue?.message ?? 'Bitte Eingaben prüfen.');
      return;
    }

    try {
      await onSubmit({
        book: parsedBook.data,
        status: values.status,
        rating: values.rating,
        notes: values.notes.trim() || null,
        coverLocalUri: values.coverLocalUri,
        coverPickedNew: values.coverPickedNew,
      });
    } catch (error) {
      setErrorMsg(
        error instanceof Error
          ? error.message
          : 'Buch konnte nicht gespeichert werden.'
      );
    }
  };

  const inputStyle = [
    styles.input,
    {
      backgroundColor: theme.card,
      borderColor: theme.border,
      color: theme.text,
    },
  ];

  return (
    <View style={styles.form}>
      {/* Cover */}
      <View
        style={[
          styles.coverSection,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <BookCoverImage
          title={values.title || 'Buch'}
          localUri={values.coverLocalUri}
          previewUrl={values.coverSourceUrl}
          width={72}
          height={108}
        />
        <View style={styles.coverActions}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Cover</Text>
          <Text style={[styles.helperText, { color: theme.textMuted }]}>
            Wird lokal gespeichert und funktioniert komplett offline.
          </Text>
          <View style={styles.coverButtonsRow}>
            <Pressable
              onPress={() => void handlePickFromGallery()}
              style={[styles.smallBtn, { backgroundColor: theme.accent }]}
            >
              <Ionicons name="images-outline" size={16} color={theme.accentText} />
              <Text style={[styles.smallBtnText, { color: theme.accentText }]}>
                Galerie
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void handleTakeCoverPhoto()}
              style={[styles.smallBtn, { backgroundColor: theme.accent }]}
            >
              <Ionicons name="camera-outline" size={16} color={theme.accentText} />
              <Text style={[styles.smallBtnText, { color: theme.accentText }]}>
                Foto
              </Text>
            </Pressable>
            {(values.coverLocalUri || values.coverSourceUrl) && (
              <Pressable
                onPress={handleClearCover}
                style={[styles.smallBtn, { backgroundColor: theme.dangerSoft }]}
              >
                <Ionicons name="trash-outline" size={16} color={theme.danger} />
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Pflichtfeld Titel */}
      <View style={styles.fieldGroup}>
        <Text style={[styles.label, { color: theme.text }]}>Titel *</Text>
        <TextInput
          value={values.title}
          onChangeText={(t) => updateField('title', t)}
          placeholder="z. B. Der Weg der Könige"
          placeholderTextColor={theme.textMuted}
          style={inputStyle}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.label, { color: theme.text }]}>Untertitel</Text>
        <TextInput
          value={values.subtitle}
          onChangeText={(t) => updateField('subtitle', t)}
          placeholder="Optional"
          placeholderTextColor={theme.textMuted}
          style={inputStyle}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.label, { color: theme.text }]}>
          Autoren (kommagetrennt)
        </Text>
        <TextInput
          value={values.authorsText}
          onChangeText={(t) => updateField('authorsText', t)}
          placeholder="z. B. Brandon Sanderson"
          placeholderTextColor={theme.textMuted}
          style={inputStyle}
        />
      </View>

      {/* Buchreihe & Band */}
      <View style={styles.rowTwo}>
        <View style={[styles.fieldGroup, { flex: 2 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Buchreihe</Text>
          <TextInput
            value={values.seriesName}
            onChangeText={(t) => updateField('seriesName', t)}
            placeholder="z. B. Sturmlicht"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Band (z. B. 1,5)</Text>
          <TextInput
            value={values.seriesNumberText}
            onChangeText={(t) => updateField('seriesNumberText', t)}
            placeholder="1,5"
            keyboardType="decimal-pad"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
      </View>

      {/* ISBN */}
      <View style={styles.rowTwo}>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>ISBN-13</Text>
          <TextInput
            value={values.isbn13}
            onChangeText={(t) => updateField('isbn13', t)}
            placeholder="978..."
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>ISBN-10</Text>
          <TextInput
            value={values.isbn10}
            onChangeText={(t) => updateField('isbn10', t)}
            placeholder="Optional"
            autoCapitalize="characters"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
      </View>

      {/* Seitenzahl & Jahr */}
      <View style={styles.rowTwo}>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Seitenzahl</Text>
          <TextInput
            value={values.pageCountText}
            onChangeText={(t) => updateField('pageCountText', t)}
            placeholder="z. B. 320"
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Erscheinungsjahr</Text>
          <TextInput
            value={values.publishedYearText}
            onChangeText={(t) => updateField('publishedYearText', t)}
            placeholder="z. B. 2024"
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.label, { color: theme.text }]}>
          Genres / Tags (kommagetrennt)
        </Text>
        <TextInput
          value={values.genresText}
          onChangeText={(t) => updateField('genresText', t)}
          placeholder="z. B. Fantasy, High Fantasy"
          placeholderTextColor={theme.textMuted}
          style={inputStyle}
        />
      </View>

      <View style={styles.rowTwo}>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Verlag</Text>
          <TextInput
            value={values.publisher}
            onChangeText={(t) => updateField('publisher', t)}
            placeholder="Optional"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
        <View style={[styles.fieldGroup, { flex: 1 }]}>
          <Text style={[styles.label, { color: theme.text }]}>Sprache</Text>
          <TextInput
            value={values.language}
            onChangeText={(t) => updateField('language', t)}
            placeholder="de / en"
            autoCapitalize="none"
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={[styles.label, { color: theme.text }]}>Beschreibung</Text>
        <TextInput
          value={values.description}
          onChangeText={(t) => updateField('description', t)}
          placeholder="Klappentext oder Buchbeschreibung…"
          placeholderTextColor={theme.textMuted}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
          style={[inputStyle, styles.multilineInput]}
        />
      </View>

      {/* Persönlicher Index (bei Neuanlage direkt ausfüllbar) */}
      {mode === 'create' && (
        <View
          style={[
            styles.personalBox,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            Mein Lese-Index
          </Text>

          <View style={styles.statusRow}>
            {STATUS_ORDER.map((status) => {
              const active = values.status === status;
              return (
                <Pressable
                  key={status}
                  onPress={() => updateField('status', status)}
                  style={[
                    styles.statusChip,
                    {
                      backgroundColor: active
                        ? theme.primary
                        : theme.muted,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusChipText,
                      {
                        color: active ? theme.primaryText : theme.text,
                      },
                    ]}
                  >
                    {STATUS_SHORT_LABELS[status]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.ratingRow}>
            <Text style={[styles.label, { color: theme.text }]}>Bewertung:</Text>
            <RatingStars
              value={values.rating}
              onChange={(next) => updateField('rating', next)}
              size={24}
              showValue
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: theme.text }]}>Notizen</Text>
            <TextInput
              value={values.notes}
              onChangeText={(t) => updateField('notes', t)}
              placeholder="Persönliche Leseeindrücke…"
              placeholderTextColor={theme.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              style={[inputStyle, styles.multilineInput]}
            />
          </View>
        </View>
      )}

      {errorMsg && (
        <View style={[styles.errorBox, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.errorText, { color: theme.danger }]}>
            {errorMsg}
          </Text>
        </View>
      )}

      <View style={styles.submitRow}>
        {onCancel && (
          <Pressable
            onPress={onCancel}
            disabled={submitting}
            style={[
              styles.cancelButton,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
          >
            <Text style={[styles.cancelButtonText, { color: theme.text }]}>
              Abbrechen
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => void handleValidateAndSubmit()}
          disabled={submitting}
          style={[
            styles.submitButton,
            { backgroundColor: theme.primary, opacity: submitting ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.submitButtonText, { color: theme.primaryText }]}>
            {submitting ? 'Speichere…' : submitLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 12,
  },
  coverSection: {
    flexDirection: 'row',
    gap: 14,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  coverActions: {
    flex: 1,
    gap: 6,
  },
  coverButtonsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  smallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  smallBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  helperText: {
    fontSize: 12,
    lineHeight: 16,
  },
  fieldGroup: {
    gap: 5,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  multilineInput: {
    minHeight: 84,
  },
  rowTwo: {
    flexDirection: 'row',
    gap: 10,
  },
  personalBox: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorBox: {
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
  },
  submitRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  submitButton: {
    flex: 2,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
