import { z } from 'zod';
import { BookInputSchema, BookSchema, BookUpdateSchema } from './book.js';
import {
  IsoUtcTimestampSchema,
  PaginationQuerySchema,
  ReadingStatusSchema,
  SortOrderSchema,
  UUIDv4Schema,
} from './common.js';

export const RatingSchema = z
  .number()
  .int('Bewertung muss eine ganze Zahl zwischen 1 und 5 sein.')
  .min(1, 'Bewertung muss mindestens 1 sein.')
  .max(5, 'Bewertung darf maximal 5 sein.');

export const UserBookSchema = z.object({
  id: UUIDv4Schema,
  userId: UUIDv4Schema,
  bookId: UUIDv4Schema,
  status: ReadingStatusSchema,
  rating: RatingSchema.nullable(),
  notes: z.string().max(50000).nullable(),
  addedAt: IsoUtcTimestampSchema,
  startedAt: IsoUtcTimestampSchema.nullable(),
  finishedAt: IsoUtcTimestampSchema.nullable(),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  deletedAt: IsoUtcTimestampSchema.nullable(),
});
export type UserBook = z.infer<typeof UserBookSchema>;

export const LibraryEntrySchema = UserBookSchema.extend({
  book: BookSchema,
});
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export const LibrarySortFieldSchema = z.enum([
  'series',
  'author',
  'title',
  'status',
  'added_at',
  'rating',
  'published_year',
]);
export type LibrarySortField = z.infer<typeof LibrarySortFieldSchema>;

export const LibraryQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  status: ReadingStatusSchema.optional(),
  genre: z.string().trim().min(1).max(100).optional(),
  author: z.string().trim().min(1).max(200).optional(),
  series: z.string().trim().min(1).max(300).optional(),
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  maxRating: z.coerce.number().int().min(1).max(5).optional(),
  sort: LibrarySortFieldSchema.default('added_at'),
  order: SortOrderSchema.optional(),
}).refine(
  (query) =>
    query.minRating === undefined ||
    query.maxRating === undefined ||
    query.minRating <= query.maxRating,
  {
    message: 'minRating darf nicht größer als maxRating sein.',
    path: ['minRating'],
  }
);
export type LibraryQuery = z.infer<typeof LibraryQuerySchema>;

export const LibraryListResponseSchema = z.object({
  items: z.array(LibraryEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});
export type LibraryListResponse = z.infer<typeof LibraryListResponseSchema>;

export const FacetCountSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});
export type FacetCount = z.infer<typeof FacetCountSchema>;

export const StatusCountsSchema = z.object({
  unread: z.number().int().nonnegative(),
  reading: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  abandoned: z.number().int().nonnegative(),
});
export type StatusCounts = z.infer<typeof StatusCountsSchema>;

export const LibraryFacetsResponseSchema = z.object({
  genres: z.array(FacetCountSchema),
  series: z.array(FacetCountSchema),
  authors: z.array(FacetCountSchema),
  statusCounts: StatusCountsSchema,
  total: z.number().int().nonnegative(),
});
export type LibraryFacetsResponse = z.infer<typeof LibraryFacetsResponseSchema>;

export const CreateLibraryEntrySchema = z
  .object({
    id: UUIDv4Schema.optional(),
    bookId: UUIDv4Schema.optional(),
    book: BookInputSchema.optional(),
    status: ReadingStatusSchema.default('unread'),
    rating: RatingSchema.nullable().optional(),
    notes: z.string().max(50000).nullable().optional(),
    addedAt: IsoUtcTimestampSchema.optional(),
    startedAt: IsoUtcTimestampSchema.nullable().optional(),
    finishedAt: IsoUtcTimestampSchema.nullable().optional(),
  })
  .refine((data) => Boolean(data.bookId) !== Boolean(data.book), {
    message: 'Es muss genau entweder "bookId" oder "book" angegeben werden.',
  });
export type CreateLibraryEntry = z.infer<typeof CreateLibraryEntrySchema>;

export const UpdateLibraryEntrySchema = z.object({
  status: ReadingStatusSchema.optional(),
  rating: RatingSchema.nullable().optional(),
  notes: z.string().max(50000).nullable().optional(),
  addedAt: IsoUtcTimestampSchema.optional(),
  startedAt: IsoUtcTimestampSchema.nullable().optional(),
  finishedAt: IsoUtcTimestampSchema.nullable().optional(),
  book: BookUpdateSchema.optional(),
});
export type UpdateLibraryEntry = z.infer<typeof UpdateLibraryEntrySchema>;

export const SoftDeleteResponseSchema = z.object({
  id: UUIDv4Schema,
  deletedAt: IsoUtcTimestampSchema,
});
export type SoftDeleteResponse = z.infer<typeof SoftDeleteResponseSchema>;
