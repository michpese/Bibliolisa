import { z } from 'zod';
import { BookSchema } from './book.js';
import { IsoUtcTimestampSchema, ReadingStatusSchema, UUIDv4Schema } from './common.js';
import { RatingSchema } from './user-book.js';

export const ExportEntrySchema = z.object({
  userBookId: UUIDv4Schema,
  status: ReadingStatusSchema,
  rating: RatingSchema.nullable(),
  notes: z.string().max(50000).nullable(),
  addedAt: IsoUtcTimestampSchema,
  startedAt: IsoUtcTimestampSchema.nullable(),
  finishedAt: IsoUtcTimestampSchema.nullable(),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  book: BookSchema,
});
export type ExportEntry = z.infer<typeof ExportEntrySchema>;

export const ExportPayloadSchema = z.object({
  version: z.literal(1),
  exportedAt: IsoUtcTimestampSchema,
  user: z.object({
    id: UUIDv4Schema,
    username: z.string(),
    displayName: z.string().nullable(),
  }),
  entries: z.array(ExportEntrySchema),
});
export type ExportPayload = z.infer<typeof ExportPayloadSchema>;

export const ExportImportEnvelopeSchema = z.object({
  version: z.literal(1),
  exportedAt: IsoUtcTimestampSchema,
  user: z.object({
    id: UUIDv4Schema,
    username: z.string(),
    displayName: z.string().nullable(),
  }),
  entries: z.array(z.unknown()),
});
export type ExportImportEnvelope = z.infer<typeof ExportImportEnvelopeSchema>;

export const ImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      message: z.string(),
    })
  ),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;
