import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerEnv } from './config/env.js';
import { createDatabase, type DatabaseContext } from './db/client.js';
import { registerAuthGuard } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLibraryRoutes } from './routes/library.js';
import { AuthService } from './services/auth.service.js';
import { LibraryService } from './services/library.service.js';

export const SERVER_VERSION = '0.1.0';

export interface BuildAppOptions {
  env: ServerEnv;
  dbCtx?: DatabaseContext;
  dbPath?: string;
  now?: () => Date;
  authRateLimitMax?: number;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  dbCtx: DatabaseContext;
  authService: AuthService;
  libraryService: LibraryService;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { env } = options;
  const ownsDb = options.dbCtx === undefined;
  const dbCtx =
    options.dbCtx ??
    createDatabase({
      dataDir: env.DATA_DIR,
      dbPath: options.dbPath,
    });

  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    logger:
      options.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
          },
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
  });

  registerErrorHandler(app);

  const authService = new AuthService({
    dbCtx,
    jwtSecret: env.JWT_SECRET,
    allowRegistration: env.ALLOW_REGISTRATION,
    now: options.now,
  });

  const libraryService = new LibraryService(dbCtx, options.now);

  registerAuthGuard(app, authService);

  registerHealthRoutes(app, {
    dbCtx,
    authService,
    env,
    version: SERVER_VERSION,
    now: options.now,
  });
  registerAuthRoutes(app, authService, {
    rateLimitMax: options.authRateLimitMax,
  });
  registerLibraryRoutes(app, libraryService);

  if (ownsDb) {
    app.addHook('onClose', async () => {
      dbCtx.checkpointAndClose();
    });
  }

  return {
    app,
    dbCtx,
    authService,
    libraryService,
  };
}
