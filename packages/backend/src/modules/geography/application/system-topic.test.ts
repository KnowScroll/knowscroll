import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import { makeReadOwnSystemTopic } from './system-topic.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = {} as PersonalScopeTx;
const system = {
  id: id(1),
  key: 'system:machine-learning:factual',
  kind: 'system',
  conceptId: 'machine-learning',
  parentKey: 'universe',
  truthStatus: 'factual',
  objectRevision: 2,
};

const read = (stored: unknown, active = true) =>
  makeReadOwnSystemTopic({
    ownerActive: () => Promise.resolve(active),
    state: () => Promise.resolve({ revision: 5 } as never),
    object: (_scope, selector) => Promise.resolve('id' in selector && selector.id === id(1) ? stored : undefined),
  });

describe('the topic of one of the caller’s own systems (#697)', () => {
  it('names the catalogue system of an own factual system, with no planet needed', async () => {
    expect(await read(system)(scope, id(1))).toEqual({ kind: 'read', systemId: id(1), topicId: 'machine-learning' });
  });

  it('answers not_on_map alike for an unknown id, a planet, a hypothetical system and a malformed id', async () => {
    const notOnMap = { kind: 'unavailable', reason: 'not_on_map' };
    expect(await read(system)(scope, id(9))).toEqual(notOnMap);
    expect(await read({ ...system, kind: 'planet' })(scope, id(1))).toEqual(notOnMap);
    expect(await read({ ...system, truthStatus: 'hypothetical' })(scope, id(1))).toEqual(notOnMap);
    expect(await read(system)(scope, 'not-a-uuid')).toEqual(notOnMap);
  });

  it('never guesses a topic from a row that does not match the catalogue or the map', async () => {
    for (const stored of [
      { ...system, conceptId: 'machine-learning.attention', key: 'system:machine-learning.attention:factual' },
      { ...system, conceptId: 'not-a-system', key: 'system:not-a-system:factual' },
      { ...system, key: 'system:other:factual' },
      { ...system, objectRevision: 9 },
      { id: id(1) },
    ])
      expect(await read(stored)(scope, id(1))).toEqual({ kind: 'unavailable', reason: 'temporarily_unavailable' });
  });

  it('refuses an inactive owner', async () => {
    expect(await read(system, false)(scope, id(1))).toEqual({ kind: 'refused' });
  });
});
