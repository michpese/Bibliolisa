import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerEnv } from './config/env.js';
import { createDatabase, type DatabaseContext } from './db/client.js';
import { MetadataAggregator } from './metadata/aggregator.js';
import { GoogleBooksAdapter } from './metadata/google-books.adapter.js';
import { HardcoverAdapter } from './metadata/hardcover.adapter.js';
import { OpenLibraryAdapter } from './metadata/openlibrary.adapter.js';
import type { FetchLike, MetadataProvider } from './metadata/types.js';
import { registerAuthGuard } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoverRoutes } from './routes/covers.js';
import { registerExportRoutes } from './routes/export.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { registerRecommendationRoutes } from './routes/recommendations.js';
import { registerSyncRoutes } from './routes/sync.js';
import { AuthService } from './services/auth.service.js';
import { CoverService, type DnsLookupFn } from './services/cover.service.js';
import { ExportService } from './services/export.service.js';
import { LibraryService } from './services/library.service.js';
import { SyncService } from './services/sync.service.js';

export const SERVER_VERSION = '0.1.0';

export interface BuildAppOptions {
  env: ServerEnv;
  dbCtx?: DatabaseContext;
  dbPath?: string;
  now?: () => Date;
  authRateLimitMax?: number;
  logger?: boolean;
  metadataProviders?: MetadataProvider[];
  metadataTimeoutMs?: number;
  metadataFetch?: FetchLike;
  coverFetch?: FetchLike;
  coverDnsLookup?: DnsLookupFn;
}

export interface BuiltApp {
  app: FastifyInstance;
  dbCtx: DatabaseContext;
  authService: AuthService;
  libraryService: LibraryService;
  metadataAggregator: MetadataAggregator;
  coverService: CoverService;
  syncService: SyncService;
  exportService: ExportService;
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
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
    },
  });

  registerErrorHandler(app);

  const authService = new AuthService({
    dbCtx,
    jwtSecret: env.JWT_SECRET,
    allowRegistration: env.ALLOW_REGISTRATION,
    now: options.now,
  });

  const libraryService = new LibraryService(dbCtx, options.now);

  const metadataAggregator = new MetadataAggregator({
    providers: options.metadataProviders ?? [
      new HardcoverAdapter({
        apiKey: env.HARDCOVER_API_KEY,
        fetchImpl: options.metadataFetch,
      }),
      new GoogleBooksAdapter({
        apiKey: env.GOOGLE_BOOKS_API_KEY,
        fetchImpl: options.metadataFetch,
      }),
      new OpenLibraryAdapter({
        fetchImpl: options.metadataFetch,
      }),
    ],
    timeoutMs: options.metadataTimeoutMs,
    now: options.now,
  });

  const coverService = new CoverService({
    dbCtx,
    now: options.now,
    fetchImpl: options.coverFetch,
    dnsLookup: options.coverDnsLookup,
  });

  const syncService = new SyncService(dbCtx, options.now);
  const exportService = new ExportService(dbCtx, libraryService, options.now);

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
  registerLibraryRoutes(app, libraryService, coverService);
  registerMetadataRoutes(app, metadataAggregator);
  registerCoverRoutes(app, coverService);
  registerSyncRoutes(app, syncService);
  registerRecommendationRoutes(app, libraryService, options.now);
  registerExportRoutes(app, exportService);

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
    metadataAggregator,
    coverService,
    syncService,
    exportService,
  };
}
