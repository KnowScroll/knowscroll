import { BackfillLooksJobSchema } from '../events.js';
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
 * same transaction. No model call, network wait or extra job. Failure: a plan that no longer matches
 * the stored objects throws `LookRefused`, and the delivery retries and then dead-letters.
 */
export function makeBackfillSceneLooks(p: ScenePorts): BackfillSceneLooks {
  return async (payload) => {
    const job = BackfillLooksJobSchema.parse(payload);
    const result = await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'scenes.backfill-looks' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return 0;
        const read = await p.readInput(scope);
        if (read.kind !== 'read') return 0;
        const looks = missingLooks(await p.store.objects(scope), read.input, await p.store.looks(scope));
        if (!looks.length) return 0;
        await p.store.saveLooks(scope, looks);
        await p.notify(scope, await p.advance(scope));
        return looks.length;
      },
    );
    return { assigned: result.kind === 'entered' ? result.value : 0 };
  };
}
