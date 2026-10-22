import { waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import type { KeepPosition, SetKeepPlace } from '@knowscroll/contracts';
import { createKeepSurface } from './keep-surface';

jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
/** Real scope/Keep session over authored protocol responses; no live media or backend claim. */
function fixture(kind: 'reel' | 'scroll' = 'reel') {
  let saved = true;
  let unknownSave = false;
  let revision = 1;
  let next = 30;
  let position: KeepPosition =
    kind === 'reel' ? { kind, positionMs: 10 } : { kind, blockId: 'canonical-block', offsetWithinBlock: 10 };
  let actual: KeepPosition | undefined;
  let gate: Promise<void> | undefined;
  const target = { assetId: id(3), assetRevision: 1 };
  const entry = { ...target, savedEntryId: id(4) };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const scopeRef = { accountId: id(1), privacyEpoch: 1 };
  const scope = createAccountScope({
    account: { ...scopeRef, universeId: id(2), email: 'surface@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('/keep/read')) {
        await gate;
        return json(
          saved
            ? {
                version: 'keep-place.v1',
                scope: scopeRef,
                target,
                status: 'available',
                entry,
                place: { status: 'set', placeRevision: revision, position },
              }
            : { version: 'keep-place.v1', scope: scopeRef, target, status: 'not_saved' },
        );
      }
      if (path.endsWith('/keep/place')) {
        const command = body as unknown as SetKeepPlace;
        revision = command.expectedPlaceRevision + 1;
        position = command.position;
        return json({
          version: 'keep-place.v1',
          scope: scopeRef,
          commandId: command.commandId,
          recordedAt: '2026-10-22T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry,
          basePlaceRevision: command.expectedPlaceRevision,
          acceptedPlaceRevision: revision,
        });
      }
      if (path === '/v1/actions') {
        if (unknownSave) throw new Error('Authored lost acknowledgement');
        saved = true;
        return json({
          commandId: body.commandId,
          actionId: id(8),
          kind: 'save',
          ...target,
          saved: true,
          changed: true,
          revision: 2,
          replayed: false,
        });
      }
      throw new Error('Unexpected authored route');
    },
  });
  const capture = jest.fn(() => actual);
  return {
    scope,
    target,
    calls,
    capture,
    surface: createKeepSurface({ scope, target, exposureId: id(9), capture, newId: () => id(next++) }),
    setActual: (value: KeepPosition | undefined) => {
      actual = value;
    },
    unsaved: () => {
      saved = false;
    },
    failSave: (value: boolean) => {
      unknownSave = value;
    },
    gateRead: (value: Promise<void>) => {
      gate = value;
    },
  };
}
describe('direct route actual Keep surface lifecycle', () => {
  it.each(['reel', 'scroll'] as const)(
    'warms %s without uploading and captures before stop with post-ACK read',
    async (kind) => {
      const f = fixture(kind);
      try {
        f.surface.start();
        await waitFor(() => expect(f.surface.getState().place.status).toBe('ready'));
        expect(f.capture).not.toHaveBeenCalled();
        expect(f.calls.some((c) => c.path.endsWith('/keep/place'))).toBe(false);
        const actual: KeepPosition =
          kind === 'reel'
            ? { kind, positionMs: 1234.5 }
            : { kind, blockId: 'canonical-block', offsetWithinBlock: 63.5 };
        f.setActual(actual);
        f.surface.stop();
        await waitFor(() => expect(f.calls.filter((c) => c.path.endsWith('/keep/place'))).toHaveLength(1));
        expect(f.calls.find((c) => c.path.endsWith('/keep/place'))?.body.position).toEqual(actual);
        await waitFor(() => expect(f.calls.filter((c) => c.path.endsWith('/keep/read')).length).toBeGreaterThan(1));
        expect(f.calls.every((c) => c.path.includes('/keep/'))).toBe(true);
      } finally {
        f.scope.end();
      }
    },
  );
  it('ignores absent actual geometry, including when a stored place exists', async () => {
    const f = fixture();
    try {
      f.surface.start();
      await waitFor(() => expect(f.surface.getState().place.status).toBe('ready'));
      expect(f.surface.checkpoint()).toBe(false);
      f.surface.stop();
      expect(f.calls.some((c) => c.path.endsWith('/keep/place'))).toBe(false);
    } finally {
      f.scope.end();
    }
  });
  it('keeps an unknown Save identical and captures actual position only after confirmed Save/read', async () => {
    const f = fixture();
    try {
      f.unsaved();
      f.failSave(true);
      f.setActual({ kind: 'reel', positionMs: 987.5 });
      f.surface.start();
      await waitFor(() => expect(f.surface.getState().place.snapshot?.status).toBe('not_saved'));
      await f.surface.save();
      expect(f.surface.getState().save).toBe('unknown');
      expect(f.calls.some((c) => c.path.endsWith('/keep/place'))).toBe(false);
      f.failSave(false);
      await f.surface.save();
      await waitFor(() => expect(f.surface.getState().place.write).toBe('idle'));
      const saves = f.calls.filter((c) => c.path === '/v1/actions');
      expect(saves).toHaveLength(2);
      expect(saves[1]?.body).toEqual(saves[0]?.body);
      expect(f.calls.find((c) => c.path.endsWith('/keep/place'))?.body.position).toEqual({
        kind: 'reel',
        positionMs: 987.5,
      });
    } finally {
      f.scope.end();
    }
  });
  it('retains an unknown direct Save across controller remounts and retries its originating exposure command', async () => {
    const f = fixture();
    try {
      f.unsaved();
      f.failSave(true);
      f.surface.start();
      await waitFor(() => expect(f.surface.getState().place.snapshot?.status).toBe('not_saved'));
      await f.surface.save();
      f.surface.stop();
      const again = createKeepSurface({
        scope: f.scope,
        target: f.target,
        exposureId: id(99),
        capture: () => ({ kind: 'reel', positionMs: 321.5 }),
        newId: () => id(100),
      });
      expect(again.getState().save).toBe('unknown');
      again.start();
      f.failSave(false);
      expect(await again.save()).toBe(true);
      const saves = f.calls.filter((c) => c.path === '/v1/actions');
      expect(saves).toHaveLength(2);
      expect(saves[1]?.body).toEqual(saves[0]?.body);
      expect(saves[1]?.body.exposureId).toBe(id(9));
      again.stop();
    } finally {
      f.scope.end();
    }
  });
  it('never attaches a frozen capture after a pending read outlives the actual surface', async () => {
    const f = fixture();
    let release!: () => void;
    try {
      f.gateRead(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      f.setActual({ kind: 'reel', positionMs: 250 });
      f.surface.start();
      const pending = f.surface.captureFresh();
      f.surface.stop();
      release();
      f.scope.end();
      expect(await pending).toBe(false);
      expect(f.calls.some((c) => c.path.endsWith('/keep/place'))).toBe(false);
      expect(f.surface.getState()).toEqual({ place: { status: 'ended', write: 'idle' }, save: 'idle' });
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      release?.();
      f.scope.end();
    }
  });
});
