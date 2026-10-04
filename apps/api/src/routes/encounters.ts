/** Exposures, Keeps, the reader's world system and one ledger event (ADR-0004, ADR-0028). */

import { exposureInput, interactionInput } from '@knowscroll/contracts';
import {
  readLedgerEvent,
  recordExposure,
  recordKeep,
} from '@knowscroll/db/encounters';
import { readWorldSystem, SHARED_SOURCE_V1 } from '@knowscroll/db/worlds';
import type { FastifyInstance } from 'fastify';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput, requireUuid } from '../http/input.ts';

export function registerEncounterRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.post('/v1/exposures', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const body = parseInput(exposureInput, req.body, 'Invalid exposure');
        return recordExposure(client, scope, body);
      },
    );
    return reply.code(201).send(result);
  });

  app.get('/v1/worlds', async (req) =>
    authenticated(req.headers.authorization, async (scope, client) => {
      const system = await readWorldSystem(client, scope.universeId);
      return { derivationMethod: SHARED_SOURCE_V1, system };
    }),
  );

  app.post('/v1/interactions', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const body = parseInput(
          interactionInput,
          req.body,
          'Invalid interaction',
        );
        return recordKeep(client, scope, body);
      },
    );
    return reply.code(202).send(result);
  });
}

export function registerEventRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.get<{ Params: { eventId: string } }>(
    '/v1/events/:eventId',
    async (req) => {
      return authenticated(req.headers.authorization, async (scope, client) => {
        requireUuid(req.params.eventId, 'Invalid event ID');
        const row = await readLedgerEvent(client, scope, req.params.eventId);
        if (!row) throw new HttpError(404, 'Event not found');
        return row;
      });
    },
  );
}
