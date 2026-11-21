import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme';

interface RatingStarsProps {
  value: number | null;
  onChange?: (next: number | null) => void;
  size?: number;
  readonly?: boolean;
  showValue?: boolean;
}

/**
 * Interaktive 1-5 Sterne-Bewertung (erneutes Antippen desselben Sterns setzt auf null zurück).
 */
export function RatingStars({
  value,
  onChange,
  size = 20,
  readonly = false,
  showValue = false,
}: RatingStarsProps) {
  const theme = useAppTheme();

  return (
    <View style={styles.row}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = value !== null && star <= value;
        const iconName = filled ? 'star' : 'star-outline';
        const color = filled ? '#f59e0b' : theme.textMuted;

        if (readonly || !onChange) {
          return (
            <Ionicons
              key={star}
              name={iconName}
              size={size}
              color={color}
              style={styles.starIcon}
            />
          );
        }

        return (
          <Pressable
            key={star}
            onPress={() => onChange(value === star ? null : star)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${star} von 5 Sternen`}
            style={styles.starButton}
          >
            <Ionicons name={iconName} size={size} color={color} />
          </Pressable>
        );
      })}
      {showValue && value !== null && (
        <Text style={[styles.valueText, { color: theme.textMuted }]}>
          {value}/5
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  starIcon: {
    marginRight: 2,
  },
  starButton: {
    padding: 3,
  },
  valueText: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '600',
  },
});
