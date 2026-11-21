import { buildApp } from './app.js';
import { parseEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const { app, dbCtx, coverService } = await buildApp({ env });

  void coverService.cleanupOrphanCovers().catch((error) => {
    app.log.warn({ err: error }, 'Startup-Bereinigung verwaister Cover fehlgeschlagen.');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'Server wird geordnet heruntergefahren...');
    try {
      await app.close();
      dbCtx.checkpointAndClose();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Fehler beim Herunterfahren.');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });
}

void main().catch((error) => {
  console.error('Bibliolisa Server Start fehlgeschlagen:', error);
  process.exit(1);
});
