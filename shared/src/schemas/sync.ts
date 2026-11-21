import { z } from 'zod';
import { BookSchema } from './book.js';
import { IsoUtcTimestampSchema, UUIDv4Schema } from './common.js';
import { UserBookSchema } from './user-book.js';

export const SyncBookPayloadSchema = BookSchema;
export type SyncBookPayload = z.infer<typeof SyncBookPayloadSchema>;

export const SyncUserBookPushSchema = UserBookSchema.omit({ userId: true });
export type SyncUserBookPush = z.infer<typeof SyncUserBookPushSchema>;

export const SyncRequestSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  cursor: z.string().nullable().default(null),
  clientTime: IsoUtcTimestampSchema,
  limit: z.number().int().min(1).max(500).default(100),
  changes: z
    .object({
      books: z.array(SyncBookPayloadSchema).default([]),
      userBooks: z.array(SyncUserBookPushSchema).default([]),
    })
    .default({ books: [], userBooks: [] }),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncPushResultStatusSchema = z.enum([
  'accepted',
  'conflict_server_won',
  'rejected',
]);
export type SyncPushResultStatus = z.infer<typeof SyncPushResultStatusSchema>;

export const SyncPushResultItemSchema = z.object({
  id: UUIDv4Schema,
  status: SyncPushResultStatusSchema,
  reason: z.string().optional(),
});
export type SyncPushResultItem = z.infer<typeof SyncPushResultItemSchema>;

export const SyncResponseSchema = z.object({
  serverTime: IsoUtcTimestampSchema,
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  clockSkewMs: z.number().int(),
  clockSkewWarning: z.boolean(),
  pushResults: z.object({
    books: z.array(SyncPushResultItemSchema),
    userBooks: z.array(SyncPushResultItemSchema),
  }),
  pull: z.object({
    books: z.array(BookSchema),
    userBooks: z.array(UserBookSchema),
  }),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;
