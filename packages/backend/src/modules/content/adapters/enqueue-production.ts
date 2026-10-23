import type { PgBoss } from 'pg-boss';
import { produceScrollJob, produceScrollQueue, produceScrollSingletonKey } from '../production/events.js';

export type EnqueueScrollProduction = (
  recipe: string,
  take: number,
  priority?: number,
) => Promise<'queued' | 'already_queued'>;

/**
 * Sends the production job of one library recipe outside any personal transaction: the operator's
 * way to seed the library through the same queue Quartermaster uses. The queue holds one job per
 * recipe, version and take while it is queued or running, so asking twice reaches one job
 * (`already_queued`). Once that job has finished or failed, asking again resumes the same business
 * run. Operator seeding runs below a person's request (priority 0 against Quartermaster's), so a
 * waiting person is never queued behind a seeding batch.
 */
export function makeEnqueueScrollProduction(boss: PgBoss): EnqueueScrollProduction {
  return async (recipe, take, priority = 0) => {
    const job = produceScrollJob(recipe, take);
    const id = await boss.send(produceScrollQueue.name, produceScrollQueue.payload.parse(job), {
      singletonKey: produceScrollSingletonKey(job),
      priority,
    });
    return id === null ? 'already_queued' : 'queued';
  };
}
