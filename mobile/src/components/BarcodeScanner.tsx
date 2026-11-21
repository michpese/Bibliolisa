import React, { useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { normalizeIsbn, type NormalizedIsbn } from '@bibliolisa/shared';
import { useAppTheme } from '../theme';

interface BarcodeScannerProps {
  visible: boolean;
  onClose: () => void;
  onScan: (isbn: NormalizedIsbn) => void;
}

/**
 * Kamera-Scanner für EAN-13/ISBN-Barcodes mit Prüfziffervalidierung via @bibliolisa/shared.
 */
export function BarcodeScanner({
  visible,
  onClose,
  onScan,
}: BarcodeScannerProps) {
  const theme = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const lockRef = useRef(false);

  const handleBarcodeScanned = (result: BarcodeScanningResult) => {
    if (lockRef.current) return;

    const normalized = normalizeIsbn(result.data);
    if (!normalized.valid) {
      setHint(`Erkannter Code (${result.data}) ist keine gültige ISBN.`);
      return;
    }

    lockRef.current = true;
    setHint(null);
    setTorchEnabled(false);
    onScan(normalized);
  };

  const handleClose = () => {
    lockRef.current = false;
    setHint(null);
    setTorchEnabled(false);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
      onShow={() => {
        lockRef.current = false;
        setHint(null);
      }}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: '#000000' }]}>
        <View style={styles.header}>
          <Pressable
            onPress={handleClose}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Scanner schließen"
          >
            <Ionicons name="close" size={24} color="#ffffff" />
            <Text style={styles.headerButtonText}>Abbrechen</Text>
          </Pressable>
          <Text style={styles.headerTitle}>ISBN scannen</Text>
          <Pressable
            onPress={() => setTorchEnabled((prev) => !prev)}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Taschenlampe umschalten"
          >
            <Ionicons
              name={torchEnabled ? 'flash' : 'flash-outline'}
              size={22}
              color={torchEnabled ? '#fbbf24' : '#ffffff'}
            />
          </Pressable>
        </View>

        {!permission ? (
          <View style={styles.permissionBox}>
            <Text style={styles.permissionText}>Kamerastatus wird geprüft…</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.permissionBox}>
            <Ionicons name="camera-outline" size={48} color="#c7d2fe" />
            <Text style={styles.permissionTitle}>Kamerazugriff erforderlich</Text>
            <Text style={styles.permissionText}>
              Um den ISBN-Barcode auf der Buchrückseite zu scannen, benötigt Bibliolisa Zugriff auf die Kamera. Du kannst Bücher aber jederzeit auch manuell ohne Kamera eintragen.
            </Text>
            {permission.canAskAgain && (
              <Pressable
                onPress={() => void requestPermission()}
                style={[styles.primaryBtn, { backgroundColor: theme.primary }]}
              >
                <Text style={styles.primaryBtnText}>Kamera freigeben</Text>
              </Pressable>
            )}
            <Pressable onPress={handleClose} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Manuell eingeben</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrapper}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torchEnabled}
              barcodeScannerSettings={{
                barcodeTypes: ['ean13', 'ean8'],
              }}
              onBarcodeScanned={handleBarcodeScanned}
            />
            <View style={styles.overlay} pointerEvents="none">
              <View style={styles.scanFrame} />
              <Text style={styles.instruction}>
                Halte den ISBN-Barcode (EAN-13) ruhig in den Rahmen
              </Text>
              {hint && (
                <View style={styles.hintBanner}>
                  <Text style={styles.hintText}>{hint}</Text>
                </View>
              )}
            </View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  headerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  headerButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  cameraWrapper: {
    flex: 1,
    position: 'relative',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  scanFrame: {
    width: 280,
    height: 150,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: '#818cf8',
    backgroundColor: 'rgba(79, 70, 229, 0.08)',
  },
  instruction: {
    marginTop: 20,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  hintBanner: {
    marginTop: 14,
    backgroundColor: 'rgba(220, 38, 38, 0.9)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  hintText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  permissionBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 14,
  },
  permissionTitle: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionText: {
    color: '#d1d5db',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  primaryBtn: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 6,
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  secondaryBtnText: {
    color: '#c7d2fe',
    fontSize: 14,
    fontWeight: '600',
  },
});
