import type { JobConsumer } from '@knowscroll/backend/infrastructure/jobs';

/**
 * The worker's explicit consumer registry: every queue this process claims work from, and the
 * use case that handles it. Nothing is discovered by decorators or scanning.
 */
export function jobConsumers(): readonly JobConsumer<unknown>[] {
  return [];
}
