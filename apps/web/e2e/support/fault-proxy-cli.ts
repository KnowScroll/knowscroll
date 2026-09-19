/**
 * Standalone process wrapper around startFaultProxy so the root orchestration
 * script (scripts/run-web-reader-journey.ts, a plain Node/NodeNext project)
 * can spawn it without statically importing a Vite-resolved apps/web source
 * file into the root TypeScript project.
 *
 * Usage: tsx fault-proxy-cli.ts <targetOrigin>
 * Prints exactly one line "PORT=<port>" to stdout once listening.
 */
import { startFaultProxy } from './fault-proxy.ts';

const targetOrigin = process.argv[2];
if (!targetOrigin) {
  console.error('Usage: fault-proxy-cli.ts <targetOrigin>');
  process.exit(1);
}

const proxy = await startFaultProxy(targetOrigin);
console.log(`PORT=${proxy.port}`);

async function shutdown(): Promise<void> {
  await proxy.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
