import { BackfillLooksJobSchema } from '../events.js';
import type { SkippedLook } from './assign-looks.js';
import { missingLooks } from './looks.js';
import type { BackfillSceneLooks, ScenePorts } from './ports.js';

/**
 * Gives the places of a world that was projected before looks existed their look (D-102). It moves
 * no slot, seed, family or anchor: it only inserts `scenes.looks` rows for stored objects that have
 * none, in the order the projector would have given them. Running it again, or after a projection
 * already gave the looks, assigns nothing.
 *
 * Authority: rechecks the owning account and epoch under the personal root lock, as the projector
 * does. Side effects: one disposable root advancement and notice when it assigned something, in the
 * same transaction; a diagnostic event for each region it could not give a look. No model call,
 * network wait or extra job. Failure: a plan that no longer matches the stored objects throws
 * `LookRefused`, and the delivery retries and then dead-letters.
 */
export function makeBackfillSceneLooks(p: ScenePorts): BackfillSceneLooks {
  return async (payload) => {
    const job = BackfillLooksJobSchema.parse(payload);
    const nothing = { assigned: 0, skipped: [] as readonly SkippedLook[] };
    const result = await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'scenes.backfill-looks' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return nothing;
        const read = await p.readInput(scope);
        if (read.kind !== 'read') return nothing;
        const { created, skipped } = missingLooks(await p.store.objects(scope), read.input, await p.store.looks(scope));
        if (created.length) {
          await p.store.saveLooks(scope, created);
          await p.notify(scope, await p.advance(scope));
        }
        return { assigned: created.length, skipped };
      },
    );
    if (result.kind !== 'entered') return { assigned: 0 };
    for (const region of result.value.skipped) p.logEvent('scenes.look_refused', { reasonCode: region.reason });
    return { assigned: result.value.assigned };
  };
}
