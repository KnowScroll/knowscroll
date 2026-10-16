/** The liveness route: no authentication, and it reports healthy only if the database answers.
 * It also names the world and commit, so a deploy can tell it reached the build it shipped (#201). */

import { checkDatabase } from '@knowscroll/db';
import type { FastifyInstance } from 'fastify';
import type { World } from '../http/runtime-config.ts';

export type HealthInfo = { world: World; commit: string };

export function registerHealthRoute(
  app: FastifyInstance,
  info: HealthInfo | undefined,
): void {
  const world = info?.world ?? 'local';
  const commit = info?.commit ?? 'local';
  app.get('/health', async () => {
    await checkDatabase();
    return { status: 'ok', database: true, world, commit };
  });
}
