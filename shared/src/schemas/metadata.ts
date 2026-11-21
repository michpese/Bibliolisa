import { z } from 'zod';
import { SeriesNumberSchema } from './book.js';

export const MetadataProviderIdSchema = z.enum([
  'hardcover',
  'google_books',
  'openlibrary',
]);
export type MetadataProviderId = z.infer<typeof MetadataProviderIdSchema>;

export const MetadataCandidateSchema = z.object({
  source: MetadataProviderIdSchema,
  externalId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  seriesName: z.string().nullable(),
  seriesNumber: SeriesNumberSchema.nullable(),
  isbn10: z.string().nullable(),
  isbn13: z.string().nullable(),
  pageCount: z.number().int().positive().nullable(),
  publishedYear: z.number().int().min(1000).max(2100).nullable(),
  genres: z.array(z.string()),
  description: z.string().nullable(),
  coverUrl: z.string().url().nullable(),
  language: z.string().nullable(),
  publisher: z.string().nullable(),
});
export type MetadataCandidate = z.infer<typeof MetadataCandidateSchema>;

export const ProviderStatusSchema = z.object({
  provider: MetadataProviderIdSchema,
  displayName: z.string(),
  enabled: z.boolean(),
  status: z.enum(['ok', 'empty', 'error', 'timeout', 'disabled']),
  errorMessage: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const MetadataIsbnResponseSchema = z.object({
  isbn10: z.string().nullable(),
  isbn13: z.string().nullable(),
  merged: MetadataCandidateSchema.nullable(),
  candidates: z.array(MetadataCandidateSchema),
  providerStatuses: z.array(ProviderStatusSchema),
});
export type MetadataIsbnResponse = z.infer<typeof MetadataIsbnResponseSchema>;

export const MetadataSearchResponseSchema = z.object({
  query: z.string(),
  candidates: z.array(MetadataCandidateSchema),
  providerStatuses: z.array(ProviderStatusSchema),
});
export type MetadataSearchResponse = z.infer<typeof MetadataSearchResponseSchema>;

export const MetadataProvidersResponseSchema = z.object({
  providers: z.array(
    z.object({
      id: MetadataProviderIdSchema,
      displayName: z.string(),
      enabled: z.boolean(),
      requiresApiKey: z.boolean(),
    })
  ),
});
export type MetadataProvidersResponse = z.infer<typeof MetadataProvidersResponseSchema>;
