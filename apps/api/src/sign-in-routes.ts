/**
 * ADR-0026 — `POST /v1/auth/magic-link`, `GET /v1/auth/confirm`, `POST /v1/auth/session`. Kept in
 * its own module (mirroring `media.ts`) so `app.ts` only wires it in, rather than growing further.
 */
import type { FastifyInstance } from 'fastify';
import { magicLinkRequestInput, signInConfirmQuery } from '../../../packages/contracts/src/index.ts';
import { transaction } from '../../../packages/db/src/index.ts';
import {
  confirmSignInToken,
  consumeSignInToken,
  requestMagicLink,
  type MagicLinkRateLimits,
  requesterFingerprint,
} from '../../../packages/db/src/sign-in.ts';
import { createMagicLinkSender, type MagicLinkSender } from './magic-link-sender.ts';
import { describeSendFailure } from './agentmail-sender.ts';
import { HttpError } from './errors.ts';

function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KS_API_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `http://127.0.0.1:${env.PORT ?? 4310}`;
}

export function registerSignInRoutes(app: FastifyInstance, limits?: MagicLinkRateLimits): void {
  // Resolved lazily and cached, exactly like `resolveMediaRoot()`: a caller that never requests a
  // magic link never needs `KS_DEV_ROOT` set, and a production-mode process only refuses here at
  // the moment this route is actually exercised (main.ts already refuses every production start
  // before that could ever happen).
  let sender: MagicLinkSender | undefined;
  const resolvedSender = () => sender ?? (sender = createMagicLinkSender());

  app.post('/v1/auth/magic-link', async (req, reply) => {
    const parsed = magicLinkRequestInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid magic-link request');
    const fingerprint = requesterFingerprint(req.ip);
    // `limits` is injected only by tests that need many links inside one window; production
    // always uses the documented defaults in packages/db/src/sign-in.ts.
    const issued = await transaction(client => requestMagicLink(client, {
      email: parsed.data.email,
      requesterFingerprint: fingerprint,
    }, limits));
    if (issued) {
      const link = `${resolveApiBaseUrl()}/v1/auth/confirm?token=${encodeURIComponent(issued.token)}`;
      // Best-effort delivery, exactly like a real mail provider: a send failure (including a
      // misconfigured sink or a rejected AgentMail request) never distinguishes this response from
      // any other — it is swallowed here rather than surfaced as a 500 only reachable on the
      // owner-address path (ADR-0027 section 3). The app's own Fastify logger is disabled
      // (`Fastify({logger:false})` in app.ts), so this writes a structured line to stderr instead —
      // the same convention `apps/worker/src/**/main.ts` already uses for operator-visible events.
      // `describeSendFailure()` is the *only* thing ever read off `error`: a closed shape of
      // httpStatus/reason/messageId that is safe by construction, never `error.message` or a stack,
      // and never the address, the token or the link this route just built.
      try {
        await resolvedSender().send({ to: parsed.data.email, link });
      } catch (error) {
        console.error(JSON.stringify({ service: 'api', event: 'magic_link_send_failed', ...describeSendFailure(error) }));
      }
    }
    return reply.code(202).send({ status: 'requested' });
  });

  app.get('/v1/auth/confirm', async (req, reply) => {
    const parsed = signInConfirmQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid confirmation request');
    const valid = await transaction(client => confirmSignInToken(client, parsed.data.token));
    return reply.code(200).send({ valid });
  });

  app.post('/v1/auth/session', async (req, reply) => {
    // No 400 path here at all (see packages/db/src/sign-in.ts's InvalidSignInToken doc comment):
    // any body shape that does not yield a usable string is treated exactly like any other
    // unusable token, so a malformed request is never distinguishable from an expired, consumed,
    // unknown or tampered one.
    const body = req.body as Record<string, unknown> | undefined;
    const rawToken = typeof body?.token === 'string' ? body.token : '';
    const session = await transaction(client => consumeSignInToken(client, rawToken));
    return reply.code(200).send({
      sessionToken: session.token,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      universeId: session.universeId,
      privacyEpoch: session.privacyEpoch,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      origin: 'magic_link',
    });
  });
}
