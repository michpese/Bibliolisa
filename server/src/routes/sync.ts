import { SyncDeviceIdParamSchema, SyncRequestSchema } from '@bibliolisa/shared';
import type { FastifyInstance } from 'fastify';
import type { SyncService } from '../services/sync.service.js';

export function registerSyncRoutes(
  app: FastifyInstance,
  syncService: SyncService
): void {
  app.post('/api/sync', async (request, reply) => {
    const body = SyncRequestSchema.parse(request.body ?? {});
    const result = syncService.sync(request.user.id, body);
    return reply.status(200).send(result);
  });

  app.get('/api/sync/status', async (request, reply) => {
    const status = syncService.getSyncStatus(request.user.id);
    return reply.status(200).send(status);
  });

  app.delete('/api/sync/devices/:deviceId', async (request, reply) => {
    const { deviceId } = SyncDeviceIdParamSchema.parse(request.params);
    syncService.removeSyncDevice(request.user.id, deviceId);
    return reply.status(204).send();
  });
}
