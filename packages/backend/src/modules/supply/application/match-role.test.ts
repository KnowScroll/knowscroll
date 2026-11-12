import { describe, expect, it } from 'vitest';
import { SHORTLIST_TOPICS, planSnapshot, shortlistTopics } from '../../content/public.js';
import { catalogueItems, matchAnswerSchema, matchContext, matchRole } from './match-role.js';

const catalogue = planSnapshot();
const everything = shortlistTopics(catalogue, 'anything at all');

describe('what the model is shown to match a request to a topic (D-419)', () => {
  it('is the whole of a small catalogue, one item per system, as the prompt always was', () => {
    expect(everything).toHaveLength(17);
    const items = catalogueItems(everything);
    expect(items.map((item) => item.ref)).toEqual(catalogue.systems().map((system) => `catalogue:${system.id}`));
    const earth = JSON.parse(items.find((item) => item.ref === 'catalogue:earth')!.text) as {
      topicId: string;
      meaning: string;
      facets: { id: string; meaning: string }[];
    }[];
    expect(earth.map((planet) => planet.topicId)).toEqual(catalogue.children('earth').map((planet) => planet.id));
    expect(earth[0]!.facets).toEqual(
      catalogue.concept('earth.seasons')!.facets.map(({ id, meaning }) => ({ id, meaning })),
    );
    expect(Object.keys(earth[0]!).sort()).toEqual(['facets', 'meaning', 'topicId']);
  });

  it('is only the shortlist, and stays within the bound however large the catalogue is', () => {
    expect(SHORTLIST_TOPICS).toBeLessThanOrEqual(30);
    const two = everything.slice(0, 2);
    const items = matchContext('request-1', 'Why are there tides?', two).items;
    expect(items[0]).toEqual({ ref: 'request', kind: 'learner_request', text: 'Why are there tides?' });
    expect(items.slice(1).flatMap((item) => (JSON.parse(item.text) as unknown[]).length)).toEqual([2]);
  });

  it('accepts only a topic and facet of the shortlist the model was shown, so a real topic it was not shown is refused', () => {
    const schema = matchAnswerSchema(everything.filter((topic) => topic.id === 'earth.tides'));
    expect(schema.safeParse({ topicId: 'earth.tides', facetId: null }).success).toBe(true);
    expect(schema.safeParse({ topicId: 'earth.tides', facetId: 'earth.tides.coasts' }).success).toBe(true);
    expect(schema.safeParse({ topicId: null, facetId: null }).success).toBe(true);
    expect(schema.safeParse({ topicId: 'earth.seasons', facetId: null }).success).toBe(false);
    expect(schema.safeParse({ topicId: 'earth.tides', facetId: 'earth.seasons.limits' }).success).toBe(false);
    expect(schema.safeParse({ topicId: null, facetId: 'earth.tides.coasts' }).success).toBe(false);
    expect(schema.safeParse({ topicId: 'made.up', facetId: null }).success).toBe(false);
    expect(matchRole(everything).id).toBe('supply.match-request');
  });
});
