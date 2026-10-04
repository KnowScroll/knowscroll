/**
 * HTTP for the semantic substrate's personal consumers (#131).
 *
 *   GET  /v1/assets/:assetId/branches   live continuations along admitted, non-suppressed bridges (and,
 *                                       for one into a concept with nothing unseen, its need: ADR-0046)
 *   POST /v1/branches                   take one (explicit request; re-checked under the locks)
 *   POST /v1/connections/feedback       "not useful" / "seems wrong": personal suppression only
 *
 * Every route runs inside the caller's authenticated transaction with the universe lock held.
 * Corrections to shared knowledge are an operator tool (scripts/substrate/correct-source.ts), not
 * an HTTP route: a person's objection never retracts a source-backed claim for everyone.
 */
import type { FastifyInstance } from 'fastify';
import { observeOfferedGaps } from '@knowscroll/db/inventory/demand';
import {
  listEncounterBranches,
  openBranch,
  recordConnectionFeedback,
} from '@knowscroll/db/semantic/branches';
import type {
  EncounterBranchesResponse,
  WebEncounterBranchesResponse,
  WebBranchOpenResponse,
} from '@knowscroll/contracts/semantic';
import { refreshPersonalModel } from '@knowscroll/db/semantic/personal-model';
import type { Authenticated } from '../http/authenticated.ts';
import { noStore, requireUuid } from '../http/input.ts';

export function registerSemanticRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/branches',
    async (req, reply) => {
      const result = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          requireUuid(req.params.assetId, 'Invalid asset ID');
          const listed = await listEncounterBranches(
            client,
            scope,
            req.params.assetId,
          );
          // ADR-0046 §1: a continuation offered into a concept with nothing unseen is a need, recorded with the listing that offered it.
          await observeOfferedGaps(
            client,
            scope,
            req.params.assetId,
            listed.branches,
          );
          return isWebReader(req.query) ? webBranches(listed) : listed;
        },
      );
      return noStore(reply).send(result);
    },
  );

  app.post('/v1/branches', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const opened = await openBranch(client, scope, req.body);
        if (opened.branch.recorded)
          await refreshPersonalModel(client, scope.universeId);
        return isWebReader(req.query) ? webBranchOpen(opened) : opened;
      },
    );
    return reply.code(201).send(result);
  });

  app.post('/v1/connections/feedback', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const receipt = await recordConnectionFeedback(client, scope, req.body);
        await refreshPersonalModel(client, scope.universeId);
        return receipt;
      },
    );
    return reply.code(201).send(result);
  });
}

function isWebReader(query: unknown): boolean {
  return (
    typeof query === 'object' &&
    query !== null &&
    (query as { webReader?: unknown }).webReader === 'v1'
  );
}

function webBranches(
  value: EncounterBranchesResponse,
): WebEncounterBranchesResponse {
  return {
    assetId: value.assetId,
    revision: value.revision,
    privacyEpoch: value.privacyEpoch,
    emptyReason: value.emptyReason,
    branches: value.branches.map(({ evidence, target, ...branch }) => ({
      ...branch,
      evidence: evidence.map(({ claimKey, statement, supports }) => ({
        claimKey,
        statement,
        supports,
      })),
      target: {
        assetId: target.assetId,
        revision: target.revision,
        kind: 'Scroll',
        title: target.title,
        summary: target.summary,
      },
    })),
  };
}

function webBranchOpen(
  value: Awaited<ReturnType<typeof openBranch>>,
): WebBranchOpenResponse {
  return {
    ...value,
    items: value.items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const {
        sourceTitle: _sourceTitle,
        sourceUrl: _sourceUrl,
        ...safe
      } = item;
      return { ...safe, webArtifact: null };
    }),
  } as WebBranchOpenResponse;
}
