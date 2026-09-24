/**
 * #133 — "Why this appeared" and the reader's correction (ADR-0032 §5), in their own module.
 *
 *   GET  /v1/decisions/:decisionId/why?assetId=   the recorded reason, family and evidence path
 *   POST /v1/encounters/feedback                  less_like_this | wrong_connection
 */
import type { FastifyInstance } from 'fastify';
import { uuid } from '../../../packages/contracts/src/index.ts';
import { readWhy } from '../../../packages/db/src/composer/semantic.ts';
import { recordEncounterFeedback } from '../../../packages/db/src/composer/feedback.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

export function registerComposerRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get<{ Params: { decisionId: string }; Querystring: { assetId?: string } }>('/v1/decisions/:decisionId/why', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.decisionId).success || !uuid.safeParse(req.query.assetId).success) throw new HttpError(400, 'Invalid why request');
      const why = await readWhy(client, scope, req.params.decisionId, req.query.assetId!);
      if (!why) throw new HttpError(404, 'No recorded explanation for this encounter');
      return why;
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.post('/v1/encounters/feedback', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => recordEncounterFeedback(client, scope, req.body));
    return reply.code(201).send(result);
  });
}
