import {
  ReadSceneSkySchema,
  SceneSkyReadSchema,
  supportsSceneLooks,
  supportsSceneSky,
  type SceneSkySystem,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ReadOwnSceneSky, ScenePorts, SceneState } from './ports.js';
import { geographyUnavailable, projectionStatus, readBase } from './read.js';

/**
 * The sky: every system of the person's own map in one compact entry each, a page at a time (D-417). It is the first
 * read of a client that declared `scene-sky.v1`, and it asks Geography only for the revisions, never for a place.
 * `sinceSceneRevision` makes it a refresh that lists only the systems that changed after a revision the client holds.
 * Readonly: it enqueues nothing, and a world still in the older shape is not served until its next projection.
 */
export function makeReadSceneSky(p: ScenePorts): ReadOwnSceneSky {
  return async (authority, query) => {
    const q = ReadSceneSkySchema.parse(query);
    const result = await p.withScope(authority, async (scope: PersonalScopeTx) => {
      if (!(await p.ownerActive(scope))) return { kind: 'refused', reason: 'scope_refused' } as const;
      const read = await p.readInput(scope, { kind: 'head' });
      if (read.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' } as const;
      const reply = (data: object, state: SceneState | undefined, head: Parameters<typeof readBase>[2]) => ({
        kind: 'read' as const,
        scene: SceneSkyReadSchema.parse({
          version: 'scene-sky-read.v1',
          capabilities: q.capabilities,
          ...readBase(p, scope, head, state),
          ...(q.sinceSceneRevision === undefined ? {} : { sinceSceneRevision: q.sinceSceneRevision }),
          ...data,
        }),
      });
      if (read.kind === 'unavailable') {
        const { head, fields } = geographyUnavailable(read, supportsSceneSky(q.capabilities));
        return reply(fields, undefined, head);
      }
      const head = read.input,
        state = await p.store.state(scope);
      if (!supportsSceneSky(q.capabilities)) return reply({ status: 'unsupported_version' }, state, head);
      if (!head.objectCount && !state?.projected) return reply({ status: 'empty' }, state, head);
      const current = await projectionStatus(p, scope, head, state);
      if (current.kind === 'unavailable') return reply({ status: 'unavailable', reason: current.reason }, state, head);
      if (!state?.projected)
        return reply(
          { status: 'loading', pendingProjection: current.kind === 'pending' ? current.pending : undefined },
          state,
          head,
        );
      // A page read at an older revision would mix two maps: start again from the first page.
      if (q.cursor !== undefined && q.cursor.sceneRevision !== state.projected.sceneRevision)
        return reply({ status: 'unavailable', reason: 'snapshot_expired' }, state, head);
      const rows = await p.store.sky(scope, {
        limit: q.limit + 1,
        ...(q.cursor ? { after: q.cursor.afterSystemId } : {}),
        ...(q.sinceSceneRevision === undefined ? {} : { since: q.sinceSceneRevision }),
      });
      const page = rows.slice(0, q.limit).map((row): SceneSkySystem => ({
        descriptor: row.descriptor,
        ...(row.haze !== undefined && supportsSceneLooks(q.capabilities) ? { haze: row.haze } : {}),
        planetCount: row.planetCount,
        sceneRevision: row.sceneRevision,
      }));
      return reply(
        {
          status: current.kind === 'pending' ? 'lagging' : 'ready',
          ...(current.kind === 'pending' ? { pendingProjection: current.pending } : {}),
          revisions: state.projected,
          systems: page,
          continuation:
            rows.length > q.limit
              ? {
                  status: 'more',
                  cursor: {
                    sceneRevision: state.projected.sceneRevision,
                    afterSystemId: page.at(-1)!.descriptor.objectId,
                  },
                }
              : { status: 'complete' },
        },
        state,
        head,
      );
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
