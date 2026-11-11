import { BackfillLooksJobSchema } from '../events.js';
import { TypeUse, type SkippedLook } from './assign-looks.js';
import { missingLooks } from './looks.js';
import type { BackfillSceneLooks, ScenePorts, SystemRow } from './ports.js';

/** Systems read and written in one step of the backfill. */
const SYSTEMS_PER_STEP = 50;

/**
 * Gives the places of a world that was projected before looks existed their look (D-102). It moves
 * no slot, seed, family or anchor: it only inserts `scenes.looks` rows for stored objects that have
 * none, in the order the projector would have given them. Running it again, or after a projection
 * already gave the looks, assigns nothing.
 *
 * It walks the map a few systems at a time (D-417). A system that is given a look has changed for a client that holds
 * the sky (its haze), so it takes a new scene revision, and the projected revision moves with it; nothing else of the
 * projection changes.
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
        const head = await p.readInput(scope, { kind: 'head' });
        if (head.kind !== 'read') return nothing;
        let state = await p.store.state(scope);
        if (state?.legacy) {
          await p.store.adopt(scope);
          state = await p.store.state(scope);
        }
        if (!state?.projected) return nothing;
        const revision = state.projected.sceneRevision + 1;
        const use = new TypeUse(await p.store.planetTypeCounts(scope));
        const skipped: SkippedLook[] = [];
        let assigned = 0;
        let after: string | undefined;
        for (;;) {
          const systemIds = await p.store.systemIds(scope, after, SYSTEMS_PER_STEP);
          if (!systemIds.length) break;
          after = systemIds.at(-1);
          const read = await p.readInput(scope, { kind: 'systems', systemIds });
          // Half a pass would leave some systems with looks and no new revision: retry the whole delivery instead.
          if (read.kind !== 'read') throw new Error('SCENE_BACKFILL_GEOGRAPHY_UNAVAILABLE');
          const objects = await p.store.objectsOfSystems(scope, systemIds);
          const looked = await p.store.looksOf(
            scope,
            objects.map((o) => o.descriptor.objectId),
          );
          const given = missingLooks(objects, read.input, looked, use);
          skipped.push(...given.skipped);
          if (!given.created.length) continue;
          await p.store.saveLooks(scope, given.created);
          assigned += given.created.length;
          const systemOf = new Map(objects.map((o) => [o.descriptor.objectId, o.systemId]));
          const touched = new Set(given.created.map((look) => systemOf.get(look.objectId)!));
          const rows = await p.store.systems(scope, [...touched]);
          await p.store.saveSystems(
            scope,
            rows.map((row): SystemRow => ({ ...row, sceneRevision: revision })),
          );
        }
        if (assigned) {
          await p.store.saveState(scope, { ...state, projected: { ...state.projected, sceneRevision: revision } });
          await p.notify(scope, await p.advance(scope));
        }
        return { assigned, skipped };
      },
    );
    if (result.kind !== 'entered') return { assigned: 0 };
    for (const region of result.value.skipped) p.logEvent('scenes.look_refused', { reasonCode: region.reason });
    return { assigned: result.value.assigned };
  };
}
