import { describe, expect, it } from 'vitest';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { fixtureSnapshot } from '../../content/public.js';
import { briefOf } from './inventory.js';

const concepts = [
  { id: 'earth', parent: null },
  { id: 'earth.tides', parent: 'earth', facets: ['earth.tides.forcing', 'earth.tides.coasts'] },
  { id: 'earth.seasons', parent: 'earth', facets: ['earth.seasons.tilt', 'earth.seasons.limits'] },
] as const;

const ask = (topicId: string, facetId?: string): CreateContentRequest =>
  ({
    version: 'content-request.v1',
    commandId: '00000000-0000-4000-8000-000000000001',
    intent: {
      kind: 'topic',
      subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId, ...(facetId ? { facetId } : {}) },
      format: 'scroll',
    },
    language: 'en',
    capabilities: {},
  }) as unknown as CreateContentRequest;

describe('the brief of a catalogue ask', () => {
  it('is made for a servable topic, and for one of its own facets', () => {
    const catalogue = fixtureSnapshot(concepts);
    expect(briefOf(ask('earth.tides'), undefined, catalogue)).toMatchObject({ subject: { topicId: 'earth.tides' } });
    expect(briefOf(ask('earth.tides', 'earth.tides.coasts'), undefined, catalogue)).toMatchObject({
      subject: { facetId: 'earth.tides.coasts' },
    });
    expect(briefOf(ask('earth.tides', 'earth.seasons.tilt'), undefined, catalogue)).toBeUndefined();
  });

  it('is never made for a topic that is retired, or that still waits for released supply, or for one that is not there (#674)', () => {
    expect(
      briefOf(ask('earth.tides'), undefined, fixtureSnapshot(concepts, 1, { retired: ['earth.tides'] })),
    ).toBeUndefined();
    expect(
      briefOf(ask('earth.tides'), undefined, fixtureSnapshot(concepts, 1, { waiting: ['earth.tides'] })),
    ).toBeUndefined();
    expect(briefOf(ask('earth.nothing'), undefined, fixtureSnapshot(concepts))).toBeUndefined();
    // The same ask still works for the topic beside it.
    expect(
      briefOf(ask('earth.seasons'), undefined, fixtureSnapshot(concepts, 1, { retired: ['earth.tides'] })),
    ).toMatchObject({ subject: { topicId: 'earth.seasons' } });
  });
});
