/**
 * The reader's Idea Rooms (ADR-0045; #163). A place's live rooms come with `GET /v1/atlas`.
 *
 *   GET  /v1/rooms/:roomId              one room: question, state, inhabitants, chronicle with evidence
 *   GET  /v1/rooms/deltas/:deltaId      one change and its evidence
 *   POST /v1/rooms/:roomId/set-aside    {clientRequestId, expectedPrivacyEpoch} -> the atlas
 *
 * Nothing here calls a model, and no source is ever returned.
 */
import type { FastifyInstance } from 'fastify';
import { readAtlas } from '@knowscroll/db/atlas';
import { readRoom, readRoomDelta, setRoomAside } from '@knowscroll/db/rooms';
import type { Authenticated } from '../http/authenticated.ts';
import { noStore, requireUuid } from '../http/input.ts';

export function registerRoomRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.get<{ Params: { roomId: string } }>(
    '/v1/rooms/:roomId',
    async (req, reply) => {
      const room = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          requireUuid(req.params.roomId, 'Invalid room id');
          return readRoom(client, scope.universeId, req.params.roomId);
        },
      );
      return noStore(reply).send(room);
    },
  );

  app.get<{ Params: { deltaId: string } }>(
    '/v1/rooms/deltas/:deltaId',
    async (req, reply) => {
      const delta = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          requireUuid(req.params.deltaId, 'Invalid delta id');
          return readRoomDelta(client, scope.universeId, req.params.deltaId);
        },
      );
      return noStore(reply).send(delta);
    },
  );

  app.post<{ Params: { roomId: string } }>(
    '/v1/rooms/:roomId/set-aside',
    async (req, reply) => {
      const atlas = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          requireUuid(req.params.roomId, 'Invalid room id');
          await setRoomAside(client, scope, req.params.roomId, req.body);
          return readAtlas(client, scope.universeId);
        },
      );
      return noStore(reply).send(atlas);
    },
  );
}
