import { oc } from '@orpc/contract';
import { z } from 'zod';

/**
 * Process identity reported by `GET /health`. The deploy tooling compares `commit`, `world` and
 * `artifact` with what it deployed; `migration` is the newest applied migration name, or `none`.
 */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  world: z.string(),
  commit: z.string(),
  artifact: z.string(),
  migration: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const healthContract = oc
  .route({ method: 'GET', path: '/health', successStatus: 200, tags: ['operations'] })
  .output(HealthResponseSchema);
