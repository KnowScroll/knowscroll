/** History Clear, recording pause/resume, export, Reset and account deletion (ADR-0010, ADR-0030, ADR-0035). */
import type { FastifyInstance } from 'fastify';
import {
  accountDeletionInput,
  historyClearInput,
  privacyLifecycleInput,
  privacyResetInput,
} from '@knowscroll/contracts';
import {
  clearScrollHistory,
  deleteAccount,
  exportUniverse,
  pauseRecording,
  resetPersonalUniverse,
  resumeRecording,
} from '@knowscroll/db';
import type { Authenticated } from '../http/authenticated.ts';
import { parseInput } from '../http/input.ts';
import { clearedSessionCookie } from '../http/web-session.ts';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.post('/v1/history/clear', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const input = parseInput(
          historyClearInput,
          req.body,
          'Invalid history clear request',
        );
        return clearScrollHistory(client, scope, input);
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
        const input = parseInput(
          privacyLifecycleInput,
          req.body,
          'Invalid pause request',
        );
        return pauseRecording(client, scope, input);
      },
    );
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/resume', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const input = parseInput(
          privacyLifecycleInput,
          req.body,
          'Invalid resume request',
        );
        return resumeRecording(client, scope, input);
      },
    );
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/export', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const input = parseInput(
          privacyLifecycleInput,
          req.body,
          'Invalid export request',
        );
        return exportUniverse(client, scope, input);
      },
    );
    return reply.code(200).send(result);
  });

  app.post('/v1/privacy/reset', async (req, reply) => {
    const receipt = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const input = parseInput(
          privacyResetInput,
          req.body,
          'Invalid reset request',
        );
        return resetPersonalUniverse(client, scope, input);
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
        const input = parseInput(
          accountDeletionInput,
          req.body,
          'Invalid account deletion request',
        );
        return deleteAccount(client, scope, input);
      },
    );
    if (req.ksCookieSession) reply.header('set-cookie', clearedSessionCookie);
    return reply.code(200).send(receipt);
  });
}
