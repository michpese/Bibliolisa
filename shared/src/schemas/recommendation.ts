import { z } from 'zod';
import { IsoUtcTimestampSchema, UUIDv4Schema } from './common.js';
import { LibraryEntrySchema } from './user-book.js';

export const RecommendationCategorySchema = z.enum([
  'continue_series',
  'affinity',
  'quick_read',
  'dust_collector',
  'surprise_me',
]);
export type RecommendationCategory = z.infer<typeof RecommendationCategorySchema>;

export const RecommendationReasonCodeSchema = z.enum([
  'next_in_series',
  'series_gap',
  'series_unnumbered',
  'author_affinity',
  'genre_affinity',
  'combined_affinity',
  'quick_read',
  'dust_collector',
  'surprise_me',
]);
export type RecommendationReasonCode = z.infer<typeof RecommendationReasonCodeSchema>;

export const RecommendationItemSchema = z.object({
  userBookId: UUIDv4Schema,
  bookId: UUIDv4Schema,
  category: RecommendationCategorySchema,
  score: z.number(),
  reasonCode: RecommendationReasonCodeSchema,
  reasonText: z.string(),
  entry: LibraryEntrySchema.optional(),
});
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;

export const RecommendationCategoriesMapSchema = z.object({
  continue_series: z.array(RecommendationItemSchema),
  affinity: z.array(RecommendationItemSchema),
  quick_read: z.array(RecommendationItemSchema),
  dust_collector: z.array(RecommendationItemSchema),
  surprise_me: z.array(RecommendationItemSchema),
});
export type RecommendationCategoriesMap = z.infer<
  typeof RecommendationCategoriesMapSchema
>;

export const RecommendationResultSchema = z.object({
  generatedAt: IsoUtcTimestampSchema,
  seed: z.number().int(),
  categories: RecommendationCategoriesMapSchema,
});
export type RecommendationResult = z.infer<typeof RecommendationResultSchema>;

export const RecommendationQuerySchema = z.object({
  seed: z.coerce.number().int().optional(),
  limitPerCategory: z.coerce.number().int().min(1).max(20).default(5),
});
export type RecommendationQuery = z.infer<typeof RecommendationQuerySchema>;
