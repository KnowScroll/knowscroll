import { queueRegistry } from '@knowscroll/backend/infrastructure/jobs';
import { applyActionEvidenceQueue } from '@knowscroll/backend/modules/evidence';

/**
 * Every durable queue this release declares. `migrate.js` creates them and applies their
 * policies; the API sends to them; the worker consumes them through its own explicit registry.
 */
export const declaredQueues = queueRegistry([applyActionEvidenceQueue]);
