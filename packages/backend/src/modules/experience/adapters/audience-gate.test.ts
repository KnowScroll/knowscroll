import { describe, expect, it, vi } from 'vitest';
import type { CheckAssetAudience, ReadOfferEncounter } from '../../content/public.js';
import { gateOfferEncounter } from './audience-gate.js';

// Fakes: the gate only passes its scope and request through, so neither is a real transaction or snapshot.
const scope = { authority: { fake: 'authority' } } as unknown as Parameters<ReadOfferEncounter>[0];
const request = { assetId: '0199f0a0-0000-7000-8000-000000000001', assetRevision: 1, capabilities: {} };
const found = { encounter: { assetId: request.assetId }, cover: { kicker: 'Fixture' } } as unknown as Awaited<
  ReturnType<ReadOfferEncounter>
>;

describe('the audience gate on the offer read (a Scroll made for a thread, D-049)', () => {
  it('does not read, and finds nothing, for a caller the check refuses', async () => {
    const read = vi.fn<ReadOfferEncounter>(() => Promise.resolve(found));
    const check: CheckAssetAudience = () => Promise.resolve(new Set());
    expect(await gateOfferEncounter(read, check)(scope, request)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('passes the read result through, cover included, for a caller the check admits', async () => {
    const read = vi.fn<ReadOfferEncounter>(() => Promise.resolve(found));
    const check = vi.fn<CheckAssetAudience>((_on, _authority, ids) => Promise.resolve(new Set(ids)));
    expect(await gateOfferEncounter(read, check)(scope, request)).toBe(found);
    expect(read).toHaveBeenCalledWith(scope, request);
    expect(check).toHaveBeenCalledWith({ scope }, scope.authority, [request.assetId]);
  });
});
