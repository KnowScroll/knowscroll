/**
 * #134 — the reader's places (ADR-0036), in their own module.
 *
 *   GET  /v1/atlas                          live places, typed relations between them, chronicle
 *   GET  /v1/atlas/deltas/:deltaId          one change and its evidence
 *   POST /v1/atlas/places/:placeId/reject   the reader sets a planet or region aside
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid } from '../../../packages/contracts/src/index.ts';
import { readAtlas, readAtlasDelta, rejectPlace } from '../../../packages/db/src/atlas.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

const rejectInput = z.object({ expectedPrivacyEpoch: z.number().int().min(0).max(2147483647) }).strict();

export function registerAtlasRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get('/v1/atlas', async (req, reply) => {
    const atlas = await authenticated(req.headers.authorization, (scope, client) => readAtlas(client, scope.universeId));
    return reply.header('Cache-Control', 'no-store').send(atlas);
  });

  app.get<{ Params: { deltaId: string } }>('/v1/atlas/deltas/:deltaId', async (req, reply) => {
    const delta = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.deltaId).success) throw new HttpError(400, 'Invalid delta id');
      return readAtlasDelta(client, scope.universeId, req.params.deltaId);
    });
    return reply.header('Cache-Control', 'no-store').send(delta);
  });

  app.post<{ Params: { placeId: string } }>('/v1/atlas/places/:placeId/reject', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = rejectInput.safeParse(req.body);
      if (!uuid.safeParse(req.params.placeId).success || !parsed.success) throw new HttpError(400, 'Invalid reject request');
      if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch) throw new HttpError(409, 'Privacy epoch changed');
      await rejectPlace(client, scope.universeId, req.params.placeId);
      return readAtlas(client, scope.universeId);
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
