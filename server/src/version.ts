import fs from 'node:fs';

export function resolveServerVersion(
  appVersionEnv = process.env.APP_VERSION
): string {
  const envVersion = appVersionEnv?.trim();
  if (envVersion) {
    return envVersion;
  }

  try {
    const raw = fs.readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8'
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback auf Standardversion
  }

  return '0.2.0';
}

export const SERVER_VERSION = resolveServerVersion();
