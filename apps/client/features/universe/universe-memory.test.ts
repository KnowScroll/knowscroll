import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { ABSENCE_MS, isAbsent, loadUniverseMemory, saveUniverseMemory, type UniverseMemory } from './universe-memory';
import { fixtureAccount, fixtureId } from './universe.fixture';

function scopeWith(store = memoryStore()) {
  return createAccountScope({
    account: fixtureAccount,
    baseUrl: 'https://memory.fixture.test',
    store,
    authorization: () => undefined,
    fetch: () => Promise.resolve(new Response('{}')),
  });
}

describe('what the Universe remembers on this device', () => {
  it('round-trips the camera, lens and ship, and purges them with the scope', () => {
    const store = memoryStore();
    const scope = scopeWith(store);
    const memory = {
      focusId: fixtureId(12),
      landed: true,
      frame: { x: 4, y: -2, scale: 1.5 },
      lately: true,
      lastPlace: { id: fixtureId(12), label: 'CI planet', kind: 'planet' as const },
      seenAt: 1_000,
    };
    saveUniverseMemory(scope, memory);
    expect(loadUniverseMemory(scope)).toEqual(memory);
    scope.end();
    expect(store.keys()).toEqual([]);
  });

  it('treats malformed, oversized or foreign values as nothing and bounds the frame', () => {
    const scope = scopeWith();
    for (const raw of ['not json', '[]', '{"frame":1,"seenAt":1}', `{"pad":"${'x'.repeat(5000)}"}`]) {
      scope.storage.set('universe.view.v1', raw);
      expect(loadUniverseMemory(scope)).toBeUndefined();
    }
    scope.storage.set(
      'universe.view.v1',
      JSON.stringify({
        focusId: 7,
        frame: { x: 1e9, y: 'a', scale: 0 },
        lately: 'yes',
        lastPlace: { id: 'x', label: 'y', kind: 'room' },
        seenAt: 5,
      }),
    );
    expect(loadUniverseMemory(scope)).toEqual({
      focusId: null,
      landed: false,
      frame: { x: 10000, y: 0, scale: 0.125 },
      lately: false,
      lastPlace: undefined,
      seenAt: 5,
    });
    scope.end();
  });

  it('calls the person absent after three days and never before there is a memory', () => {
    expect(isAbsent(undefined, 1e12)).toBe(false);
    const memory: UniverseMemory = {
      focusId: null,
      landed: false,
      frame: { x: 0, y: 0, scale: 1 },
      lately: false,
      lastPlace: undefined,
      seenAt: 0,
    };
    expect(isAbsent(memory, ABSENCE_MS - 1)).toBe(false);
    expect(isAbsent(memory, ABSENCE_MS)).toBe(true);
  });
});
