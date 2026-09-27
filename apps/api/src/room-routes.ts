/**
 * #163 — the reader's Idea Rooms (ADR-0045), in their own module. A place's live rooms come with
 * `GET /v1/atlas`.
 *
 *   GET  /v1/rooms/:roomId              one room: question, state, inhabitants, chronicle with evidence
 *   GET  /v1/rooms/deltas/:deltaId      one change and its evidence
 *   POST /v1/rooms/:roomId/set-aside    {clientRequestId, expectedPrivacyEpoch} -> the atlas
 *
 * Nothing here calls a model, and no source is ever returned.
 */
import type { FastifyInstance } from 'fastify';
import { uuid } from '../../../packages/contracts/src/index.ts';
import { readAtlas } from '../../../packages/db/src/atlas.ts';
import { readRoom, readRoomDelta, setRoomAside } from '../../../packages/db/src/rooms.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

export function registerRoomRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get<{ Params: { roomId: string } }>('/v1/rooms/:roomId', async (req, reply) => {
    const room = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.roomId).success) throw new HttpError(400, 'Invalid room id');
      return readRoom(client, scope.universeId, req.params.roomId);
    });
    return reply.header('Cache-Control', 'no-store').send(room);
  });

  app.get<{ Params: { deltaId: string } }>('/v1/rooms/deltas/:deltaId', async (req, reply) => {
    const delta = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.deltaId).success) throw new HttpError(400, 'Invalid delta id');
      return readRoomDelta(client, scope.universeId, req.params.deltaId);
    });
    return reply.header('Cache-Control', 'no-store').send(delta);
  });

  app.post<{ Params: { roomId: string } }>('/v1/rooms/:roomId/set-aside', async (req, reply) => {
    const atlas = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.roomId).success) throw new HttpError(400, 'Invalid room id');
      await setRoomAside(client, scope, req.params.roomId, req.body);
      return readAtlas(client, scope.universeId);
    });
    return reply.header('Cache-Control', 'no-store').send(atlas);
  });
}
