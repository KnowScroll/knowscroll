import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SceneManifestReadSchema,
  problemDetails,
  type GeographyObject,
  type SceneClientCapabilities,
  type SceneDescriptor,
  type FormationPresentationFact,
} from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createFormationPresentationSession } from './formation-presentation';
import type { UniverseSceneState } from './universe-scene';

// Authored actual-transport fixtures, not formed personal Geography or deployed backend proof.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const base = Date.parse('2026-10-22T00:00:00.000Z');
const time = (elapsed = 0) => new Date(base + elapsed).toISOString();
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'formation@fixture.test' };
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const objects: GeographyObject[] = [
  {
    id: id(10),
    kind: 'system',
    parent: { kind: 'universe', id: account.universeId },
    objectRevision: 1,
    originTransitionId: id(90),
    label: 'CI system',
    truthStatus: 'factual',
    activity: { availability: 'available', state: 'active' },
  },
  {
    id: id(11),
    kind: 'star',
    parent: { kind: 'system', id: id(10) },
    objectRevision: 1,
    originTransitionId: id(90),
    label: 'CI star',
    truthStatus: 'factual',
    activity: { availability: 'available', state: 'active' },
  },
  {
    id: id(12),
    kind: 'planet',
    parent: { kind: 'system', id: id(10) },
    objectRevision: 1,
    originTransitionId: id(90),
    label: 'CI planet',
    truthStatus: 'factual',
    activity: { availability: 'available', state: 'active' },
  },
];
const revisions = {
  geographyRevision: 3,
  structureRevision: 3,
  activityRevision: 0,
  sceneRevision: 7,
  personalRevision: 35,
};
const descriptors: SceneDescriptor[] = objects.map((o, n) => ({
  schemaVersion: 'scene-descriptor.v1',
  generatorVersion: 'silhouette.v1',
  objectId: o.id,
  parentId: o.parent.id,
  kind: o.kind,
  originTransitionId: o.originTransitionId,
  label: o.label,
  truthStatus: o.truthStatus,
  activity: o.activity,
  family: 'terraced.v1',
  seed: 'a'.repeat(32),
  palette: 'sage',
  material: 'solid',
  atmosphere: { density: 0.1 },
  detail: { roughness: 0.2 },
  anchor: { x: n * 100, y: 0, layer: 0 },
  target: { kind: o.kind, objectId: o.id },
}));
function projection(caps = capabilities): UniverseSceneState {
  return {
    status: 'ready',
    active: true,
    geography: {
      universeId: account.universeId,
      privacyEpoch: 1,
      personalWatermark: 40,
      geography: { revision: 3, structureRevision: 3, activityRevision: 0 },
      status: 'ready',
      objects,
      routes: [],
      aliases: [],
    },
    snapshot: {
      read: (() => {
        const value = SceneManifestReadSchema.parse({
          version: 'scene-manifest-read.v1',
          selection: { kind: 'universe' },
          capabilities: caps,
          scope: { universeId: account.universeId, privacyEpoch: 1, personalWatermark: 40 },
          recordedAt: time(),
          currentGeography: { revision: 3, structureRevision: 3, activityRevision: 0 },
          sceneRevision: 7,
          status: 'ready',
          manifest: {
            schemaVersion: 'scene-manifest.v1',
            revisions,
            chunks: [{ chunkId: id(92), sceneRevision: 7, objectIds: objects.map((o) => o.id) }],
          },
        });
        if (value.status !== 'ready') throw new Error('Authored ready projection');
        return value;
      })(),
      chunks: [{ schemaVersion: 'scene-chunk.v1', chunkId: id(92), revisions, objects: descriptors, routes: [] }],
    },
  };
}
const fact: FormationPresentationFact = {
  transitionId: id(90),
  recordedAt: time(),
  geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
  targets: objects.map((o) => ({
    objectId: o.id,
    parentId: o.parent.id,
    kind: o.kind,
    objectRevision: 1,
    label: o.label,
    truthStatus: o.truthStatus,
  })),
  sequence: { kind: 'planet', planetId: id(12), newSystem: { systemId: id(10), starId: id(11) }, durationMs: 2400 },
};
type Body = Record<string, unknown>;
const scopes: AccountScope[] = [];
afterEach(() => {
  scopes.splice(0).forEach((s) => s.end());
  vi.useRealTimers();
});
function harness(reducedMotion = false) {
  let watermark = 40;
  let elapsed = 0,
    sequence = 100,
    unknown: 'claim' | 'acknowledge' | undefined;
  let mutate: ((path: string, value: Body) => unknown) | undefined;
  let gate: Promise<void> | undefined;
  let current = projection({ ...capabilities, reducedMotion });
  let caps = { ...capabilities, reducedMotion };
  const calls: { path: string; body: Body }[] = [],
    store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    authorization: () => undefined,
    baseUrl: 'https://formation.fixture.test',
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Body;
      calls.push({ path, body });
      const action = path.split('/').at(-1)!;
      if (action === unknown) throw new TypeError('Authored unknown outcome');
      if (action === 'claim') await gate;
      const scopeValue = {
        universeId: account.universeId,
        privacyEpoch: 1,
        personalWatermark: (watermark = Math.max(watermark, action === 'read' ? 40 : action === 'claim' ? 41 : 42)),
      };
      const claim = { claimId: id(93), claimedAt: time(), expiresAt: time(30000) };
      const value: Body =
        action === 'read'
          ? {
              ...body,
              scope: scopeValue,
              recordedAt: time(elapsed),
              currentGeography: current.geography!.geography,
              sceneRevision: 7,
              status: 'available',
              fact,
              eligibility: { status: 'claimable', until: time(300000) },
            }
          : action === 'claim'
            ? {
                version: body.version,
                scope: scopeValue,
                receipt: {
                  commandId: body.commandId,
                  transitionId: body.transitionId,
                  attemptNonce: body.attemptNonce,
                  outcome: 'claimed',
                  recordedAt: time(),
                  claim,
                },
                replayed: false,
                current: {
                  status: 'active',
                  claimId: claim.claimId,
                  expiresAt: claim.expiresAt,
                  observedAt: time(elapsed),
                },
              }
            : {
                ...body,
                scope: scopeValue,
                recordedAt: time(elapsed),
                replayed: false,
                requestedDisposition: body.disposition,
                outcome: 'recorded',
              };
      const reply = mutate ? mutate(action, value) : value;
      return reply instanceof Response ? reply : Response.json(reply);
    },
  });
  scopes.push(scope);
  const session = createFormationPresentationSession({
    scope,
    newId: () => id(sequence++),
    projection: () => current,
    capabilities: () => caps,
    now: () => base + elapsed,
    monotonic: () => elapsed,
  });
  return {
    scope,
    store,
    calls,
    session,
    advance: (ms: number) => {
      elapsed += ms;
    },
    unknown: (action: typeof unknown) => {
      unknown = action;
    },
    mutate: (fn: typeof mutate) => {
      mutate = fn;
    },
    gate: (promise: Promise<void>) => {
      gate = promise;
    },
    projection: (p: UniverseSceneState) => {
      current = p;
      session.update();
    },
    caps: () => {
      caps = { ...caps, detail: 'low' };
      session.update();
    },
  };
}
const ready = async (h: ReturnType<typeof harness>) => {
  h.session.setForeground(true);
  await vi.waitFor(() => expect(h.session.getState().status).toBe('ready'));
};
const commands = (h: ReturnType<typeof harness>, action: string) =>
  h.calls.filter((c) => c.path.endsWith('/' + action));

describe('durable formation consumer over labelled HTTP fixtures', () => {
  it('pure read precedes a fresh exact claim; synchronous start wins once, and shown requires all2400 actual mounted foreground milliseconds', async () => {
    const h = harness();
    await ready(h);
    expect(h.calls.map((c) => c.path)).toEqual(['/v1/universe/formation/read', '/v1/universe/formation/claim']);
    expect(commands(h, 'acknowledge')).toHaveLength(0);
    expect(h.session.complete()).toBe(false);
    expect(h.session.mounted()).toBe(true);
    expect(h.session.mounted()).toBe(false);
    h.advance(2399);
    expect(h.session.complete()).toBe(false);
    h.advance(1);
    expect(h.session.complete()).toBe(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    const claim = commands(h, 'claim')[0]!.body,
      ack = commands(h, 'acknowledge')[0]!.body;
    expect(ack).toMatchObject({
      transitionId: fact.transitionId,
      claimId: id(93),
      attemptNonce: claim.attemptNonce,
      disposition: 'shown',
    });
    expect(ack.commandId).not.toBe(claim.commandId);
    expect(h.store.keys()).toEqual([]);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    await h.session.refresh();
    expect(commands(h, 'claim')).toHaveLength(1);
    expect(h.session.mounted()).toBe(false);
  });
  it('mounted reduced-motion final still can be shown; a claim without an actual mounted still cannot', async () => {
    const h = harness(true);
    await ready(h);
    expect(h.session.complete()).toBe(false);
    expect(h.session.mounted()).toBe(true);
    expect(h.session.complete()).toBe(true);
    await vi.waitFor(() => expect(commands(h, 'acknowledge')).toHaveLength(1));
    expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('shown');
  });
  it.each(['before_claim_ack', 'after_claim_ack'] as const)(
    'own root hint %s waits for strict ready before starting, then retains the same validated mounted certificate through a refresh',
    async (phase) => {
      const h = harness();
      const accepted = projection();
      h.projection(accepted);
      let release!: () => void;
      if (phase === 'before_claim_ack')
        h.gate(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
      h.session.setForeground(true);
      if (phase === 'before_claim_ack') {
        await vi.waitFor(() => expect(commands(h, 'claim')).toHaveLength(1));
        h.projection({ ...accepted, status: 'loading' });
        release();
      } else {
        await vi.waitFor(() => expect(h.session.getState().status).toBe('ready'));
        h.projection({ ...accepted, status: 'loading' });
      }
      await vi.waitFor(() => expect(h.session.getState().status).toBe('waiting'));
      expect(h.session.mounted()).toBe(false);
      expect(commands(h, 'acknowledge')).toHaveLength(0);
      h.projection(accepted);
      expect(h.session.getState().status).toBe('ready');
      const selected = h.session.getState().fact!;
      expect(h.session.mounted(selected)).toBe(true);
      h.advance(1100);
      h.projection({ ...accepted, status: 'loading' });
      expect(h.session.getState().status).toBe('presenting');
      expect(h.session.mounted(selected)).toBe(false);
      h.advance(1299);
      expect(h.session.complete(selected)).toBe(false);
      h.advance(1);
      expect(h.session.complete(selected)).toBe(true);
      await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
      expect(commands(h, 'acknowledge')).toHaveLength(1);
      expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('shown');
      // Its own acknowledgement hint also retains the locally completed final still.
      h.projection({ ...accepted, status: 'loading' });
      expect(h.session.getState().fact).toBe(selected);
      expect(h.session.getState().completed).toBe(true);
    },
  );
  it('a mounted reduced still may complete through its own retained refresh, but newly ready mismatched targets interrupt instead of reusing that certificate', async () => {
    const h = harness(true);
    const accepted = projection({ ...capabilities, reducedMotion: true });
    h.projection(accepted);
    await ready(h);
    expect(h.session.mounted()).toBe(true);
    h.projection({ ...accepted, status: 'loading' });
    expect(h.session.complete()).toBe(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    const other = harness();
    const original = projection();
    other.projection(original);
    await ready(other);
    expect(other.session.mounted()).toBe(true);
    other.projection({ ...original, status: 'loading' });
    other.projection({
      ...original,
      geography: { ...original.geography!, objects: objects.map((o) => ({ ...o, label: 'Changed actual label' })) },
    });
    await vi.waitFor(() => expect(other.session.getState().status).toBe('final'));
    expect(commands(other, 'acknowledge')[0]!.body.disposition).toBe('skipped');
    expect(other.session.complete()).toBe(false);
  });
  it('loading with a different snapshot or explicit pending projection is not the retained certificate', async () => {
    for (const pending of [false, true]) {
      const h = harness();
      const accepted = projection();
      h.projection(accepted);
      await ready(h);
      h.session.mounted();
      h.projection(
        pending
          ? {
              ...accepted,
              status: 'loading',
              pendingProjection: { geographyRevision: 4, personalRevision: 36 },
            }
          : { ...accepted, status: 'loading', snapshot: { ...accepted.snapshot! } },
      );
      await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
      expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('skipped');
    }
  });
  it('unknown claim keeps the identical body and nonce across focus, then current active replay may start exactly once', async () => {
    const h = harness();
    h.unknown('claim');
    h.session.setForeground(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('claim_unknown'));
    expect(h.session.mounted()).toBe(false);
    h.session.setForeground(true);
    expect(commands(h, 'claim')).toHaveLength(1);
    h.unknown(undefined);
    h.session.retry();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('ready'));
    expect(commands(h, 'claim')[1]!.body).toEqual(commands(h, 'claim')[0]!.body);
    expect(h.session.mounted()).toBe(true);
    expect(h.session.mounted()).toBe(false);
  });
  it('leaving during an ambiguous claim stops locally and accepts only skipped after original explicit retry', async () => {
    const h = harness();
    h.unknown('claim');
    h.session.setForeground(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('claim_unknown'));
    h.session.setForeground(false);
    h.session.setForeground(true);
    h.unknown(undefined);
    h.session.retry();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    expect(commands(h, 'claim')[1]!.body).toEqual(commands(h, 'claim')[0]!.body);
    expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('skipped');
    expect(h.session.mounted()).toBe(false);
  });
  it('unknown shown ACK survives a later interruption and auth refusal without becoming skipped or a new command', async () => {
    const h = harness(true);
    await ready(h);
    h.session.mounted();
    h.unknown('acknowledge');
    h.session.complete();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('ack_unknown'));
    h.session.setForeground(false);
    h.session.setForeground(true);
    expect(commands(h, 'acknowledge')).toHaveLength(1);
    h.unknown(undefined);
    h.mutate((action, value) => {
      if (action === 'acknowledge')
        return new Response(JSON.stringify(problemDetails('UNAUTHENTICATED')), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        });
      return value;
    });
    h.session.retry();
    await vi.waitFor(() => expect(commands(h, 'acknowledge')).toHaveLength(2));
    await vi.waitFor(() => expect(h.session.getState().status).toBe('ack_unknown'));
    h.mutate(undefined);
    h.session.retry();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    expect(commands(h, 'acknowledge').map((c) => c.body)).toEqual(Array(3).fill(commands(h, 'acknowledge')[0]!.body));
    expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('shown');
  });
  it.each(['readId', 'scope', 'capabilities', 'scene', 'geography', 'target'] as const)(
    'refuses mismatched %s before a claim',
    async (wrong) => {
      const h = harness();
      h.mutate((action, v) => {
        if (action !== 'read') return v;
        if (wrong === 'readId') return { ...v, readId: id(999) };
        if (wrong === 'scope') return { ...v, scope: { universeId: id(999), privacyEpoch: 1, personalWatermark: 40 } };
        if (wrong === 'capabilities') return { ...v, capabilities: { ...capabilities, detail: 'low' } };
        if (wrong === 'scene') return { ...v, sceneRevision: 8 };
        if (wrong === 'geography')
          return { ...v, currentGeography: { revision: 4, structureRevision: 4, activityRevision: 0 } };
        return { ...v, fact: { ...fact, targets: fact.targets.map((t) => ({ ...t, label: 'Wrong label' })) } };
      });
      h.session.setForeground(true);
      await vi.waitFor(() => expect(['unavailable', 'final']).toContain(h.session.getState().status));
      expect(commands(h, 'claim')).toHaveLength(0);
      expect(h.session.mounted()).toBe(false);
    },
  );
  it.each(['command', 'nonce', 'scope'] as const)('never starts an unrelated %s claim response', async (wrong) => {
    const h = harness();
    h.mutate((action, v) =>
      action !== 'claim'
        ? v
        : wrong === 'scope'
          ? { ...v, scope: { universeId: id(999), privacyEpoch: 1, personalWatermark: 41 } }
          : {
              ...v,
              receipt: { ...(v.receipt as Body), [wrong === 'command' ? 'commandId' : 'attemptNonce']: id(999) },
            },
    );
    h.session.setForeground(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('claim_unknown'));
    expect(h.session.mounted()).toBe(false);
    expect(commands(h, 'acknowledge')).toHaveLength(0);
  });
  it('historical claimed receipt with current final never grants animation or a new nonce', async () => {
    const h = harness();
    h.mutate((action, v) =>
      action === 'claim'
        ? { ...v, replayed: true, current: { status: 'final', observedAt: time(30000), reason: 'expired' } }
        : v,
    );
    h.session.setForeground(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    expect(h.session.mounted()).toBe(false);
    expect(commands(h, 'acknowledge')).toHaveLength(0);
  });
  it('a newer scene root arriving during claim requires a current nonregressive command envelope before starting', async () => {
    const h = harness();
    let release!: () => void;
    h.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    h.session.setForeground(true);
    await vi.waitFor(() => expect(commands(h, 'claim')).toHaveLength(1));
    const p = projection();
    h.projection({ ...p, geography: { ...p.geography!, personalWatermark: 45 } });
    release();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('claim_unknown'));
    expect(h.session.mounted()).toBe(false);
    h.mutate((action, value) =>
      action === 'claim'
        ? { ...value, scope: { universeId: account.universeId, privacyEpoch: 1, personalWatermark: 46 } }
        : value,
    );
    h.session.retry();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('ready'));
    expect(commands(h, 'claim')[1]!.body).toEqual(commands(h, 'claim')[0]!.body);
    expect(h.session.mounted()).toBe(true);
  });
  it('projection or capability replacement interrupts actual mounted time and never acknowledges shown', async () => {
    const h = harness();
    await ready(h);
    h.session.mounted();
    h.advance(1000);
    h.caps();
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
    expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('skipped');
    expect(h.session.complete()).toBe(false);
  });
  it('expiry while still foreground ends the mounted attempt with skipped, never a renewed claim or delayed shown', async () => {
    vi.useFakeTimers();
    const h = harness();
    await ready(h);
    const selected = h.session.getState().fact!;
    expect(h.session.mounted(selected)).toBe(true);
    h.advance(30000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.session.getState().status).toBe('final');
    expect(h.session.getState().fact).toBeUndefined();
    expect(commands(h, 'acknowledge')).toHaveLength(1);
    expect(commands(h, 'acknowledge')[0]!.body.disposition).toBe('skipped');
    expect(h.session.complete(selected)).toBe(false);
    h.session.setForeground(true);
    expect(commands(h, 'claim')).toHaveLength(1);
  });
  it.each(['commandId', 'transitionId', 'claimId', 'attemptNonce', 'requestedDisposition', 'recordedAt'] as const)(
    'keeps an unknown acknowledgement immutable after mismatched %s, rather than accepting unrelated success',
    async (wrong) => {
      const h = harness(true);
      await ready(h);
      h.mutate((action, value) => {
        if (action !== 'acknowledge') return value;
        if (wrong === 'requestedDisposition')
          return { ...value, requestedDisposition: 'skipped', disposition: 'skipped' };
        return { ...value, [wrong]: wrong === 'recordedAt' ? time(-1) : id(999) };
      });
      h.session.mounted();
      h.session.complete();
      await vi.waitFor(() => expect(h.session.getState().status).toBe('ack_unknown'));
      const original = commands(h, 'acknowledge')[0]!.body;
      h.session.skip();
      h.mutate(undefined);
      h.session.retry();
      await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
      expect(commands(h, 'acknowledge').map((c) => c.body)).toEqual([original, original]);
      expect(original.disposition).toBe('shown');
    },
  );
  it('stale surface callbacks cannot start, interrupt or complete another immutable candidate', async () => {
    const h = harness(true);
    await ready(h);
    const current = h.session.getState().fact!;
    const stale = { ...current };
    expect(h.session.mounted(stale)).toBe(false);
    h.session.skip(stale);
    expect(h.session.getState().status).toBe('ready');
    expect(commands(h, 'acknowledge')).toHaveLength(0);
    expect(h.session.mounted(current)).toBe(true);
    expect(h.session.complete(stale)).toBe(false);
    expect(h.session.complete(current)).toBe(true);
    await vi.waitFor(() => expect(h.session.getState().status).toBe('final'));
  });
  it('scope end fences a late claim, purges targets/timers and cannot dispatch under an identical-ID replacement scope', async () => {
    const h = harness();
    let release!: () => void;
    h.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    h.session.setForeground(true);
    await vi.waitFor(() => expect(commands(h, 'claim')).toHaveLength(1));
    h.scope.end();
    expect(h.session.getState()).toEqual({ status: 'ended' });
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(commands(h, 'acknowledge')).toHaveLength(0);
    expect(h.session.mounted()).toBe(false);
    const next = harness();
    expect(next.scope.id).toBe(h.scope.id);
    expect(next.session.getState().status).toBe('idle');
  });
});
