import { toCanonicalIsoUtc, type HealthResponse } from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerEnv } from '../config/env.js';
import type { DatabaseContext } from '../db/client.js';
import type { AuthService } from '../services/auth.service.js';

export interface HealthRouteDeps {
  dbCtx: DatabaseContext;
  authService: AuthService;
  env: ServerEnv;
  version: string;
  now?: () => Date;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRouteDeps
): void {
  const now = deps.now ?? (() => new Date());

  app.get('/api/health', async (_request, reply) => {
    deps.dbCtx.sqlite.prepare('SELECT 1').get();

    const payload: HealthResponse = {
      status: 'ok',
      version: deps.version,
      serverTime: toCanonicalIsoUtc(now()),
      allowRegistration: deps.authService.isRegistrationEffectivelyAllowed(),
      providers: {
        openLibrary: true,
        googleBooks: true,
        hardcover: Boolean(deps.env.HARDCOVER_API_KEY),
      },
    };

    return reply.status(200).send(payload);
  });
}
