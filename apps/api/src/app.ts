import Fastify from 'fastify';
import {
  explicitAskInput,
  exposureInput,
  historyClearInput,
  interactionInput,
  privacyLifecycleInput,
  privacyResetInput,
  accountDeletionInput,
  uuid,
} from '@knowscroll/contracts';
import { parseFeedKinds } from '@knowscroll/contracts/inventory';
import {
  checkDatabase,
  transaction,
  authenticateAndLock,
  ensureDevelopmentSession,
  clearScrollHistory,
  pauseRecording,
  resumeRecording,
  exportUniverse,
  resetPersonalUniverse,
  deleteAccount,
  revokeSession,
  UnauthorizedSession,
  type AuthScope,
} from '@knowscroll/db';
import { COMPOSER_SIGNALS_V2 } from '@knowscroll/core/composer/signals';
import { validateScrollWebArtifact } from '@knowscroll/core/scrolls/web-artifact';
import {
  COMPOSER_SEMANTIC_V3,
  COMPOSER_SEMANTIC_V4,
} from '@knowscroll/core/composer/semantic';
import { composeAndRecordV2 } from '@knowscroll/db/composer/signals';
import { composeAndRecordV3 } from '@knowscroll/db/composer/semantic';
import { observeExhaustion } from '@knowscroll/db/inventory/demand';
import { refreshPersonalModel } from '@knowscroll/db/semantic/personal-model';
import {
  ExplicitAskError,
  recordExplicitAsk,
} from '@knowscroll/db/explicit-ask';
import {
  readTraceRevisit,
  readTraceWebArtifact,
  TraceRevisitError,
} from '@knowscroll/db/trace-revisit';
import { SHARED_SOURCE_V1, readWorldSystem } from '@knowscroll/db/worlds';
import {
  readLedgerEvent,
  recordExposure,
  recordKeep,
} from '@knowscroll/db/encounters';
import {
  feedCandidates,
  readFeedAccount,
  readFeedWebArtifacts,
} from '@knowscroll/db/feed';
import { findServableMedia } from '@knowscroll/db/media';
import { readUniverseSummary } from '@knowscroll/db/universe';
import { HttpError } from './http/errors.ts';
import {
  MEDIA_SHA256_PATTERN,
  resolveMediaRoot,
  sendMedia,
} from './media/stream.ts';
import {
  clearedSessionCookie,
  csrfToken,
  registerWebSession,
  webSessionConfig,
} from './http/web-session.ts';
import { registerSignInRoutes } from './routes/sign-in.ts';
import { registerSemanticRoutes } from './routes/semantic.ts';
import { registerComposerRoutes } from './routes/composer.ts';
import { registerAnswerRoutes } from './routes/answers.ts';
import { registerAtlasRoutes } from './routes/atlas.ts';
import { registerInquiryRoutes } from './routes/inquiries.ts';
import { registerReturnRoutes } from './routes/return.ts';
import { registerRoomRoutes } from './routes/rooms.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import type { MagicLinkRateLimits } from '@knowscroll/db/sign-in';

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  if (!match) throw new UnauthorizedSession();
  return match[1]!;
}

function emptyObject(value: unknown): value is Record<string, never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** `exclude`: up to 256 comma-separated asset UUIDs, or absent. Null when malformed. */
export function parseFeedExclude(value: unknown): Set<string> | null {
  if (value === undefined || value === '') return new Set();
  if (typeof value !== 'string') return null; // a repeated parameter arrives as an array: refuse it, never throw
  const ids = value.split(',');
  if (
    ids.length > 256 ||
    ids.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  )
    return null;
  return new Set(ids.map((id) => id.toLowerCase()));
}

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

  // ADR-0026: real sign-in (magic link, single owner account). Additive — every route above and
  // below is unchanged, and a session this mints authenticates through the exact same
  // `authenticateAndLock` path as a development-token session.
  // ADR-0034: the desktop session cookie. Its hook runs before every authenticated route and hands
  // a checked cookie to the same authentication path as a bearer token.
  const webSession = webSessionConfig();
  registerWebSession(app, webSession);
  registerSignInRoutes(app, options.magicLinkLimits, webSession);

  const authenticated = <T>(
    authorization: string | undefined,
    fn: (scope: AuthScope, client: import('pg').PoolClient) => Promise<T>,
  ) =>
    transaction(async (client) => {
      const scope = await authenticateAndLock(
        client,
        bearerToken(authorization),
      );
      return fn(scope, client);
    });

  // #131: semantic continuations and connection feedback, through the same authenticated path.
  registerSemanticRoutes(app, authenticated);
  registerComposerRoutes(app, authenticated);
  // #132: Ask answers — the reader's fresh authority, state and cancellation; no provider in this process.
  registerAnswerRoutes(app, authenticated);
  // #134: the reader's places, from anchored attention (ADR-0036).
  registerAtlasRoutes(app, authenticated);
  // #132: background bridge inquiries — standing consent and what was looked for (ADR-0038); no provider here.
  registerInquiryRoutes(app, authenticated);
  // #134: what changed while the reader was away, and the Relics they keep (ADR-0039).
  registerReturnRoutes(app, authenticated);
  // #163: the reader's Idea Rooms, their inhabitants and their setting aside (ADR-0045).
  registerRoomRoutes(app, authenticated);
  // #164: the reader's content demands and what met them (ADR-0046); nothing is written here.
  registerInventoryRoutes(app, authenticated);

  app.get('/health', async () => {
    await checkDatabase();
    return { status: 'ok', database: true };
  });

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

  app.post('/v1/history/clear', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = historyClearInput.safeParse(req.body);
        if (!parsed.success)
          throw new HttpError(400, 'Invalid history clear request');
        return clearScrollHistory(client, scope, parsed.data);
      },
    );
    return reply.code(200).send(receipt);
  });

  // ADR-0028: privacy lifecycle. Pause/resume/export/reset all go through the same
  // `authenticated()` path as every other route above, so the universe lock is held and the
  // session's epoch is rechecked before any of them runs a single statement.
  app.post('/v1/privacy/pause', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = privacyLifecycleInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid pause request');
        return pauseRecording(client, scope, parsed.data);
      },
    );
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/resume', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = privacyLifecycleInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid resume request');
        return resumeRecording(client, scope, parsed.data);
      },
    );
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/export', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = privacyLifecycleInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid export request');
        return exportUniverse(client, scope, parsed.data);
      },
    );
    return reply.code(200).send(result);
  });

  app.post('/v1/privacy/reset', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = privacyResetInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid reset request');
        return resetPersonalUniverse(client, scope, parsed.data);
      },
    );
    return reply.code(200).send(receipt);
  });

  // ADR-0035: delete the account and all personal history. The calling session is deleted with
  // it, so a cookie session also gets its cookie cleared.
  app.post('/v1/account/delete', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = accountDeletionInput.safeParse(req.body);
        if (!parsed.success)
          throw new HttpError(400, 'Invalid account deletion request');
        return deleteAccount(client, scope, parsed.data);
      },
    );
    if (req.ksCookieSession) reply.header('set-cookie', clearedSessionCookie);
    return reply.code(200).send(receipt);
  });

  app.get('/v1/universe', async (req) =>
    authenticated(req.headers.authorization, async (scope, client) => {
      return readUniverseSummary(client, scope);
    }),
  );

  app.get<{ Params: { eventId: string }; Querystring: { webReader?: string } }>(
    '/v1/traces/:eventId',
    async (req, reply) => {
      const result = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          if (
            req.body !== undefined ||
            (req.query.webReader === undefined
              ? Object.keys(req.query as object).length > 0
              : req.query.webReader !== 'v1' ||
                Object.keys(req.query as object).length !== 1) ||
            Number(req.headers['content-length'] ?? 0) > 0 ||
            req.headers['transfer-encoding'] !== undefined
          ) {
            throw new HttpError(400, 'Invalid Trace request');
          }
          try {
            const receipt = await readTraceRevisit(
              client,
              scope,
              req.params.eventId,
            );
            if (req.query.webReader !== 'v1') return receipt;
            const {
              sourceTitle: _sourceTitle,
              sourceUrl: _sourceUrl,
              ...readerScroll
            } = receipt.scroll;
            // The guarded revisit has already tied this exact revision/body to the
            // original Keep and still holds the asset share lock. A checked web
            // artifact is an additive representation of that same Scroll.
            const webArtifactValue = await readTraceWebArtifact(
              client,
              receipt.scroll.assetId,
            );
            const webArtifact = validateScrollWebArtifact(webArtifactValue, {
              assetId: receipt.scroll.assetId,
              revision: receipt.scroll.revision,
              body: receipt.scroll.body,
            });
            return { ...receipt, scroll: { ...readerScroll, webArtifact } };
          } catch (error) {
            if (!(error instanceof TraceRevisitError)) throw error;
            if (error.kind === 'invalid')
              throw new HttpError(400, 'Invalid Trace event ID');
            if (error.kind === 'not_found')
              throw new HttpError(404, 'Trace not found');
            if (error.kind === 'stale_epoch')
              throw new HttpError(409, 'Trace privacy epoch is stale');
            if (error.kind === 'source_changed')
              throw new HttpError(409, 'Saved Scroll source is unavailable');
            throw new HttpError(422, 'Saved Scroll lineage is unavailable');
          }
        },
      );
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.get<{
    Querystring: {
      kinds?: string;
      exclude?: string | string[];
      webArtifact?: string;
      preview?: string;
    };
  }>('/v1/feed', async (req) =>
    authenticated(req.headers.authorization, async (scope, client) => {
      const kinds = parseFeedKinds(req.query.kinds);
      if (kinds === null) throw new HttpError(400, 'Invalid kinds parameter');
      if (req.query.webArtifact !== undefined && req.query.webArtifact !== 'v1')
        throw new HttpError(400, 'Invalid webArtifact parameter');
      if (
        req.query.preview !== undefined &&
        req.query.preview !== 'authored-web-scrolls'
      )
        throw new HttpError(400, 'Invalid preview parameter');
      if (req.query.preview) {
        const databaseName = (() => {
          try {
            return new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
          } catch {
            return '';
          }
        })();
        if (
          process.env.NODE_ENV !== 'development' ||
          process.env.KS_RICH_SCROLL_PREVIEW !== '1' ||
          !/^knowscroll_(?:test|preview)_[a-z0-9_]+$/.test(databaseName)
        )
          throw new HttpError(400, 'Preview unavailable');
      }
      // #133: what this discovery trip already has on screen or opened. The client skips those, so
      // offering them could end a trip while other Scrolls remain; v3 gates them with a named reason.
      const exclude = parseFeedExclude(req.query.exclude);
      if (exclude === null)
        throw new HttpError(400, 'Invalid exclude parameter');
      const account = await readFeedAccount(client, scope.universeId);
      const candidates = await feedCandidates(client, kinds);
      // Disposable preview only: offer authored examples through the same composer, decision,
      // exposure and Keep path as any encounter. This never changes the ordinary feed.
      const assets = req.query.preview
        ? candidates.filter(
            (item) =>
              item.kind === 'Scroll' &&
              [
                'A rhythm the ocean keeps',
                'An orbit is not a perfect circle',
              ].includes(item.title),
          )
        : candidates;

      // The ranking policy is deployment configuration recorded on every decision: composer-semantic-v3
      // (ADR-0032) by default; composer-signals-v2 (ADR-0028/0029) and composer-semantic-v4 (v3 with a
      // fair tie-break, ADR-0043 §7) remain selectable and immutable.
      const { decisionId, items } =
        composerPolicy === COMPOSER_SIGNALS_V2
          ? await composeAndRecordV2(client, scope, assets, account)
          : // v3 gates kept encounters itself and records them, so "why not that" has an answer.
            await composeAndRecordV3(
              client,
              scope,
              assets,
              account.revision,
              exclude,
              composerPolicy,
            );
      // ADR-0046 §1: a place this reader has now seen in full is a need, recorded with the semantic decision that saw it.
      if (composerPolicy !== COMPOSER_SIGNALS_V2)
        await observeExhaustion(client, scope, decisionId);
      // Web-only additive representation. Legacy and Android callers see the identical feed
      // shape they already parse. Re-read only selected Scrolls after composition, and drop an
      // invalid/stale artifact to the body fallback without changing selection or exposure.
      const scrollIds =
        req.query.webArtifact === 'v1'
          ? items
              .filter((item) => item.kind === 'Scroll')
              .map((item) => item.assetId)
          : [];
      const artifacts = await readFeedWebArtifacts(client, scrollIds);
      const delivered =
        req.query.webArtifact === 'v1'
          ? items.map((item) => {
              const {
                sourceTitle: _sourceTitle,
                sourceUrl: _sourceUrl,
                ...readerItem
              } = item;
              return item.kind === 'Scroll'
                ? {
                    ...readerItem,
                    webArtifact: artifacts.get(item.assetId) ?? null,
                  }
                : readerItem;
            })
          : items;
      return {
        decisionId,
        universeId: scope.universeId,
        accountRevision: account.revision,
        privacyEpoch: scope.privacyEpoch,
        items: delivered,
      };
    }),
  );

  app.post('/v1/exposures', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = exposureInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid exposure');
        const body = parsed.data;
        return recordExposure(client, scope, body);
      },
    );
    return reply.code(201).send(result);
  });

  app.get('/v1/worlds', async (req) =>
    authenticated(req.headers.authorization, async (scope, client) => {
      const system = await readWorldSystem(client, scope.universeId);
      return { derivationMethod: SHARED_SOURCE_V1, system };
    }),
  );

  app.post('/v1/interactions', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = interactionInput.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, 'Invalid interaction');
        const body = parsed.data;
        return recordKeep(client, scope, body);
      },
    );
    return reply.code(202).send(result);
  });

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

  app.get<{ Params: { eventId: string } }>(
    '/v1/events/:eventId',
    async (req) => {
      return authenticated(req.headers.authorization, async (scope, client) => {
        if (!uuid.safeParse(req.params.eventId).success)
          throw new HttpError(400, 'Invalid event ID');
        const row = await readLedgerEvent(client, scope, req.params.eventId);
        if (!row) throw new HttpError(404, 'Event not found');
        return row;
      });
    },
  );

  // ADR-0024 section 4: content-addressed, authenticated media serving. The sha256 path parameter
  // is validated before anything else touches it; authorization (session, epoch, and an eligible
  // or test_eligible generated_reel naming this media) happens in ONE short transaction; bytes are
  // streamed by sendMedia() entirely OUTSIDE that transaction, which has already committed by the
  // time this handler calls it.
  app.route<{ Params: { sha256: string } }>({
    method: ['GET', 'HEAD'],
    url: '/v1/media/:sha256',
    handler: async (req, reply) => {
      const sha256 = req.params.sha256;
      if (!MEDIA_SHA256_PATTERN.test(sha256))
        throw new HttpError(400, 'Invalid media identifier');
      const authorized = await authenticated(
        req.headers.authorization,
        async (_scope, client) => {
          // Content-addressed media can in principle be shared by more than one generated_reel row
          // (the same bytes imported twice). If ANY of them is a genuine 'eligible' reference, this
          // never reports the simulated marker for that content — a real Reel's bytes are never
          // mislabelled as stand-in just because some other row also names them 'test_eligible'.
          return findServableMedia(client, sha256);
        },
      );
      // Unknown, ineligible and (below, inside sendMedia) missing-on-disk all return the same 404:
      // this never tells a caller which of those was true.
      if (!authorized) throw new HttpError(404, 'Media not found');
      return sendMedia(req, reply, resolvedMediaRoot(), authorized);
    },
  });

  return app;
}
