import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }

    if (error instanceof ZodError) {
      const flattened = error.flatten();
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Ungültige Eingabedaten.',
          details: {
            fieldErrors: flattened.fieldErrors,
            formErrors: flattened.formErrors,
          },
        },
      });
    }

    const fastifyErr = error as {
      statusCode?: number;
      code?: string;
      message?: string;
    };

    if (fastifyErr.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
        },
      });
    }

    if (fastifyErr.statusCode !== undefined && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? 'BAD_REQUEST',
          message: fastifyErr.message ?? 'Ungültige Anfrage.',
        },
      });
    }

    request.log.error({ err: error }, 'Unbehandelter Serverfehler');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Ein interner Serverfehler ist aufgetreten.',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpunkt nicht gefunden.',
      },
    });
  });
}
