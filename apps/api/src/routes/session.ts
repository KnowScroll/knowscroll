/** The reader's session: who it is, signing out, and the cookie session's page token (ADR-0009, ADR-0034). */
import type { FastifyInstance } from 'fastify';
import { revokeSession } from '@knowscroll/db';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import {
  clearedSessionCookie,
  csrfToken,
  type WebSessionConfig,
} from '../http/web-session.ts';

function emptyObject(value: unknown): value is Record<string, never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export function registerSessionRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
  webSession: WebSessionConfig,
): void {
  app.get('/v1/session', async (req) =>
    authenticated(req.headers.authorization, async (scope) => scope),
  );

  app.post('/v1/session/revoke', async (req, reply) => {
    await authenticated(req.headers.authorization, async (scope, client) => {
      if (!emptyObject(req.body))
        throw new HttpError(400, 'Invalid revoke request');
      await revokeSession(client, scope);
    });
    if (req.ksCookieSession) reply.header('set-cookie', clearedSessionCookie);
    return reply.code(204).send();
  });

  // ADR-0034: the page's CSRF token for its cookie session (derived; survives reloads and tabs).
  app.get('/v1/session/csrf', async (req, reply) => {
    await authenticated(req.headers.authorization, async () => undefined);
    if (!req.ksCookieSession)
      throw new HttpError(400, 'Only a cookie session has a CSRF token');
    return reply
      .header('Cache-Control', 'no-store')
      .send({ csrfToken: csrfToken(webSession.secret, req.ksCookieSession) });
  });
}
