/**
 * Entry point of the API process, spawned by scripts and journeys (path is pinned). Development
 * mode starts the app on 127.0.0.1 with the development bootstrap identity, as it always has.
 * Server mode (NODE_ENV=production, #201) starts it on 127.0.0.1 behind Caddy with no development
 * identity, trusting exactly that one proxy hop; readRuntimeConfig refuses anything else and names
 * every problem. SIGINT/SIGTERM close the server, then the database pool, then exit 0.
 */

import { pool } from '@knowscroll/db';
import { buildApp } from './app.ts';
import { readRuntimeConfig } from './http/runtime-config.ts';

const config = readRuntimeConfig(process.env);
const app = buildApp(config.developmentToken, {
  trustProxy: config.trustProxy,
  ...(config.mode === 'server'
    ? { health: { world: config.world, commit: config.commit } }
    : {}),
});
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(
  JSON.stringify(
    config.mode === 'server'
      ? {
          service: 'api',
          port: config.port,
          identity: 'server',
          world: config.world,
          commit: config.commit,
        }
      : {
          service: 'api',
          port: config.port,
          identity: 'local-development-only',
        },
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
