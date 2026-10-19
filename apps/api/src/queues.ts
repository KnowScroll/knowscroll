import { queueRegistry } from '@knowscroll/backend/infrastructure/jobs';

/**
 * Every durable queue this release declares. `migrate.js` creates them and applies their
 * policies; the API sends to them; the worker consumes them through its own explicit registry.
 */
export const declaredQueues = queueRegistry([]);
