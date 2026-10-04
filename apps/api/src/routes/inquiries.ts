/**
 * Background bridge inquiries (ADR-0038): the reader's standing consent and what was looked for.
 *
 *   PUT /v1/inquiries/consent   {enabled, dailyLimit?, clientRequestId, expectedPrivacyEpoch} -> {privacyEpoch, consent}
 *   GET /v1/inquiries           {privacyEpoch, consent, inquiries[]}, newest first
 *
 * The API never calls a provider and never creates an inquiry Job; the worker does
 * (apps/worker/src/reasoning/inquiry-worker.ts).
 */
import type { FastifyInstance } from 'fastify';
import {
  listInquiries,
  setInquiryConsent,
} from '@knowscroll/db/reasoning/inquiries';
import type { Authenticated } from '../http/authenticated.ts';
import { noStore } from '../http/input.ts';

export function registerInquiryRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.put('/v1/inquiries/consent', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => setInquiryConsent(client, scope, req.body),
    );
    return noStore(reply).send(result);
  });
  app.get('/v1/inquiries', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      (scope, client) => listInquiries(client, scope),
    );
    return noStore(reply).send(result);
  });
}
