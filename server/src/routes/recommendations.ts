import {
  generateRecommendations,
  RecommendationQuerySchema,
} from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import type { LibraryService } from '../services/library.service.js';

export function registerRecommendationRoutes(
  app: FastifyInstance,
  libraryService: LibraryService,
  now: () => Date = () => new Date()
): void {
  app.get('/api/recommendations', async (request, reply) => {
    const query = RecommendationQuerySchema.parse(request.query ?? {});
    const entries = libraryService.listAllActiveForUser(request.user.id);
    const result = generateRecommendations(entries, {
      seed: query.seed,
      limitPerCategory: query.limitPerCategory,
      now: now(),
      includeEntry: true,
    });
    return reply.status(200).send(result);
  });
}
