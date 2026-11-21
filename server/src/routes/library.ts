import {
  CreateLibraryEntrySchema,
  LibraryQuerySchema,
  UpdateLibraryEntrySchema,
  UUIDv4Schema,
} from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoverService } from '../services/cover.service.js';
import type { LibraryService } from '../services/library.service.js';

const UserBookParamsSchema = z.object({
  userBookId: UUIDv4Schema,
});

export function registerLibraryRoutes(
  app: FastifyInstance,
  libraryService: LibraryService,
  coverService?: CoverService
): void {
  app.get('/api/library', async (request, reply) => {
    const query = LibraryQuerySchema.parse(request.query ?? {});
    const result = libraryService.list(request.user.id, query);
    return reply.status(200).send(result);
  });

  app.get('/api/library/facets', async (request, reply) => {
    const facets = libraryService.getFacets(request.user.id);
    return reply.status(200).send(facets);
  });

  app.get('/api/library/:userBookId', async (request, reply) => {
    const { userBookId } = UserBookParamsSchema.parse(request.params);
    const entry = libraryService.getById(request.user.id, userBookId);
    return reply.status(200).send(entry);
  });

  app.post('/api/library', async (request, reply) => {
    const body = CreateLibraryEntrySchema.parse(request.body ?? {});
    const created = libraryService.create(request.user.id, body);

    if (
      coverService &&
      created.book.coverSourceUrl &&
      !created.book.coverKey
    ) {
      try {
        await coverService.fetchAndStoreForBook(
          request.user.id,
          created.bookId,
          created.book.coverSourceUrl
        );
        const refreshed = libraryService.getById(request.user.id, created.id);
        return reply.status(201).send(refreshed);
      } catch (error) {
        request.log.warn(
          { err: error, bookId: created.bookId },
          'Best-Effort Cover-Download bei Buchanlage fehlgeschlagen'
        );
      }
    }

    return reply.status(201).send(created);
  });

  app.patch('/api/library/:userBookId', async (request, reply) => {
    const { userBookId } = UserBookParamsSchema.parse(request.params);
    const body = UpdateLibraryEntrySchema.parse(request.body ?? {});
    const updated = libraryService.update(request.user.id, userBookId, body);
    return reply.status(200).send(updated);
  });

  app.delete('/api/library/:userBookId', async (request, reply) => {
    const { userBookId } = UserBookParamsSchema.parse(request.params);
    const deleted = libraryService.softDelete(request.user.id, userBookId);
    return reply.status(200).send(deleted);
  });

  app.post('/api/library/:userBookId/restore', async (request, reply) => {
    const { userBookId } = UserBookParamsSchema.parse(request.params);
    const restored = libraryService.restore(request.user.id, userBookId);
    return reply.status(200).send(restored);
  });
}
