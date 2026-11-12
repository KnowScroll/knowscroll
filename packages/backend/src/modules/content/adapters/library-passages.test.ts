import { RECIPES } from '../domain/library/index.js';
import { describe, expect, it } from 'vitest';
import { evidencePassages } from '../production/evidence.js';
import { spikeRecipeV2 } from '../production/spike-v2/topics.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from '../production/spike-v2/writer-v2.fixture.js';
import { compileGeneratedScrollV2, publicationV2 } from '../production/writer-v2.js';
import { fixtureSnapshot } from '../public.js';
import { proseBlocksOf, topicIdsOf } from './library-passages.js';

/** A labelled CI fixture: the recorded v2 writer answer for the seasons recipe, compiled as production would. */
function fixtureDocument() {
  const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(), {
    publication: publicationV2(RECIPES.seasons),
    recipe: spikeRecipeV2('seasons'),
    passages: evidencePassages([fixtureResearchPageV2]),
    pages: [fixtureResearchPageV2],
  });
  if (outcome.kind !== 'compiled') throw new Error('the CI fixture must compile');
  return outcome.document;
}

describe('the prose of a stored Scroll, for a room’s daily items', () => {
  it('gives a v2 Scroll one block per read stop: its paragraphs and lines, never a heading or a call', () => {
    const document = fixtureDocument();
    const blocks = proseBlocksOf(document);
    expect(blocks.length).toBeGreaterThan(0);
    const readStops = document.stops.flatMap((stop) => (stop.kind === 'read' ? [stop] : []));
    expect(blocks.map((block) => block.blockId)).toEqual(
      readStops.filter((stop) => stop.blocks.some((block) => block.type !== 'heading')).map((stop) => stop.id),
    );
    for (const block of blocks) {
      const stop = readStops.find((candidate) => candidate.id === block.blockId)!;
      expect(block.text).toBe(stop.blocks.flatMap((part) => (part.type === 'heading' ? [] : [part.text])).join(' '));
    }
    const headings = readStops.flatMap((stop) =>
      stop.blocks.flatMap((part) => (part.type === 'heading' ? [part.text] : [])),
    );
    for (const heading of headings) expect(blocks.some((block) => block.text.includes(heading))).toBe(false);
    for (const call of document.stops.flatMap((stop) => (stop.kind === 'read' ? [] : [stop.prompt])))
      expect(blocks.some((block) => block.text.includes(call))).toBe(false);
  });

  it('gives nothing for a document that does not parse', () => {
    expect(proseBlocksOf({ schemaVersion: 'scroll-document.v2', stops: 'nope' })).toEqual([]);
    expect(proseBlocksOf({ schemaVersion: 'scroll-document.v1' })).toEqual([]);
    expect(proseBlocksOf(null)).toEqual([]);
  });
});

describe('the topics a library topic covers in one release of the catalogue (#674)', () => {
  const concepts = [
    { id: 'earth', parent: null },
    { id: 'earth.tides', parent: 'earth', facets: ['earth.tides.forcing', 'earth.tides.coasts'] },
    { id: 'earth.seasons', parent: 'earth', facets: ['earth.seasons.tilt', 'earth.seasons.limits'] },
    { id: 'earth.volcanoes', parent: 'earth', facets: ['earth.volcanoes.magma', 'earth.volcanoes.plates'] },
  ];

  it('is the servable planets of a system, and a servable planet itself', () => {
    const catalogue = fixtureSnapshot(concepts);
    expect(topicIdsOf(catalogue, { kind: 'system', id: 'earth' })).toEqual([
      'earth.tides',
      'earth.seasons',
      'earth.volcanoes',
    ]);
    expect(topicIdsOf(catalogue, { kind: 'planet', id: 'earth.tides' })).toEqual(['earth.tides']);
  });

  it('covers nothing for a planet that is retired or still waits for released supply, nor for one that is not there', () => {
    const catalogue = fixtureSnapshot(concepts, 1, { retired: ['earth.tides'], waiting: ['earth.volcanoes'] });
    expect(topicIdsOf(catalogue, { kind: 'planet', id: 'earth.tides' })).toEqual([]);
    expect(topicIdsOf(catalogue, { kind: 'planet', id: 'earth.volcanoes' })).toEqual([]);
    expect(topicIdsOf(catalogue, { kind: 'planet', id: 'earth.nothing' })).toEqual([]);
    expect(topicIdsOf(catalogue, { kind: 'system', id: 'earth' })).toEqual(['earth.seasons']);
  });
});
