import type { UserRole } from '@bibliolisa/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MEDIA_COOKIE_NAME } from '../routes/auth.js';
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

function isCoverReadRoute(method: string, pathname: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    pathname.startsWith('/api/covers/')
  );
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

    const method = request.method.toUpperCase();
    if (isPublicApiRoute(method, rawPathname)) {
      return;
    }

    const token = extractBearerToken(request);
    if (token) {
      const claims = await authService.verifyAccessToken(token);
      request.user = {
        id: claims.sub,
        username: claims.username,
        role: claims.role,
      };
      return;
    }

    if (isCoverReadRoute(method, rawPathname)) {
      const mediaToken = request.cookies?.[MEDIA_COOKIE_NAME];
      if (mediaToken) {
        const claims = await authService.verifyMediaToken(mediaToken);
        request.user = {
          id: claims.sub,
          username: '',
          role: 'user',
        };
        return;
      }
    }

    throw new AppError(
      401,
      'UNAUTHORIZED',
      'Authentifizierung erforderlich.'
    );
  });
}
