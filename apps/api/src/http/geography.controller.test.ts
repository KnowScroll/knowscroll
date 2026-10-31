import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { EmergingUniverse, GeographySnapshot, PlaceConcepts, UniverseDeltas } from '@knowscroll/contracts';
import type {
  ReadOwnGeography,
  ReadOwnDeltas,
  ReadOwnEmerging,
  ReadOwnPlaceConcepts,
} from '@knowscroll/backend/modules/geography';
import type { Caller } from './callers.js';
import { scopeGuard } from './scope-guard.js';
import { GeographyController } from './geography.controller.js';

const universeId = '0199a000-0000-7000-8000-000000000001';
const accountId = '0199a000-0000-7000-8000-000000000002';
const caller: Caller = { accountId, universeId, privacyEpoch: 2, sessionId: universeId, credential: 'cookie' };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const input = { selection: { kind: 'universe' as const }, limit: 100 };
const deltaInput = { afterGeographyRevision: 0, limit: 10 };
const base = {
  universeId,
  privacyEpoch: 2,
  personalWatermark: 7,
  geography: { revision: 0, structureRevision: 0, activityRevision: 0 },
};
const snapshot: GeographySnapshot = {
  ...base,
  version: 'geography-snapshot.v1',
  recordedAt: '2026-10-20T00:00:00.000Z',
  selection: input.selection,
  status: 'empty',
};
const deltas: UniverseDeltas = {
  ...base,
  version: 'universe-deltas.v1',
  status: 'available',
  afterGeographyRevision: 0,
  deltas: [],
  hasMore: false,
};
const emerging: EmergingUniverse = {
  ...base,
  version: 'universe-emerging.v1',
  recordedAt: '2026-10-20T00:00:00.000Z',
  dust: [{ id: '0199a000-0000-7000-8000-000000000003' }],
};
const concepts: PlaceConcepts = {
  ...base,
  version: 'universe-place-concepts.v1',
  planets: [{ id: '0199a000-0000-7000-8000-000000000004', topicId: 'seasons' }],
};
async function admittedRequest(): Promise<Request> {
  const request = {
    path: '/v1/universe/geography/read',
    headers: { 'x-ks-scope': `${accountId}:2` },
  } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function wired() {
  const read = vi.fn<ReadOwnGeography>(() => Promise.resolve({ kind: 'read', snapshot }));
  const changes = vi.fn<ReadOwnDeltas>(() => Promise.resolve({ kind: 'read', deltas }));
  const gathering = vi.fn<ReadOwnEmerging>(() => Promise.resolve({ kind: 'read', emerging }));
  const places = vi.fn<ReadOwnPlaceConcepts>(() => Promise.resolve({ kind: 'read', concepts }));
  return { controller: new GeographyController(read, changes, gathering, places), read, changes, gathering, places };
}

describe('Geography guarded read-only HTTP adapter', () => {
  it('uses only admitted authority and returns the independent backend snapshots unchanged', async () => {
    const { controller, read, changes, gathering, places } = wired();
    const request = await admittedRequest();
    expect(await call(controller.readRoute(request), input)).toEqual(snapshot);
    expect(read).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(changes).not.toHaveBeenCalled();
    expect(await call(controller.deltasRoute(request), deltaInput)).toEqual(deltas);
    expect(changes).toHaveBeenCalledExactlyOnceWith(authority, deltaInput);
    expect(read).toHaveBeenCalledOnce();
    expect(await call(controller.emergingRoute(request), {})).toEqual(emerging);
    expect(gathering).toHaveBeenCalledExactlyOnceWith(authority, {});
    expect(await call(controller.placeConceptsRoute(request), {})).toEqual(concepts);
    expect(places).toHaveBeenCalledExactlyOnceWith(authority, {});
  });

  it('maps foreign or missing selection to the same sanitized problem and scope refusal consistently', async () => {
    const read: ReadOwnGeography = () => Promise.resolve({ kind: 'refused', reason: 'selection_not_found' });
    const changes: ReadOwnDeltas = () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' });
    const gathering: ReadOwnEmerging = () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' });
    const places: ReadOwnPlaceConcepts = () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' });
    const controller = new GeographyController(read, changes, gathering, places);
    const request = await admittedRequest();
    await expect(call(controller.placeConceptsRoute(request), {})).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
    await expect(call(controller.readRoute(request), input)).rejects.toMatchObject({ code: 'NOT_FOUND', data: {} });
    await expect(call(controller.emergingRoute(request), {})).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
    await expect(call(controller.deltasRoute(request), deltaInput)).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
    const refused = new GeographyController(
      () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' }),
      changes,
      gathering,
      places,
    );
    await expect(call(refused.readRoute(request), input)).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
  });

  it('refuses unguarded calls before either backend read', async () => {
    const { controller, read, changes, gathering, places } = wired();
    const request = {} as unknown as Request;
    await expect(call(controller.readRoute(request), input)).rejects.toThrow('without the scope guard');
    await expect(call(controller.deltasRoute(request), deltaInput)).rejects.toThrow('without the scope guard');
    await expect(call(controller.emergingRoute(request), {})).rejects.toThrow('without the scope guard');
    await expect(call(controller.placeConceptsRoute(request), {})).rejects.toThrow('without the scope guard');
    expect(places).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(gathering).not.toHaveBeenCalled();
  });

  it('refuses caller authority, commands and oversized windows before dispatch', async () => {
    const { controller, read, changes, gathering } = wired();
    const request = await admittedRequest();
    await expect(
      call(controller.emergingRoute(request), { accountId } as unknown as Record<string, never>),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    for (const value of [
      { ...input, accountId },
      { ...input, commandId: universeId },
      { ...input, limit: 101 },
    ])
      await expect(call(controller.readRoute(request), value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const value of [
      { ...deltaInput, privacyEpoch: 2 },
      { ...deltaInput, limit: 11 },
    ])
      await expect(call(controller.deltasRoute(request), value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(read).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(gathering).not.toHaveBeenCalled();
  });

  it('validates backend output instead of serving malformed geography', async () => {
    const read: ReadOwnGeography = () =>
      Promise.resolve({ kind: 'read', snapshot: { ...snapshot, universeId: 'bad' } });
    const { changes, gathering, places } = wired();
    const controller = new GeographyController(read, changes, gathering, places);
    await expect(call(controller.readRoute(await admittedRequest()), input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
