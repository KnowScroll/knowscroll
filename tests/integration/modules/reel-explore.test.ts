/** Fixtures only: a fake Cutroom (no provider, no spend), a disposable pool and generated colour-bar video. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import {
  importEditorialScrollUseCase,
  readDiscoveryCandidates,
  readEncounterTopics,
  readExactEncounter,
} from '@knowscroll/backend/modules/content/nest-providers';
import { seedPerson } from '../support/fixtures.js';
import { createReelWorld, type ReelWorld } from '../support/reel-world.js';
import { starterSource, textCapabilities } from '../support/scroll.js';

const scrollId = '637df7a3-e65d-4c94-8205-36e95818e7f8';
const reelId = '53fcdbab-2ae5-4f40-a008-6f80fa4d0c61';
const unit = 'space-stars-fusion-v1';
/** A client that renders both formats: the text family and Reels. */
const capabilities = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };

let world: ReelWorld;
beforeEach(async () => {
  world = await createReelWorld();
});
afterEach(async () => {
  await world.close();
});

describe('a Reel made from a script, as Explore sees it', () => {
  it('is offered beside its Scroll as one explanation unit in two formats, each ready to switch to', async () => {
    const { db, operator } = await world.join('dev');
    // A real, admitted Scroll document at the recipe's identity, as the writer's output would be.
    const twin = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    twin.assetId = scrollId;
    twin.publication.explanationUnitId = unit;
    expect(await importEditorialScrollUseCase(db.db)(twin)).toMatchObject({ kind: 'imported' });

    await world.rehearse(operator, 'stars-fusion');
    await operator.order({ scriptName: 'stars-fusion', until: 'video', ceilingCents: 75, retake: false });
    const request = [...world.cutroom.runs.values()].at(-1)!.requestId;
    await world.cutroom.finishCompleted(request, { costCents: 58 });
    expect(await operator.follow({ scriptName: 'stars-fusion', until: 'video' })).toMatchObject({
      kind: 'finished',
      published: { assetId: reelId },
    });

    const person = await seedPerson(db.db);
    const withScope = makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 });
    const found = await withScope(person.authority, async (scope) => ({
      candidates: await readDiscoveryCandidates(scope, {
        languages: ['en'],
        formats: ['reel', 'scroll'],
        capabilities,
        topicIds: ['space.stars'],
        limit: 100,
      }),
      reel: await readExactEncounter(scope, { assetId: reelId, assetRevision: 1, capabilities }),
      scroll: await readExactEncounter(scope, { assetId: scrollId, assetRevision: 1, capabilities }),
      topics: await readEncounterTopics(scope, { assetId: reelId, assetRevision: 1 }),
    }));
    expect(found.kind).toBe('entered');
    if (found.kind !== 'entered') return;
    const byAsset = new Map(found.value.candidates.map((candidate) => [candidate.assetId, candidate]));
    // The Reel is offered for its planet, and the format switch finds the Scroll (and the other way round).
    expect(byAsset.get(reelId)).toMatchObject({
      kind: 'reel',
      explanationUnitId: unit,
      topics: [{ topicId: 'space.stars', role: 'primary', weight: 1 }],
      siblings: [{ assetId: scrollId, assetRevision: 1, kind: 'scroll' }],
      metadata: { title: 'A star in balance', language: 'en' },
    });
    expect(found.value.reel).toMatchObject({ siblings: [{ assetId: scrollId, kind: 'scroll' }] });
    expect(found.value.scroll).toMatchObject({
      explanationUnitId: unit,
      siblings: [{ assetId: reelId, assetRevision: 1, kind: 'reel' }],
    });
    expect(found.value.topics).toEqual([{ topicId: 'space.stars', role: 'primary', weight: 1 }]);
    // A client that cannot play Reels is not offered the Reel, and the Scroll shows no Reel variant to open.
    const textOnly = await withScope(person.authority, (scope) =>
      readDiscoveryCandidates(scope, {
        languages: ['en'],
        formats: ['reel', 'scroll'],
        capabilities: textCapabilities,
        limit: 100,
      }),
    );
    expect(textOnly.kind === 'entered' && textOnly.value.some((candidate) => candidate.assetId === reelId)).toBe(false);
  });
});
