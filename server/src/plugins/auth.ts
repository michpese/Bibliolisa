import type { UserRole } from '@bibliolisa/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../services/auth.service.js';
import { AppError } from './error-handler.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

function isPublicApiRoute(method: string, pathname: string): boolean {
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') {
    return true;
  }

  if (method === 'POST') {
    return (
      pathname === '/api/auth/register' ||
      pathname === '/api/auth/login' ||
      pathname === '/api/auth/refresh'
    );
  }

  return false;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function registerAuthGuard(
  app: FastifyInstance,
  authService: AuthService
): void {
  app.addHook('onRequest', async (request) => {
    const rawPathname = request.url.split('?')[0] ?? request.url;
    const isApiRequest =
      rawPathname === '/api' || rawPathname.startsWith('/api/');

    if (!isApiRequest) {
      return;
    }

    if (isPublicApiRoute(request.method.toUpperCase(), rawPathname)) {
      return;
    }

    const token = extractBearerToken(request);
    if (!token) {
      throw new AppError(
        401,
        'UNAUTHORIZED',
        'Authentifizierung erforderlich.'
      );
    }

    const claims = await authService.verifyAccessToken(token);
    request.user = {
      id: claims.sub,
      username: claims.username,
      role: claims.role,
    };
  });
}
