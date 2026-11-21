import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme';

interface BookCoverImageProps {
  title: string;
  localUri?: string | null;
  previewUrl?: string | null;
  width?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Zeigt bevorzugt das lokale Offline-Cover (`coverLocalUri`), optional eine Online-Vorschau
 * oder andernfalls einen offline-fähigen typografischen Platzhalter.
 */
export function BookCoverImage({
  title,
  localUri,
  previewUrl,
  width = 64,
  height = 96,
  style,
}: BookCoverImageProps) {
  const theme = useAppTheme();
  const uri = localUri || previewUrl || null;

  if (uri) {
    return (
      <View
        style={[
          styles.container,
          { width, height, backgroundColor: theme.muted, borderColor: theme.border },
          style,
        ]}
      >
        <Image
          source={{ uri }}
          style={styles.image}
          resizeMode="cover"
          accessibilityLabel={`Cover von ${title}`}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        styles.placeholder,
        {
          width,
          height,
          backgroundColor: theme.accent,
          borderColor: theme.border,
        },
        style,
      ]}
    >
      <Ionicons name="book-outline" size={Math.round(width * 0.34)} color={theme.accentText} />
      {width >= 60 && (
        <Text
          numberOfLines={2}
          style={[styles.placeholderTitle, { color: theme.accentText }]}
        >
          {title}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 4,
  },
  placeholderTitle: {
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
});
