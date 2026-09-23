/**
 * #131 — HTTP for the semantic substrate's personal consumers. Kept in its own module (like
 * `sign-in-routes.ts`) so `app.ts` only wires it in.
 *
 *   GET  /v1/assets/:assetId/branches   live continuations along admitted, non-suppressed bridges
 *   POST /v1/branches                   take one (explicit request; re-checked under the locks)
 *   POST /v1/connections/feedback       "not useful" / "seems wrong": personal suppression only
 *
 * Every route runs inside the caller's authenticated transaction with the universe lock held.
 * Corrections to shared knowledge are an operator tool (scripts/substrate/correct-source.ts), not
 * an HTTP route: a person's objection never retracts a source-backed claim for everyone.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { uuid } from '../../../packages/contracts/src/index.ts';
import type { AuthScope } from '../../../packages/db/src/index.ts';
import { listEncounterBranches, openBranch, recordConnectionFeedback } from '../../../packages/db/src/semantic/branches.ts';
import { HttpError } from './errors.ts';

export type Authenticated = <T>(authorization: string | undefined, fn: (scope: AuthScope, client: pg.PoolClient) => Promise<T>) => Promise<T>;

export function registerSemanticRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get<{ Params: { assetId: string } }>('/v1/assets/:assetId/branches', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.assetId).success) throw new HttpError(400, 'Invalid asset ID');
      return listEncounterBranches(client, scope, req.params.assetId);
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.post('/v1/branches', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => openBranch(client, scope, req.body));
    return reply.code(201).send(result);
  });

  app.post('/v1/connections/feedback', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => recordConnectionFeedback(client, scope, req.body));
    return reply.code(201).send(result);
  });
}
