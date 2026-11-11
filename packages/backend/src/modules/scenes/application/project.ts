import type { SceneRevisions } from '@knowscroll/contracts';
import { LAYOUT_V2 } from '../domain/layout.js';
import { ProjectSceneJobSchema } from '../events.js';
import { LookRefused, TypeUse } from './assign-looks.js';
import { missingLooks } from './looks.js';
import { projectSystems, ProjectionUnavailable } from './projection.js';
import { projectsGeography } from './stamps.js';
import type { ProjectScene, ScenePorts, SystemRow } from './ports.js';

/** Systems read from Geography and written to Scenes in one step of a projection. */
const SYSTEMS_PER_STEP = 50;

/**
 * Old deliveries coalesce onto latest Geography; persisted stamps make crash-after-commit replay inert.
 *
 * It projects only what changed (D-417): Geography names the systems with a place or route stamped after the last
 * projection, and each is read, laid out, chunked and written alone, a few at a time, so a delta that touches one system
 * writes that system's chunks and sky row and nothing else, however large the map is. A refused step is rolled back to
 * where the projection began, and only a failure stamp is kept.
 */
export function makeProjectScene(p: ScenePorts): ProjectScene {
  return async (payload) => {
    const job = ProjectSceneJobSchema.parse(payload);
    // Sent once the transaction has committed, so an attempt that rolls back reports nothing.
    const lookRefusals: string[] = [];
    await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'scenes.project' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return;
        const head = await p.readInput(scope, { kind: 'head' });
        if (head.kind !== 'read') return;
        const input = head.input;
        let old = await p.store.state(scope);
        if (old?.legacy) {
          await p.store.adopt(scope);
          old = await p.store.state(scope);
        }
        if (projectsGeography(old?.projected, input.geography)) return;
        if (!input.objectCount && !old) return;
        const worldSeed = old?.worldSeed ?? p.seed();
        const sceneRevision = (old?.projected?.sceneRevision ?? 0) + 1;
        const revisions: SceneRevisions = {
          geographyRevision: input.geography.revision,
          structureRevision: input.geography.structureRevision,
          activityRevision: input.geography.activityRevision,
          personalRevision: input.personalRevision,
          sceneRevision,
        };
        const policyVersion = old?.policyVersion ?? LAYOUT_V2;
        await p.store.mark(scope);
        try {
          let layout = old?.layout ?? { legacyReach: 0, nextCell: 0 };
          const use = new TypeUse(await p.store.planetTypeCounts(scope));
          const since = old?.projected?.geographyRevision ?? 0;
          let after: string | undefined;
          for (;;) {
            const page = await p.readChangedSystems(scope, {
              since,
              ...(after ? { after } : {}),
              limit: SYSTEMS_PER_STEP,
            });
            const systemIds = page.systemIds;
            if (systemIds.length) {
              const read = await p.readInput(scope, { kind: 'systems', systemIds });
              if (read.kind !== 'read')
                throw new ProjectionUnavailable(read.kind === 'unavailable' ? read.reason : 'temporarily_unavailable');
              const [stored, chunks, rows] = await Promise.all([
                p.store.objectsOfSystems(scope, systemIds),
                p.store.currentChunks(scope, systemIds),
                p.store.systems(scope, systemIds),
              ]);
              const projection = projectSystems({
                input: read.input,
                systemIds,
                stored,
                chunks,
                rows: new Map(rows.map((row) => [row.systemId, row])),
                layout,
                worldSeed,
                revisions,
                hash: p.hash,
              });
              layout = projection.layout;
              const objects = projection.systems.flatMap((system) => system.objects);
              // Looks are given in the same transaction as the places they describe, never from what is in use now:
              // an object that already has one keeps it (D-102).
              const { created, skipped } = missingLooks(
                objects,
                read.input,
                await p.store.looksOf(
                  scope,
                  objects.map((o) => o.descriptor.objectId),
                ),
                use,
              );
              // A region past its planet's sites stays without a look and the scene stays current (D-102).
              lookRefusals.push(...skipped.map((region) => region.reason));
              await p.store.saveObjects(
                scope,
                projection.systems.flatMap((system) => system.upserts),
              );
              await p.store.saveChunks(
                scope,
                projection.systems.flatMap((system) => system.changed),
              );
              await p.store.saveLooks(scope, created);
              const lookedAt = new Set(
                created.map((look) => objects.find((o) => o.descriptor.objectId === look.objectId)?.systemId),
              );
              const priorRows = new Map(rows.map((row) => [row.systemId, row]));
              const next: SystemRow[] = projection.systems.flatMap((system) => {
                const before = priorRows.get(system.systemId);
                const touched = before === undefined || system.touched || lookedAt.has(system.systemId);
                return before === undefined || touched || before.cell !== system.cell
                  ? [
                      {
                        systemId: system.systemId,
                        cell: system.cell,
                        planetCount: system.planetCount,
                        objectCount: system.objectCount,
                        sceneRevision: touched || before === undefined ? sceneRevision : before.sceneRevision,
                      },
                    ]
                  : [];
              });
              await p.store.saveSystems(scope, next);
            }
            if (!page.more) break;
            after = systemIds.at(-1);
          }
          await p.store.saveState(scope, { policyVersion, worldSeed, projected: revisions, layout });
        } catch (error) {
          // Canonical parsers never echo input. Bad labels/versions fail closed; bounds remain explicit.
          const reason = error instanceof ProjectionUnavailable ? error.reason : 'temporarily_unavailable';
          if (
            !(error instanceof ProjectionUnavailable) &&
            !(error instanceof LookRefused) &&
            !(error instanceof Error && error.name === 'SceneParseError')
          )
            throw error;
          // The plan and the stored objects disagree: the scene is unavailable, and the cause is logged.
          if (error instanceof LookRefused) lookRefusals.push(error.reason);
          await p.store.rollback(scope);
          await p.store.saveState(scope, {
            policyVersion,
            worldSeed,
            ...(old?.projected ? { projected: old.projected } : {}),
            layout: old?.layout ?? { legacyReach: 0, nextCell: 0 },
            failure: { geographyRevision: input.geography.revision, reason },
          });
          return;
        }
        await p.notify(scope, await p.advance(scope));
      },
    );
    for (const reasonCode of lookRefusals) p.logEvent('scenes.look_refused', { reasonCode });
  };
}
