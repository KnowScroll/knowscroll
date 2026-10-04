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

export function registerAskRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.post('/v1/asks', { bodyLimit: 32768 }, async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = explicitAskInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid Ask');
        try {
          const receipt = await recordExplicitAsk(client, scope, parsed.data);
          await refreshPersonalModel(client, scope.universeId);
          return receipt;
        } catch (error) {
          if (!(error instanceof ExplicitAskError)) throw error;
          if (error.kind === 'invalid') throw new HttpError(400, 'Invalid Ask');
          if (error.kind === 'stale_epoch')
            throw new HttpError(409, 'Ask privacy epoch is stale');
          if (error.kind === 'conflict')
            throw new HttpError(409, 'Ask conflicts with existing request');
          throw new HttpError(422, 'A current matching exposure is required');
        }
      },
    );
    return reply.code(201).send(result);
  });
}
