export interface NormalizedIsbn {
  isbn10: string | null;
  isbn13: string | null;
  valid: boolean;
}

/**
 * Entfernt Bindestriche und Leerzeichen und wandelt Buchstaben (Prüfziffer X) in Großbuchstaben um.
 */
export function cleanIsbn(raw: string): string {
  return raw.replace(/[\s-]+/g, '').trim().toUpperCase();
}

/**
 * Prüft eine ISBN-10 anhand der Modulo-11-Prüfziffer.
 */
export function isValidIsbn10(raw: string): boolean {
  const cleaned = cleanIsbn(raw);
  if (!/^\d{9}[\dX]$/.test(cleaned)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = cleaned[i];
    if (ch === undefined) {
      return false;
    }
    const digit = ch === 'X' ? 10 : Number(ch);
    sum += digit * (10 - i);
  }

  return sum % 11 === 0;
}

/**
 * Prüft eine ISBN-13 anhand der alternierenden 1/3-Modulo-10-Prüfziffer.
 */
export function isValidIsbn13(raw: string): boolean {
  const cleaned = cleanIsbn(raw);
  if (!/^\d{13}$/.test(cleaned)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const ch = cleaned[i];
    if (ch === undefined) {
      return false;
    }
    const digit = Number(ch);
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }

  const expectedCheck = (10 - (sum % 10)) % 10;
  return Number(cleaned[12]) === expectedCheck;
}

/**
 * Konvertiert eine gültige ISBN-10 in eine ISBN-13 (Präfix 978).
 */
export function isbn10ToIsbn13(raw: string): string | null {
  const cleaned = cleanIsbn(raw);
  if (!isValidIsbn10(cleaned)) {
    return null;
  }

  const body = `978${cleaned.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(body[i]);
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

/**
 * Konvertiert eine gültige ISBN-13 mit Präfix 978 in eine ISBN-10.
 * Für 979-Präfixe existiert keine ISBN-10; gibt in diesem Fall null zurück.
 */
export function isbn13ToIsbn10(raw: string): string | null {
  const cleaned = cleanIsbn(raw);
  if (!isValidIsbn13(cleaned) || !cleaned.startsWith('978')) {
    return null;
  }

  const body = cleaned.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(body[i]) * (10 - i);
  }
  const remainder = (11 - (sum % 11)) % 11;
  const check = remainder === 10 ? 'X' : String(remainder);
  return `${body}${check}`;
}

/**
 * Normalisiert eine beliebige ISBN-10 oder ISBN-13 und liefert beide Darstellungen zurück.
 */
export function normalizeIsbn(raw: string): NormalizedIsbn {
  const cleaned = cleanIsbn(raw);

  if (isValidIsbn13(cleaned)) {
    return {
      isbn10: isbn13ToIsbn10(cleaned),
      isbn13: cleaned,
      valid: true,
    };
  }

  if (isValidIsbn10(cleaned)) {
    return {
      isbn10: cleaned,
      isbn13: isbn10ToIsbn13(cleaned),
      valid: true,
    };
  }

  return {
    isbn10: null,
    isbn13: null,
    valid: false,
  };
}
