import { useSafeAreaInsets } from 'react-native-safe-area-context';

export { useSafeAreaInsets };

/**
 * Berechnet den sicheren unteren Abstand für Scroll-Inhalte, Bottom-Sheets und Modal-Footer.
 */
export function computeBottomSafePadding(
  insetBottom: number,
  extra = 16
): number {
  return Math.max(insetBottom, 16) + extra;
}

/**
 * Liefert den unteren Safe-Area-Abstand aus dem Root-<SafeAreaProvider>-Kontext.
 * Hinweis: Immer in der Elternkomponente (unterhalb von <SafeAreaProvider>) aufrufen,
 * nicht innerhalb eines React-Native-<Modal> via <SafeAreaView>, da Android-Modals
 * ein separates Dialog-Window ohne sichere Bottom-Insets öffnen.
 */
export function useBottomSafePadding(extra = 16): number {
  const insets = useSafeAreaInsets();
  return computeBottomSafePadding(insets.bottom, extra);
}
