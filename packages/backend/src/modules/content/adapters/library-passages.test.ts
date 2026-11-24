import { RECIPES } from '../domain/library/index.js';
import { describe, expect, it } from 'vitest';
import { storedOrrinV2 } from '../production/orrin.fixture.js';
import { fixtureSnapshot } from '../public.js';
import { readFileSync } from 'node:fs';
import { beatsOfV3, type ScrollDocumentV2, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { callsOfStored, proseBlocksOf, topicIdsOf } from './library-passages.js';

/** A labelled CI fixture: the stored v2 Scroll of the seasons recipe, as the v2 writer stored it. */
function fixtureDocument(): ScrollDocumentV2 {
  return storedOrrinV2({
    assetId: RECIPES.seasons.assetId,
    explanationUnitId: RECIPES.seasons.explanationUnitId,
  }).document as unknown as ScrollDocumentV2;
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

  it('gives a document v3 one block per beat, its text, and no calls', () => {
    const document = JSON.parse(
      readFileSync(
        new URL('../../../../../scroll-model/fixtures/documents/seasons-v3-ci.json', import.meta.url),
        'utf8',
      ),
    ) as ScrollDocumentV3;
    const beats = beatsOfV3(document);
    expect(proseBlocksOf(document)).toEqual(beats.map((beat) => ({ blockId: beat.id, text: beat.text })));
    expect(beats.length).toBeGreaterThanOrEqual(9);
    expect(callsOfStored(document)).toEqual([]);
    expect(proseBlocksOf({ ...document, sections: 'nope' })).toEqual([]);
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
