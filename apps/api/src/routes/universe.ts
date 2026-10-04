/** The reader's universe summary and a kept Trace revisited (docs/contracts/trace-revisit.md). */
import type { FastifyInstance } from 'fastify';
import { validateScrollWebArtifact } from '@knowscroll/core/scrolls/web-artifact';
import {
  readTraceRevisit,
  readTraceWebArtifact,
  TraceRevisitError,
} from '@knowscroll/db/trace-revisit';
import { readUniverseSummary } from '@knowscroll/db/universe';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import { noStore } from '../http/input.ts';

/** The refusal a `TraceRevisitError` kind maps to; this is the kind mapper for the Trace route. */
function traceRevisitHttpError(error: TraceRevisitError): HttpError {
  if (error.kind === 'invalid')
    return new HttpError(400, 'Invalid Trace event ID');
  if (error.kind === 'not_found') return new HttpError(404, 'Trace not found');
  if (error.kind === 'stale_epoch')
    return new HttpError(409, 'Trace privacy epoch is stale');
  if (error.kind === 'source_changed')
    return new HttpError(409, 'Saved Scroll source is unavailable');
  return new HttpError(422, 'Saved Scroll lineage is unavailable');
}

export function registerUniverseRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
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
            // The guarded revisit has already tied this exact revision/body to the original Keep
            // and still holds the asset share lock, so the checked web artifact is a
            // representation of that same Scroll.
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
            if (error instanceof TraceRevisitError)
              throw traceRevisitHttpError(error);
            throw error;
          }
        },
      );
      return noStore(reply).send(result);
    },
  );
}
