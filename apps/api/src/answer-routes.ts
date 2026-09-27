/**
 * #132 — Ask answers (ADR-0033): the reader's explicit request, its state, and cancellation.
 *
 *   POST /v1/asks/:askId/answer          fresh authority for one answer (202), exact retry replays
 *   GET  /v1/asks/:askId/answer          queued | running | answered | not_in_source | rejected | failed | cancelled | unavailable
 *   POST /v1/asks/:askId/answer/cancel   withdraw an answer that has not started
 *
 * The API never calls a provider; the worker does (apps/worker/src/reasoning/answer-worker.ts).
 */
import type { FastifyInstance } from 'fastify';
import { AskAnswerError, cancelAskAnswer, readAskAnswer, requestAskAnswer } from '../../../packages/db/src/reasoning-answers.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

const http = (error: unknown): never => {
  if (error instanceof AskAnswerError) throw new HttpError(error.statusCode, error.message);
  throw error;
};

export function registerAnswerRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.post<{ Params: { askId: string } }>('/v1/asks/:askId/answer', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => requestAskAnswer(client, scope, req.params.askId, req.body).catch(http));
    return reply.code(202).send(result);
  });
  app.get<{ Params: { askId: string } }>('/v1/asks/:askId/answer', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const view = await readAskAnswer(client, scope, req.params.askId);
      if (!view) throw new HttpError(404, 'No answer was requested for this Ask');
      return view;
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post<{ Params: { askId: string } }>('/v1/asks/:askId/answer/cancel', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => cancelAskAnswer(client, scope, req.params.askId, req.body).catch(http));
    return reply.code(200).send(result);
  });
}
