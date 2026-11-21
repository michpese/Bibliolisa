import { z } from 'zod';
import {
  ClientTypeSchema,
  IsoUtcTimestampSchema,
  UUIDv4Schema,
  UserRoleSchema,
} from './common.js';

export const UsernameSchema = z
  .string()
  .trim()
  .min(3, 'Benutzername muss mindestens 3 Zeichen lang sein.')
  .max(40, 'Benutzername darf maximal 40 Zeichen lang sein.')
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    'Benutzername darf nur Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche enthalten.'
  );

export const PasswordSchema = z
  .string()
  .min(8, 'Passwort muss mindestens 8 Zeichen lang sein.')
  .max(128, 'Passwort darf maximal 128 Zeichen lang sein.');

export const AuthUserSchema = z.object({
  id: UUIDv4Schema,
  username: z.string(),
  displayName: z.string().nullable(),
  email: z.string().email().nullable(),
  role: UserRoleSchema,
  createdAt: IsoUtcTimestampSchema,
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(80).nullable().optional(),
  email: z.string().trim().email('Ungültige E-Mail-Adresse.').max(255).nullable().optional(),
  clientType: ClientTypeSchema.default('web'),
  deviceId: z.string().trim().min(1).max(128).nullable().optional(),
  deviceName: z.string().trim().min(1).max(128).nullable().optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1, 'Benutzername ist erforderlich.').max(40),
  password: z.string().min(1, 'Passwort ist erforderlich.').max(128),
  clientType: ClientTypeSchema.default('web'),
  deviceId: z.string().trim().min(1).max(128).nullable().optional(),
  deviceName: z.string().trim().min(1).max(128).nullable().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  clientType: ClientTypeSchema.optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const AuthTokenResponseSchema = z.object({
  user: AuthUserSchema,
  accessToken: z.string(),
  accessTokenExpiresAt: IsoUtcTimestampSchema,
  refreshToken: z.string().optional(),
});
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

export const SessionInfoSchema = z.object({
  id: UUIDv4Schema,
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  clientType: ClientTypeSchema,
  lastUsedAt: IsoUtcTimestampSchema.nullable(),
  expiresAt: IsoUtcTimestampSchema,
  createdAt: IsoUtcTimestampSchema,
  isCurrent: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionInfoSchema),
});
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Aktuelles Passwort ist erforderlich.').max(128),
  newPassword: PasswordSchema,
  revokeOtherSessions: z.boolean().default(true),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
