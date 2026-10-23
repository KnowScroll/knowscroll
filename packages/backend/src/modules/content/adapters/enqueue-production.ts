import type { PgBoss } from 'pg-boss';
import { produceScrollJob, produceScrollJobId, produceScrollQueue } from '../production/events.js';

export type EnqueueScrollProduction = (recipe: string, priority?: number) => Promise<'queued' | 'already_exists'>;

/**
 * Sends the production job of one library recipe outside any personal transaction: the operator's
 * way to seed the library through the same queue Quartermaster uses. The job ID is stable per recipe
 * and version, so asking twice reaches one job (`already_exists` while pg-boss still retains it). Operator seeding runs below a person's request
 * (priority 0 against Quartermaster's), so a waiting person is never queued behind a seeding batch.
 */
export function makeEnqueueScrollProduction(boss: PgBoss): EnqueueScrollProduction {
  return async (recipe, priority = 0) => {
    const job = produceScrollJob(recipe);
    const id = await boss.send(produceScrollQueue.name, produceScrollQueue.payload.parse(job), {
      id: produceScrollJobId(job),
      priority,
    });
    return id === null ? 'already_exists' : 'queued';
  };
}
