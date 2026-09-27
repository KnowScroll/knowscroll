/**
 * #164 — the reader's content demands (ADR-0046 §6), in their own module.
 *
 *   GET /v1/inventory   {privacyEpoch, demands[]}: state, decision, reason, concept and, once bound, the Scroll
 *
 * Read only: demands are written by the reading that observed them (the feed, an opened continuation)
 * and supply by the worker. No source is ever named.
 */
import type { FastifyInstance } from 'fastify';
import { readInventory } from '../../../packages/db/src/inventory/read.ts';
import type { Authenticated } from './semantic-routes.ts';

export function registerInventoryRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.get('/v1/inventory', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => readInventory(client, scope));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
