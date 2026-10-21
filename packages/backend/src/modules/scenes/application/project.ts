import { ProjectSceneJobSchema } from '../events.js';
import { projectBounded, ProjectionUnavailable, SCENE_POLICY } from './projection.js';
import type { ProjectScene, ScenePorts, StoredChunk } from './ports.js';
/** Old deliveries coalesce onto latest Geography; persisted stamps make crash-after-commit replay inert. */
export function makeProjectScene(p: ScenePorts): ProjectScene {
  return async (payload) => {
    const job = ProjectSceneJobSchema.parse(payload);
    await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'scenes.project' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return;
        const read = await p.readInput(scope);
        if (read.kind !== 'read') return;
        const input = read.input,
          old = await p.store.state(scope);
        if (
          old?.manifest &&
          old.manifest.revisions.geographyRevision === input.geography.revision &&
          old.manifest.revisions.structureRevision === input.geography.structureRevision &&
          old.manifest.revisions.activityRevision === input.geography.activityRevision
        )
          return;
        if (!input.objects.length && !old) return;
        const prior = await p.store.objects(scope),
          chunks: StoredChunk[] = [];
        for (const ref of old?.manifest?.chunks ?? []) {
          const c = await p.store.chunk(scope, ref.chunkId, ref.sceneRevision);
          if (!c) throw new Error('SCENE_CURRENT_CHUNK_MISSING');
          chunks.push(c);
        }
        const worldSeed = old?.worldSeed ?? p.seed();
        try {
          const projection = projectBounded(
            input,
            prior,
            chunks,
            worldSeed,
            (old?.manifest?.revisions.sceneRevision ?? 0) + 1,
            p.hash,
            old?.routeChunks,
          );
          await p.store.save(
            scope,
            {
              worldSeed,
              policyVersion: SCENE_POLICY,
              routeChunks: projection.routeChunks,
              manifest: projection.manifest,
            },
            projection.objects,
            projection.changed,
          );
        } catch (error) {
          // Canonical parsers never echo input. Bad labels/versions fail closed; bounds remain explicit.
          const reason = error instanceof ProjectionUnavailable ? error.reason : 'temporarily_unavailable';
          if (
            !(error instanceof ProjectionUnavailable) &&
            !(error instanceof Error && error.name === 'SceneParseError')
          )
            throw error;
          await p.store.save(
            scope,
            {
              worldSeed,
              policyVersion: SCENE_POLICY,
              routeChunks: old?.routeChunks ?? [],
              ...(old?.manifest ? { manifest: old.manifest } : {}),
              failure: { geographyRevision: input.geography.revision, reason },
            },
            [],
            [],
          );
          return;
        }
        await p.notify(scope, await p.advance(scope));
      },
    );
  };
}
