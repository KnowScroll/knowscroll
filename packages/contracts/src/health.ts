import { oc } from '@orpc/contract';
import { z } from 'zod';

/**
 * Process identity reported by `GET /health`. The deploy tooling compares `commit`, `world` and
 * `artifact` with what it deployed; `migration` is the newest applied migration name, or `none`;
 * `relay` tells whether live hints are flowing (non-secret).
 */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  world: z.string(),
  commit: z.string(),
  artifact: z.string(),
  migration: z.string(),
  /** The API's LISTEN relay: `reconnecting` means live hints are paused (clients catch up by revision). */
  relay: z.enum(['listening', 'reconnecting']),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `GET /health`: no input, 200 with the release identity; failures are RFC 9457 problems. */
export const healthContract = oc
  .route({ method: 'GET', path: '/health', successStatus: 200, tags: ['operations'] })
  .output(HealthResponseSchema);
