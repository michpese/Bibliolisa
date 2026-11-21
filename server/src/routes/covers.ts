import {
  FetchBookCoverRequestSchema,
  UUIDv4Schema,
} from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../plugins/error-handler.js';
import type { CoverService } from '../services/cover.service.js';

const BookParamsSchema = z.object({
  bookId: UUIDv4Schema,
});

const CoverParamsSchema = z.object({
  coverKey: z.string(),
});

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export function registerCoverRoutes(
  app: FastifyInstance,
  coverService: CoverService
): void {
  app.get('/api/covers/:coverKey', async (request, reply) => {
    const { coverKey } = CoverParamsSchema.parse(request.params);
    const buffer = await coverService.readCoverFile(coverKey);

    return reply
      .status(200)
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=604800, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  });

  app.post('/api/books/:bookId/cover', async (request, reply) => {
    const { bookId } = BookParamsSchema.parse(request.params);

    if (!request.isMultipart()) {
      throw new AppError(
        400,
        'MULTIPART_REQUIRED',
        'Es wird ein Multipart-Datei-Upload erwartet.'
      );
    }

    const file = await request.file();
    if (!file) {
      throw new AppError(
        400,
        'FILE_REQUIRED',
        'Keine Bilddatei im Upload gefunden.'
      );
    }

    const mime = file.mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) {
      await file.toBuffer().catch(() => undefined);
      throw new AppError(
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        'Nur JPEG-, PNG- und WebP-Dateien sind als Cover erlaubt.'
      );
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      throw new AppError(
        413,
        'COVER_TOO_LARGE',
        'Hochgeladene Datei überschreitet das Limit von 5 MB.'
      );
    }

    const result = await coverService.processAndStoreUpload(
      request.user.id,
      bookId,
      buffer
    );
    return reply.status(200).send(result);
  });

  app.post('/api/books/:bookId/cover/fetch', async (request, reply) => {
    const { bookId } = BookParamsSchema.parse(request.params);
    const body = FetchBookCoverRequestSchema.parse(request.body ?? {});

    const result = await coverService.fetchAndStoreForBook(
      request.user.id,
      bookId,
      body.url
    );
    return reply.status(200).send(result);
  });
}
