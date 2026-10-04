/**
 * The reader's return (what changed while away) and Relics, objections and passages (ADR-0039, ADR-0044; #134, #165).
 *
 *   GET  /v1/away[?page=]                    what changed that the reader did not cause, since their marker, a page at a time
 *   POST /v1/away/acknowledge                {clientRequestId, expectedPrivacyEpoch, through} -> {privacyEpoch, since}
 *   GET  /v1/relics[?page=]                  this epoch's Relics, each with its derived state, a page at a time
 *   POST /v1/relics                          {clientRequestId, expectedPrivacyEpoch, kind, …the thing} -> 201 | 200 (already kept)
 *   POST /v1/relics/:relicId/release         {expectedPrivacyEpoch} -> {privacyEpoch, relicId, released}
 *   POST /v1/objections                      {clientRequestId, expectedPrivacyEpoch, kind: passage | answer, …} -> 201 | 200 (already made)
 *   GET  /v1/scrolls/:assetId/passages       the Scroll's claims, each with this reader's own state
 *
 * Nothing here calls a provider. "Seems wrong" on a connection is the existing
 * POST /v1/connections/feedback; a place is doubted by setting it aside (POST /v1/atlas/places/:id/reject).
 */
import type { FastifyInstance } from 'fastify';
import { acknowledgeAway, readAway } from '@knowscroll/db/away';
import {
  keepRelic,
  listRelics,
  readPassages,
  recordObjection,
  releaseRelic,
} from '@knowscroll/db/relics';
import type { Authenticated } from '../http/authenticated.ts';
import { noStore, requireUuid } from '../http/input.ts';

type Paged = { Querystring: { page?: string } };

export function registerReturnRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.get<Paged>('/v1/away', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => readAway(client, scope, req.query.page),
    );
    return noStore(reply).send(result);
  });
  app.post('/v1/away/acknowledge', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => acknowledgeAway(client, scope, req.body),
    );
    return noStore(reply).send(result);
  });
  app.get<Paged>('/v1/relics', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => listRelics(client, scope, req.query.page),
    );
    return noStore(reply).send(result);
  });
  app.post('/v1/relics', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => keepRelic(client, scope, req.body),
    );
    return noStore(reply.code(result.created ? 201 : 200)).send(result.body);
  });
  app.post<{ Params: { relicId: string } }>(
    '/v1/relics/:relicId/release',
    async (req, reply) => {
      const result = await authenticated(
        req.headers.authorization,
        (scope, client) => {
          requireUuid(req.params.relicId, 'Invalid Relic ID');
          return releaseRelic(client, scope, req.params.relicId, req.body);
        },
      );
      return noStore(reply).send(result);
    },
  );
  app.post('/v1/objections', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => recordObjection(client, scope, req.body),
    );
    return noStore(reply.code(result.created ? 201 : 200)).send(result.body);
  });
  app.get<{ Params: { assetId: string } }>(
    '/v1/scrolls/:assetId/passages',
    async (req, reply) => {
      const result = await authenticated(
        req.headers.authorization,
        (scope, client) => {
          requireUuid(req.params.assetId, 'Invalid Scroll ID');
          return readPassages(client, scope, req.params.assetId);
        },
      );
      return noStore(reply).send(result);
    },
  );
}
