import type { FastifyInstance } from 'fastify';
import type { ExportService } from '../services/export.service.js';

export function registerExportRoutes(
  app: FastifyInstance,
  exportService: ExportService
): void {
  app.get('/api/export/json', async (request, reply) => {
    const { filename, payload } = exportService.exportJson(request.user.id);
    return reply
      .status(200)
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(payload);
  });

  app.get('/api/export/csv', async (request, reply) => {
    const { filename, csv } = exportService.exportCsv(request.user.id);
    return reply
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  app.post(
    '/api/import/json',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      const result = exportService.importJson(
        request.user.id,
        request.body ?? {}
      );
      return reply.status(200).send(result);
    }
  );
}
