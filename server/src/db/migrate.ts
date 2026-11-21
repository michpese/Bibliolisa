import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type * as schema from './schema.js';

export function resolveMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, 'migrations'),
    path.resolve(currentDir, '..', '..', 'src', 'db', 'migrations'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }

  throw new Error(
    `SQLite-Migrationsordner nicht gefunden. Geprüfte Pfade: ${candidates.join(', ')}`
  );
}

export function runMigrations(
  db: BetterSQLite3Database<typeof schema>,
  migrationsFolder = resolveMigrationsFolder()
): void {
  migrate(db, { migrationsFolder });
}
