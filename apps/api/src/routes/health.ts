/** The liveness route: no authentication, and it reports healthy only if the database answers. */
import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '@knowscroll/db';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async () => {
    await checkDatabase();
    return { status: 'ok', database: true };
  });
}
