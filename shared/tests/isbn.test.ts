import { describe, expect, it } from 'vitest';
import {
  BookInputSchema,
  cleanIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10ToIsbn13,
  isbn13ToIsbn10,
  normalizeIsbn,
} from '../src/index.js';

describe('ISBN Utilities', () => {
  it('bereinigt Bindestriche, Leerzeichen und Kleinbuchstaben', () => {
    expect(cleanIsbn(' 0-8044-2957-x ')).toBe('080442957X');
    expect(cleanIsbn('978-3-453-26717-6')).toBe('9783453267176');
  });

  it('validiert gültige und ungültige ISBN-10-Nummern inklusive X-Prüfziffer', () => {
    expect(isValidIsbn10('3453267176')).toBe(true);
    expect(isValidIsbn10('0-306-40615-2')).toBe(true);
    expect(isValidIsbn10('080442957x')).toBe(true);
    expect(isValidIsbn10('0804429579')).toBe(false);
    expect(isValidIsbn10('123456789')).toBe(false);
    expect(isValidIsbn10('abcdefghij')).toBe(false);
  });

  it('validiert gültige und ungültige ISBN-13-Nummern', () => {
    expect(isValidIsbn13('978-3-453-26717-6')).toBe(true);
    expect(isValidIsbn13('9780804429573')).toBe(true);
    expect(isValidIsbn13('9791032305690')).toBe(true);
    expect(isValidIsbn13('9783453267175')).toBe(false);
    expect(isValidIsbn13('978345326717')).toBe(false);
  });

  it('konvertiert zwischen ISBN-10 und ISBN-13 und behandelt 979-Präfixe korrekt', () => {
    expect(isbn10ToIsbn13('3-453-26717-6')).toBe('9783453267176');
    expect(isbn10ToIsbn13('080442957x')).toBe('9780804429573');
    expect(isbn10ToIsbn13('invalid')).toBeNull();

    expect(isbn13ToIsbn10('9783453267176')).toBe('3453267176');
    expect(isbn13ToIsbn10('9780804429573')).toBe('080442957X');
    expect(isbn13ToIsbn10('9791032305690')).toBeNull();
    expect(isbn13ToIsbn10('9783453267170')).toBeNull();
  });

  it('normalisiert beliebige gültige und ungültige Eingaben über normalizeIsbn', () => {
    expect(normalizeIsbn('0-8044-2957-x')).toEqual({
      isbn10: '080442957X',
      isbn13: '9780804429573',
      valid: true,
    });
    expect(normalizeIsbn('979-10-323-0569-0')).toEqual({
      isbn10: null,
      isbn13: '9791032305690',
      valid: true,
    });
    expect(normalizeIsbn('9783453267170')).toEqual({
      isbn10: null,
      isbn13: null,
      valid: false,
    });
  });

  it('validiert und bereinigt ISBNs im Zod-Schema BookInputSchema', () => {
    const validBook = BookInputSchema.parse({
      title: 'Der Weg der Könige',
      isbn10: '3-453-26717-6',
      isbn13: '978-3-453-26717-6',
    });
    expect(validBook.isbn10).toBe('3453267176');
    expect(validBook.isbn13).toBe('9783453267176');

    const bad = BookInputSchema.safeParse({
      title: 'Ungültig',
      isbn13: '9783453267170',
    });
    expect(bad.success).toBe(false);
  });
});
