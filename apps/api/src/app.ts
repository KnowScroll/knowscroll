/**
 * The API's composition root: builds the Fastify app, maps every error to a response in one place,
 * and registers the routes in a fixed order. Routes run their work through the one authenticated
 * transaction (`http/authenticated.ts`); the process entrypoint is `main.ts` (ADR-0003, ADR-0009).
 */

import {
  COMPOSER_SEMANTIC_V3,
  type COMPOSER_SEMANTIC_V4,
} from '@knowscroll/core/composer/semantic';
import type { COMPOSER_SIGNALS_V2 } from '@knowscroll/core/composer/signals';
import { ensureDevelopmentSession, UnauthorizedSession } from '@knowscroll/db';
import type { MagicLinkRateLimits } from '@knowscroll/db/sign-in';
import Fastify from 'fastify';
import { authenticated } from './http/authenticated.ts';
import { registerWebSession, webSessionConfig } from './http/web-session.ts';
import { resolveMediaRoot } from './media/stream.ts';
import { registerAnswerRoutes } from './routes/answers.ts';
import { registerAskRoutes } from './routes/asks.ts';
import { registerAtlasRoutes } from './routes/atlas.ts';
import { registerComposerRoutes } from './routes/composer.ts';
import {
  registerEncounterRoutes,
  registerEventRoutes,
} from './routes/encounters.ts';
import { registerFeedRoutes } from './routes/feed.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerInquiryRoutes } from './routes/inquiries.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerPrivacyRoutes } from './routes/privacy.ts';
import { registerReturnRoutes } from './routes/return.ts';
import { registerRoomRoutes } from './routes/rooms.ts';
import { registerSemanticRoutes } from './routes/semantic.ts';
import { registerSessionRoutes } from './routes/session.ts';
import { registerSignInRoutes } from './routes/sign-in.ts';
import { registerUniverseRoutes } from './routes/universe.ts';

export function buildApp(
  developmentToken: string,
  options: {
    mediaRoot?: string;
    magicLinkLimits?: MagicLinkRateLimits;
    composerPolicy?:
      | typeof COMPOSER_SIGNALS_V2
      | typeof COMPOSER_SEMANTIC_V3
      | typeof COMPOSER_SEMANTIC_V4;
  } = {},
) {
  const composerPolicy = options.composerPolicy ?? COMPOSER_SEMANTIC_V3;
  if (developmentToken.length < 24)
    throw new Error('KS_DEV_TOKEN must contain at least 24 characters');
  // Resolved once at build time (deployment configuration, never per-request data), but only
  // actually required the first time the media route is hit: a caller that never touches
  // /v1/media/:sha256 (most existing tests) never needs KS_MEDIA_ROOT/KS_DEV_ROOT set.
  let mediaRoot: string | undefined = options.mediaRoot;
  const resolvedMediaRoot = () => mediaRoot ?? (mediaRoot = resolveMediaRoot());
  const app = Fastify({ logger: false, bodyLimit: 16384 });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof UnauthorizedSession)
      return reply.code(401).send({ error: 'Unauthorized' });
    const status =
      error instanceof Error && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    // A deliberately unavailable capability (503, e.g. answers not enabled) keeps its safe message;
    // every other 5xx stays generic so internal failures never leak details.
    const code =
      Number.isInteger(status) &&
      ((status >= 400 && status < 500) || status === 503)
        ? status
        : 500;
    return reply.code(code).send({
      error:
        code === 500 ? 'Internal operation failed' : (error as Error).message,
    });
  });

  app.addHook('onReady', async () => {
    await ensureDevelopmentSession(developmentToken);
  });

  // The desktop session cookie's hook runs before every authenticated route and hands a checked
  // cookie to the same authentication path as a bearer token (ADR-0034). A session minted by
  // magic-link sign-in authenticates exactly like a development-token session (ADR-0026).
  const webSession = webSessionConfig();
  registerWebSession(app, webSession);
  registerSignInRoutes(app, options.magicLinkLimits, webSession);

  // Semantic continuations and connection feedback (#131), and "why this appeared" (ADR-0032).
  registerSemanticRoutes(app, authenticated);
  registerComposerRoutes(app, authenticated);
  // Ask answers: the reader's authority, state and cancellation; no provider in this process (ADR-0033).
  registerAnswerRoutes(app, authenticated);
  // The reader's places, from anchored attention (ADR-0036).
  registerAtlasRoutes(app, authenticated);
  // Background bridge inquiries: standing consent and what was looked for; no provider here (ADR-0038).
  registerInquiryRoutes(app, authenticated);
  // What changed while the reader was away, and the Relics they keep (ADR-0039).
  registerReturnRoutes(app, authenticated);
  // The reader's Idea Rooms, their inhabitants and their setting aside (ADR-0045).
  registerRoomRoutes(app, authenticated);
  // The reader's content demands and what met them; nothing is written here (ADR-0046).
  registerInventoryRoutes(app, authenticated);

  registerHealthRoute(app);
  registerSessionRoutes(app, authenticated, webSession);
  registerPrivacyRoutes(app, authenticated);
  registerUniverseRoutes(app, authenticated);
  registerFeedRoutes(app, authenticated, composerPolicy);
  registerEncounterRoutes(app, authenticated);
  registerAskRoutes(app, authenticated);
  registerEventRoutes(app, authenticated);
  registerMediaRoutes(app, authenticated, resolvedMediaRoot);

  return app;
}
