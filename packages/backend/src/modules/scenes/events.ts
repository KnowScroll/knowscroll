import { z } from 'zod';
import { GeographyRevisionsSchema } from '@knowscroll/contracts';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
export const ProjectSceneJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  transitionId: z.uuid(),
  geography: GeographyRevisionsSchema,
  personalRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type ProjectSceneJob = z.infer<typeof ProjectSceneJobSchema>;
export const projectSceneQueue = defineQueue({
  name: 'scenes.project',
  purpose: 'Project current committed Geography into bounded persisted appearance; no evidence or model work.',
  payload: ProjectSceneJobSchema,
  policy: {
    expireInSeconds: 180,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
