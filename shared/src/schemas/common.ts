import { z } from 'zod';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UUIDv4Schema = z
  .string()
  .regex(UUID_V4_REGEX, 'Ungültige UUIDv4-Kennung.');

/**
 * Formatiert ein Date-Objekt oder einen gültigen ISO-Zeitstempel in das kanonische
 * SQLite-Sortierformat `YYYY-MM-DDTHH:mm:ss.sssZ`.
 */
export function toCanonicalIsoUtc(input: Date | string = new Date()): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Ungültiger Zeitstempel: ${String(input)}`);
  }
  return date.toISOString();
}

export const IsoUtcTimestampSchema = z
  .string()
  .datetime({ offset: true, message: 'Zeitstempel muss gültiges ISO-8601-Format besitzen.' })
  .transform((value) => toCanonicalIsoUtc(value));

export const ReadingStatusSchema = z.enum(['unread', 'reading', 'read', 'abandoned']);
export type ReadingStatus = z.infer<typeof ReadingStatusSchema>;

export const UserRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const ClientTypeSchema = z.enum(['web', 'mobile']);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const MetadataSourceSchema = z.enum([
  'manual',
  'openlibrary',
  'google_books',
  'hardcover',
]);
export type MetadataSource = z.infer<typeof MetadataSourceSchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const ApiErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const ApiErrorResponseSchema = z.object({
  error: ApiErrorBodySchema,
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const HealthProvidersSchema = z.object({
  openLibrary: z.boolean(),
  googleBooks: z.boolean(),
  hardcover: z.boolean(),
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  serverTime: IsoUtcTimestampSchema,
  allowRegistration: z.boolean(),
  providers: HealthProvidersSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
