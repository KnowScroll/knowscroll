/**
 * #134 — the return and Relics (ADR-0039).
 *
 *   GET  /v1/away                        what changed that the reader did not cause, since their marker
 *   POST /v1/away/acknowledge            {clientRequestId, expectedPrivacyEpoch, through} -> {privacyEpoch, since}
 *   GET  /v1/relics                      this epoch's Relics, each with its derived state
 *   POST /v1/relics                      {clientRequestId, expectedPrivacyEpoch, kind:'connection', bridgeId} -> 201 | 200 (already kept)
 *   POST /v1/relics/:relicId/release     {expectedPrivacyEpoch} -> {privacyEpoch, relicId, released}
 *
 * Nothing here calls a provider. "Seems wrong" is the existing POST /v1/connections/feedback.
 */
import type { FastifyInstance } from 'fastify';
import { uuid } from '../../../packages/contracts/src/index.ts';
import { acknowledgeAway, readAway, ReturnError } from '../../../packages/db/src/away.ts';
import { keepRelic, listRelics, releaseRelic } from '../../../packages/db/src/relics.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

const http = (error: unknown): never => {
  if (error instanceof ReturnError) throw new HttpError(error.statusCode, error.message);
  throw error;
};

export function registerReturnRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get('/v1/away', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => readAway(client, scope));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post('/v1/away/acknowledge', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => acknowledgeAway(client, scope, req.body).catch(http));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.get('/v1/relics', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => listRelics(client, scope));
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
}
