import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  UUIDv4Schema,
} from '@bibliolisa/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../plugins/error-handler.js';
import {
  AuthService,
  MEDIA_TOKEN_TTL_SECONDS,
  WEB_REFRESH_TTL_SECONDS,
  type IssuedAuthBundle,
} from '../services/auth.service.js';

export const REFRESH_COOKIE_NAME = 'bibliolisa_refresh';
export const MEDIA_COOKIE_NAME = 'bibliolisa_media';

function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

function setWebAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  bundle: IssuedAuthBundle
): void {
  if (bundle.clientType !== 'web') {
    return;
  }

  const secure = isSecureRequest(request);

  reply.setCookie(REFRESH_COOKIE_NAME, bundle.refreshToken, {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: WEB_REFRESH_TTL_SECONDS,
  });

  if (bundle.mediaToken !== null) {
    reply.setCookie(MEDIA_COOKIE_NAME, bundle.mediaToken, {
      path: '/api/covers',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: MEDIA_TOKEN_TTL_SECONDS,
    });
  }
}

function clearWebAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const secure = isSecureRequest(request);

  reply.clearCookie(REFRESH_COOKIE_NAME, {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });

  reply.clearCookie(MEDIA_COOKIE_NAME, {
    path: '/api/covers',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });
}

const SessionParamsSchema = z.object({
  sessionId: UUIDv4Schema,
});

export interface AuthRoutesOptions {
  rateLimitMax?: number;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  options: AuthRoutesOptions = {}
): void {
  const authRateLimit = {
    max: options.rateLimitMax ?? 10,
    timeWindow: '1 minute',
  };
  const refreshRateLimit = {
    max: (options.rateLimitMax ?? 10) * 3,
    timeWindow: '1 minute',
  };

  app.post(
    '/api/auth/register',
    { config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const input = RegisterRequestSchema.parse(request.body ?? {});
      const bundle = await authService.register(input);
      setWebAuthCookies(request, reply, bundle);
      return reply.status(201).send(bundle.response);
    }
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const input = LoginRequestSchema.parse(request.body ?? {});
      const bundle = await authService.login(input);
      setWebAuthCookies(request, reply, bundle);
      return reply.status(200).send(bundle.response);
    }
  );

  app.post(
    '/api/auth/refresh',
    { config: { rateLimit: refreshRateLimit } },
    async (request, reply) => {
    const body = RefreshRequestSchema.parse(request.body ?? {});
    const rawRefreshToken =
      body.refreshToken ?? request.cookies?.[REFRESH_COOKIE_NAME];

    if (!rawRefreshToken) {
      throw new AppError(
        401,
        'UNAUTHORIZED',
        'Kein Refresh Token übergeben.'
      );
    }

    const bundle = await authService.refresh(rawRefreshToken, body.clientType);
    setWebAuthCookies(request, reply, bundle);
    return reply.status(200).send(bundle.response);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const body = LogoutRequestSchema.parse(request.body ?? {});
    const rawRefreshToken =
      body.refreshToken ?? request.cookies?.[REFRESH_COOKIE_NAME];

    authService.logout(request.user.id, rawRefreshToken);
    clearWebAuthCookies(request, reply);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = authService.getMe(request.user.id);
    return reply.status(200).send(user);
  });

  app.get('/api/auth/sessions', async (request, reply) => {
    const currentRefreshToken = request.cookies?.[REFRESH_COOKIE_NAME];
    const headerDeviceId = request.headers['x-device-id'];
    const currentDeviceId =
      typeof headerDeviceId === 'string' && headerDeviceId.trim()
        ? headerDeviceId.trim()
        : undefined;

    const sessions = authService.listSessions(
      request.user.id,
      currentRefreshToken,
      currentDeviceId
    );
    return reply.status(200).send({ sessions });
  });

  app.delete('/api/auth/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = SessionParamsSchema.parse(request.params);
    authService.revokeSession(request.user.id, sessionId);
    return reply.status(204).send();
  });

  app.post(
    '/api/auth/change-password',
    { config: { rateLimit: authRateLimit } },
    async (request, reply) => {
    const body = ChangePasswordRequestSchema.parse(request.body ?? {});
    const currentRefreshToken = request.cookies?.[REFRESH_COOKIE_NAME];
    const headerDeviceId = request.headers['x-device-id'];
    const currentDeviceId =
      typeof headerDeviceId === 'string' && headerDeviceId.trim()
        ? headerDeviceId.trim()
        : undefined;

    await authService.changePassword(
      request.user.id,
      body,
      currentRefreshToken,
      currentDeviceId
    );
    return reply.status(204).send();
  });
}
