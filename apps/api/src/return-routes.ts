/**
 * #134/#165 — the return and Relics (ADR-0039, ADR-0044).
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
import { uuid } from '../../../packages/contracts/src/index.ts';
import { acknowledgeAway, readAway, ReturnError } from '../../../packages/db/src/away.ts';
import { keepRelic, listRelics, readPassages, recordObjection, releaseRelic } from '../../../packages/db/src/relics.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

const http = (error: unknown): never => {
  if (error instanceof ReturnError) throw new HttpError(error.statusCode, error.message);
  throw error;
};

type Paged = { Querystring: { page?: string } };

export function registerReturnRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get<Paged>('/v1/away', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => readAway(client, scope, req.query.page).catch(http));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post('/v1/away/acknowledge', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => acknowledgeAway(client, scope, req.body).catch(http));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.get<Paged>('/v1/relics', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => listRelics(client, scope, req.query.page).catch(http));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post('/v1/relics', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => keepRelic(client, scope, req.body).catch(http));
    return reply.code(result.created ? 201 : 200).header('Cache-Control', 'no-store').send(result.body);
  });
  app.post<{ Params: { relicId: string } }>('/v1/relics/:relicId/release', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => {
      if (!uuid.safeParse(req.params.relicId).success) throw new HttpError(400, 'Invalid Relic ID');
      return releaseRelic(client, scope, req.params.relicId, req.body).catch(http);
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post('/v1/objections', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => recordObjection(client, scope, req.body).catch(http));
    return reply.code(result.created ? 201 : 200).header('Cache-Control', 'no-store').send(result.body);
  });
  app.get<{ Params: { assetId: string } }>('/v1/scrolls/:assetId/passages', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => {
      if (!uuid.safeParse(req.params.assetId).success) throw new HttpError(400, 'Invalid Scroll ID');
      return readPassages(client, scope, req.params.assetId).catch(http);
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
