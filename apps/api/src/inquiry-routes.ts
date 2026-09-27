/**
 * #132 — background bridge inquiries (ADR-0038): the reader's standing consent and what was looked for.
 *
 *   PUT /v1/inquiries/consent   {enabled, dailyLimit?, clientRequestId, expectedPrivacyEpoch} -> {privacyEpoch, consent}
 *   GET /v1/inquiries           {privacyEpoch, consent, inquiries[]}, newest first
 *
 * The API never calls a provider and never creates an inquiry Job; the worker does
 * (apps/worker/src/reasoning/inquiry-worker.ts).
 */
import type { FastifyInstance } from 'fastify';
import { InquiryError, listInquiries, setInquiryConsent } from '../../../packages/db/src/reasoning-inquiries.ts';
import { HttpError } from './errors.ts';
import type { Authenticated } from './semantic-routes.ts';

const http = (error: unknown): never => {
  if (error instanceof InquiryError) throw new HttpError(error.statusCode, error.message);
  throw error;
};

export function registerInquiryRoutes(app: FastifyInstance, authenticated: Authenticated): void {
  app.put('/v1/inquiries/consent', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => setInquiryConsent(client, scope, req.body).catch(http));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.get('/v1/inquiries', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, (scope, client) => listInquiries(client, scope));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
