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
  deviceName: z.string().trim().min(1).max(128).nullable().optional(),
  cursor: z.string().nullable().default(null),
  clientTime: IsoUtcTimestampSchema,
  limit: z.number().int().min(1).max(500).default(100),
  changes: z
    .object({
      books: z.array(SyncBookPayloadSchema).max(500).default([]),
      userBooks: z.array(SyncUserBookPushSchema).max(500).default([]),
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

export const WebSyncOverallStatusSchema = z.enum([
  'synced',
  'server_ahead',
  'never_synced',
  'no_mobile_device',
]);
export type WebSyncOverallStatus = z.infer<typeof WebSyncOverallStatusSchema>;

export const SyncDeviceStatusSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string().nullable(),
  lastSyncAt: IsoUtcTimestampSchema.nullable(),
  lastSyncCompleted: z.boolean(),
  isUpToDate: z.boolean(),
  pendingServerChanges: z.number().int().min(0),
  lastPushedCount: z.number().int().min(0),
  lastPulledCount: z.number().int().min(0),
  clockSkewWarning: z.boolean(),
  sessionActive: z.boolean(),
});
export type SyncDeviceStatus = z.infer<typeof SyncDeviceStatusSchema>;

export const SyncStatusResponseSchema = z.object({
  status: WebSyncOverallStatusSchema,
  serverTime: IsoUtcTimestampSchema,
  totalBooks: z.number().int().min(0),
  deletedBooks: z.number().int().min(0),
  libraryLastModifiedAt: IsoUtcTimestampSchema.nullable(),
  pendingForMobileCount: z.number().int().min(0),
  devices: z.array(SyncDeviceStatusSchema),
});
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;

export const SyncDeviceIdParamSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
});
export type SyncDeviceIdParam = z.infer<typeof SyncDeviceIdParamSchema>;
