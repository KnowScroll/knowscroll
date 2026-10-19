import { releaseQueues } from '@knowscroll/backend/job-queues';

/**
 * Every durable queue this release declares (the backend's single list). `migrate.js` creates
 * them and applies their policies; the API sends to them; the worker consumes them through its
 * own explicit registry.
 */
export const declaredQueues = releaseQueues;
