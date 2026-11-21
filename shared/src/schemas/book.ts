import { z } from 'zod';
import { cleanIsbn, isValidIsbn10, isValidIsbn13 } from '../utils/isbn.js';
import {
  IsoUtcTimestampSchema,
  MetadataSourceSchema,
  UUIDv4Schema,
} from './common.js';

export const SeriesNumberSchema = z
  .number()
  .finite('Bandnummer muss eine endliche Zahl sein.')
  .min(0, 'Bandnummer darf nicht negativ sein.')
  .max(9999, 'Bandnummer ist zu groß.');

export const CoverKeySchema = z
  .string()
  .regex(/^[a-f0-9]{24}\.webp$/, 'Ungültiger Cover-Key.');

export const Isbn10Schema = z
  .string()
  .transform((value) => cleanIsbn(value))
  .refine((value) => isValidIsbn10(value), 'Ungültige ISBN-10-Prüfziffer.');

export const Isbn13Schema = z
  .string()
  .transform((value) => cleanIsbn(value))
  .refine((value) => isValidIsbn13(value), 'Ungültige ISBN-13-Prüfziffer.');

export const BookSchema = z.object({
  id: UUIDv4Schema,
  title: z.string().trim().min(1, 'Titel ist erforderlich.').max(500),
  subtitle: z.string().trim().max(500).nullable(),
  authors: z.array(z.string().trim().min(1).max(200)),
  seriesName: z.string().trim().max(300).nullable(),
  seriesNumber: SeriesNumberSchema.nullable(),
  isbn10: Isbn10Schema.nullable(),
  isbn13: Isbn13Schema.nullable(),
  pageCount: z.number().int().positive('Seitenzahl muss positiv sein.').max(50000).nullable(),
  publishedYear: z
    .number()
    .int()
    .min(1000, 'Erscheinungsjahr muss zwischen 1000 und 2100 liegen.')
    .max(2100, 'Erscheinungsjahr muss zwischen 1000 und 2100 liegen.')
    .nullable(),
  genres: z.array(z.string().trim().min(1).max(100)),
  description: z.string().max(20000).nullable(),
  coverKey: CoverKeySchema.nullable(),
  coverSourceUrl: z.string().url('Ungültige Cover-URL.').max(2000).nullable(),
  language: z.string().trim().min(2).max(16).nullable(),
  publisher: z.string().trim().max(300).nullable(),
  metadataSource: MetadataSourceSchema,
  metadataExternalId: z.string().trim().max(200).nullable(),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  deletedAt: IsoUtcTimestampSchema.nullable(),
});
export type Book = z.infer<typeof BookSchema>;

export const BookInputSchema = z.object({
  id: UUIDv4Schema.optional(),
  title: z.string().trim().min(1, 'Titel ist erforderlich.').max(500),
  subtitle: z.string().trim().max(500).nullable().optional(),
  authors: z.array(z.string().trim().min(1).max(200)).default([]),
  seriesName: z.string().trim().max(300).nullable().optional(),
  seriesNumber: SeriesNumberSchema.nullable().optional(),
  isbn10: Isbn10Schema.nullable().optional(),
  isbn13: Isbn13Schema.nullable().optional(),
  pageCount: z.number().int().positive().max(50000).nullable().optional(),
  publishedYear: z.number().int().min(1000).max(2100).nullable().optional(),
  genres: z.array(z.string().trim().min(1).max(100)).default([]),
  description: z.string().max(20000).nullable().optional(),
  coverKey: CoverKeySchema.nullable().optional(),
  coverSourceUrl: z.string().url('Ungültige Cover-URL.').max(2000).nullable().optional(),
  language: z.string().trim().min(2).max(16).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  metadataSource: MetadataSourceSchema.default('manual'),
  metadataExternalId: z.string().trim().max(200).nullable().optional(),
});
export type BookInput = z.infer<typeof BookInputSchema>;

export const BookUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Titel darf nicht leer sein.').max(500).optional(),
  subtitle: z.string().trim().max(500).nullable().optional(),
  authors: z.array(z.string().trim().min(1).max(200)).optional(),
  seriesName: z.string().trim().max(300).nullable().optional(),
  seriesNumber: SeriesNumberSchema.nullable().optional(),
  isbn10: Isbn10Schema.nullable().optional(),
  isbn13: Isbn13Schema.nullable().optional(),
  pageCount: z.number().int().positive().max(50000).nullable().optional(),
  publishedYear: z.number().int().min(1000).max(2100).nullable().optional(),
  genres: z.array(z.string().trim().min(1).max(100)).optional(),
  description: z.string().max(20000).nullable().optional(),
  coverKey: CoverKeySchema.nullable().optional(),
  coverSourceUrl: z.string().url('Ungültige Cover-URL.').max(2000).nullable().optional(),
  language: z.string().trim().min(2).max(16).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  metadataSource: MetadataSourceSchema.optional(),
  metadataExternalId: z.string().trim().max(200).nullable().optional(),
});
export type BookUpdate = z.infer<typeof BookUpdateSchema>;
