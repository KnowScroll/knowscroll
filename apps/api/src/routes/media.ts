/** `GET`/`HEAD /v1/media/:sha256`: authorized in one short transaction, streamed after it commits (ADR-0024). */
import type { FastifyInstance } from 'fastify';
import { findServableMedia } from '@knowscroll/db/media';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import { MEDIA_SHA256_PATTERN, sendMedia } from '../media/stream.ts';

export function registerMediaRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
  mediaRoot: () => string,
): void {
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
      return sendMedia(req, reply, mediaRoot(), authorized);
    },
  });
}
