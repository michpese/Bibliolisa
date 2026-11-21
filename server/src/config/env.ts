import { z } from 'zod';

function parseBooleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
    }
    return value;
  }, z.boolean());
}

function optionalNonEmptyString() {
  return z.preprocess((value) => {
    if (typeof value === 'string' && value.trim() === '') {
      return undefined;
    }
    return value;
  }, z.string().trim().min(1).optional());
}

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  DATA_DIR: z.string().trim().min(1).default('/data'),
  WEB_DIR: optionalNonEmptyString(),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET muss mindestens 32 Zeichen lang sein.'),
  TRUST_PROXY: parseBooleanEnv(true),
  ALLOW_REGISTRATION: parseBooleanEnv(true),
  HARDCOVER_API_KEY: optionalNonEmptyString(),
  GOOGLE_BOOKS_API_KEY: optionalNonEmptyString(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

export function parseEnv(
  source: Record<string, string | undefined> = process.env
): ServerEnv {
  return EnvSchema.parse(source);
}
