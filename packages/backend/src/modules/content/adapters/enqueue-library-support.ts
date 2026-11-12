import type { PgBoss } from 'pg-boss';
import { checkLibrarySupportQueue, checkLibrarySupportSingletonKey } from '../production/library-support-events.js';
import type { EnqueueLibrarySupport } from '../production/library-support-job.js';

/**
 * Sends the support check of one held library revision outside any transaction. The queue holds one job per revision and checker version
 * while it is queued or running, so asking twice reaches one job (`already_queued`). It is a hint: a revision whose job was lost is found
 * again by the sweep, which reads the held revisions that have no result. The worker sends it after the delivery that held the revision;
 * the sweep sends it for every other revision that is due.
 */
export function makeEnqueueLibrarySupport(boss: PgBoss): EnqueueLibrarySupport {
  return async (job) => {
    const id = await boss.send(checkLibrarySupportQueue.name, checkLibrarySupportQueue.payload.parse(job), {
      singletonKey: checkLibrarySupportSingletonKey(job),
    });
    return id === null ? 'already_queued' : 'queued';
  };
}
