import * as Crypto from 'expo-crypto';

/**
 * Erzeugt eine clientseitige RFC-4122-UUIDv4 für Bücher, Einträge und Geräte-ID.
 */
export function generateUuid(): string {
  return Crypto.randomUUID();
}
