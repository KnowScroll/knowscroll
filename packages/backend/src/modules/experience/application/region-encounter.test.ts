import { describe, expect, it, vi } from 'vitest';
import type { PersonalAuthority } from '../../identity/public.js';
import type { NavigationPorts, NavigateEncounter } from './navigation-ports.js';
import { makeRegionEncounters } from './region-encounter.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: id(2) },
};
const target = { kind: 'region' as const, regionId: id(3), expectedObjectRevision: 1, expectedGeographyRevision: 1 };
const capabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: { fallback: [1], paragraph: [1], subheading: [1] },
};
const command = { version: 'region-encounter-open.v1' as const, commandId: id(4), target, capabilities };
describe('Region facade closed request boundary (synthetic ports only)', () => {
  it('rejects invalid geometry/authority/extra payloads before opening a scope or navigation', async () => {
    const withPersonalScope = vi.fn(),
      navigate = vi.fn<NavigateEncounter>();
    const f = makeRegionEncounters({ withPersonalScope } as unknown as NavigationPorts, navigate);
    for (const input of [
      { ...command, position: { x: 1 } },
      { ...command, target: { ...target, camera: 3 } },
      { ...command, privacyEpoch: 2 },
      { ...command, target: { ...target, expectedObjectRevision: 0 } },
    ])
      expect(await f.open(authority, input)).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
    expect(
      await f.preview(authority, {
        version: 'region-encounter-preview.v1',
        readId: id(5),
        target,
        capabilities,
        commandId: id(4),
      }),
    ).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
    expect(withPersonalScope).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('copies claimed authority and preserves exact supplied session constraints', async () => {
    const navigate = vi.fn<NavigateEncounter>(() =>
      Promise.resolve({ kind: 'refused', code: 'INTENT_REVISION_STALE' }),
    );
    const f = makeRegionEncounters({} as NavigationPorts, navigate),
      input = { ...command, session: { sessionId: id(6), expectedIntentRevision: 2 } };
    expect(await f.open(authority, input)).toEqual({ kind: 'refused', code: 'INTENT_REVISION_STALE' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(navigate.mock.calls[0]![0]).not.toBe(authority);
    expect(Object.isFrozen(navigate.mock.calls[0]![0])).toBe(true);
  });
});
