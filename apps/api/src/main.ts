/**
 * Entry point of the API process, spawned by scripts and journeys (path is pinned). Starts the
 * app on 127.0.0.1 with the development bootstrap identity and refuses to run at all under
 * NODE_ENV=production, since that identity is development-only. SIGINT/SIGTERM close the server,
 * then the database pool, then exit 0.
 */
import { buildApp } from './app.ts';
import { pool } from '@knowscroll/db';
if (process.env.NODE_ENV === 'production')
  throw new Error(
    'Bootstrap identity is development-only; implement production authentication before deployment',
  );
const app = buildApp(process.env.KS_DEV_TOKEN ?? '');
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
console.log(
  JSON.stringify({
    service: 'api',
    port: Number(process.env.PORT ?? 4310),
    identity: 'local-development-only',
  }),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
