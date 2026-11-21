import { useColorScheme } from 'react-native';
import type { ReadingStatus } from '@bibliolisa/shared';

export interface AppTheme {
  isDark: boolean;
  background: string;
  card: string;
  muted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  accent: string;
  accentText: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  statusColors: Record<ReadingStatus, { bg: string; fg: string }>;
}

const LIGHT_THEME: AppTheme = {
  isDark: false,
  background: '#f6f7fb',
  card: '#ffffff',
  muted: '#eef0f6',
  border: '#dde1ec',
  text: '#161b26',
  textMuted: '#5e6678',
  primary: '#4f46e5',
  primaryText: '#ffffff',
  accent: '#eef0ff',
  accentText: '#3730a3',
  success: '#16a34a',
  successSoft: '#dcfce7',
  warning: '#d97706',
  warningSoft: '#fef3c7',
  danger: '#dc2626',
  dangerSoft: '#fee2e2',
  statusColors: {
    unread: { bg: '#eef0f6', fg: '#3f4656' },
    reading: { bg: '#e0e7ff', fg: '#3730a3' },
    read: { bg: '#dcfce7', fg: '#15803d' },
    abandoned: { bg: '#fee2e2', fg: '#b91c1c' },
  },
};

const DARK_THEME: AppTheme = {
  isDark: true,
  background: '#0f131d',
  card: '#171d2b',
  muted: '#21293c',
  border: '#2b344b',
  text: '#eef1f7',
  textMuted: '#99a3b8',
  primary: '#818cf8',
  primaryText: '#0f131d',
  accent: '#232952',
  accentText: '#c7d2fe',
  success: '#34d399',
  successSoft: '#123629',
  warning: '#fbbf24',
  warningSoft: '#3b2b10',
  danger: '#f87171',
  dangerSoft: '#3c181b',
  statusColors: {
    unread: { bg: '#21293c', fg: '#d2d8e5' },
    reading: { bg: '#272f66', fg: '#c7d2fe' },
    read: { bg: '#133b2b', fg: '#6ee7b7' },
    abandoned: { bg: '#421a1e', fg: '#fca5a5' },
  },
};

export function useAppTheme(): AppTheme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? DARK_THEME : LIGHT_THEME;
}
