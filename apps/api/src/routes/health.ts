import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '@knowscroll/db';

/** `GET /health`: unauthenticated; answers only once the database answers. */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async () => {
    await checkDatabase();
    return { status: 'ok', database: true };
  });
}
