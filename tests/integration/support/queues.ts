import { backfillLooksQueue, projectSceneQueue } from '@knowscroll/backend/modules/scenes';
import { cartographyQueue, publishDeltaQueue } from '@knowscroll/backend/modules/geography';
import { resolveSupplyQueue } from '@knowscroll/backend/modules/supply';
import { produceScrollQueue } from '@knowscroll/backend/modules/content';
import { plannerQueue } from '@knowscroll/backend/modules/planner';
import { prepareBufferQueue } from '@knowscroll/backend/modules/composer';
import { contributeQueue } from '@knowscroll/backend/modules/rooms';
import { resolveBranchesQueue, suggestDraftQueue } from '@knowscroll/backend/modules/scenarios';
import { buildDataExportQueue, deleteAccountQueue } from '@knowscroll/backend/modules/identity';
import { z } from 'zod';
import { defineQueue, queueRegistry } from '@knowscroll/backend/infrastructure/jobs';
import {
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
} from '@knowscroll/backend/modules/evidence';

/** CI fixture queue: exercises consumer registration and graceful drain. */
export const fixtureQueue = defineQueue({
  name: 'fixture.slow-task',
  purpose: 'CI fixture: exercises consumer registration and graceful drain.',
  payload: z.object({ v: z.literal(1), taskId: z.string(), holdMs: z.number().int().min(0).max(10_000) }),
  policy: {
    expireInSeconds: 60,
    retryLimit: 1,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retentionSeconds: 3_600,
    deleteAfterSeconds: 3_600,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
});

/** CI fixture queue: a worker job that runs one model step through the attempt ledger. */
export const fixtureModelQueue = defineQueue({
  name: 'fixture.model-step',
  purpose: 'CI fixture: a worker job that runs one fixture model step through the attempt ledger.',
  payload: z.object({ v: z.literal(1), universeId: z.uuid(), privacyEpoch: z.number().int().min(1), runId: z.uuid() }),
  policy: {
    expireInSeconds: 60,
    retryLimit: 3,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retentionSeconds: 3_600,
    deleteAfterSeconds: 3_600,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
});

/** Every queue the template database declares: the release's own plus the fixtures above. */
export const testQueues = queueRegistry([
  projectSceneQueue,
  backfillLooksQueue,
  cartographyQueue,
  publishDeltaQueue,
  resolveSupplyQueue,
  produceScrollQueue,
  suggestDraftQueue,
  resolveBranchesQueue,
  plannerQueue,
  prepareBufferQueue,
  contributeQueue,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  projectEncounterActivityQueue,
  deleteAccountQueue,
  buildDataExportQueue,
  fixtureQueue,
  fixtureModelQueue,
]);
