/** `POST /v1/asks`: record a reader's literal question about an exposure (ADR-0016). */
import type { FastifyInstance } from 'fastify';
import { explicitAskInput } from '@knowscroll/contracts';
import {
  ExplicitAskError,
  recordExplicitAsk,
} from '@knowscroll/db/explicit-ask';
import { refreshPersonalModel } from '@knowscroll/db/semantic/personal-model';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/input.ts';

/** Maps by `kind`, not `statusCode`: the db error carries no HTTP status. Anything else rethrows unchanged. */
function mapExplicitAskError(error: unknown): unknown {
  if (!(error instanceof ExplicitAskError)) return error;
  if (error.kind === 'invalid') return new HttpError(400, 'Invalid Ask');
  if (error.kind === 'stale_epoch')
    return new HttpError(409, 'Ask privacy epoch is stale');
  if (error.kind === 'conflict')
    return new HttpError(409, 'Ask conflicts with existing request');
  return new HttpError(422, 'A current matching exposure is required');
}

export function registerAskRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.post('/v1/asks', { bodyLimit: 32768 }, async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const input = parseInput(explicitAskInput, req.body, 'Invalid Ask');
        try {
          const receipt = await recordExplicitAsk(client, scope, input);
          await refreshPersonalModel(client, scope.universeId);
          return receipt;
        } catch (error) {
          throw mapExplicitAskError(error);
        }
      },
    );
    return reply.code(201).send(result);
  });
}
