import {
  MetadataSearchQuerySchema,
  normalizeIsbn,
} from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MetadataAggregator } from '../metadata/aggregator.js';
import { AppError } from '../plugins/error-handler.js';

const IsbnParamsSchema = z.object({
  isbn: z.string().trim().min(1, 'ISBN ist erforderlich.').max(32),
});

export function registerMetadataRoutes(
  app: FastifyInstance,
  aggregator: MetadataAggregator
): void {
  app.get('/api/metadata/isbn/:isbn', async (request, reply) => {
    const { isbn } = IsbnParamsSchema.parse(request.params);
    const normalized = normalizeIsbn(isbn);

    if (!normalized.valid || normalized.isbn13 === null) {
      throw new AppError(
        400,
        'INVALID_ISBN',
        'Ungültige ISBN-10 oder ISBN-13.',
        {
          fieldErrors: {
            isbn: ['Ungültige ISBN-Prüfziffer oder ungültiges Format.'],
          },
        }
      );
    }

    const result = await aggregator.lookupByIsbn(
      normalized.isbn13,
      normalized.isbn10
    );
    return reply.status(200).send(result);
  });

  app.get('/api/metadata/search', async (request, reply) => {
    const query = MetadataSearchQuerySchema.parse(request.query ?? {});
    const result = await aggregator.search(query.q, query.limit);
    return reply.status(200).send(result);
  });

  app.get('/api/metadata/providers', async (_request, reply) => {
    const info = aggregator.getProvidersInfo();
    return reply.status(200).send(info);
  });
}
