import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { EncounterOffer, NavigationOutcome } from '@knowscroll/contracts';
import { computeIntegrityV2, firstFrameOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { seedReel } from '../support/thread-fixtures.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

/** What a client says it can render; `offer-cover.v1` is the one thing the clients below differ in. */
const capabilities = (...schemas: string[]) => ({ ...textCapabilities, documentSchemas: schemas });
const V1 = 'scroll-document.v1';
const V2 = 'scroll-document.v2';
const REEL = 'reel-document.v1';
const COVER = 'offer-cover.v1';

const fixtureDocument = (name: string): ScrollDocumentV2 =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/scroll-model/fixtures/documents/${name}.json`, import.meta.url), 'utf8'),
  ) as ScrollDocumentV2;

/** scroll-model's labelled v2 CI fixture, re-sealed under a fresh asset and admitted. Not product content. */
async function seedV2(db: Kysely<Database>, name: string): Promise<{ assetId: string; document: ScrollDocumentV2 }> {
  const assetId = randomUUID();
  const document = fixtureDocument(name);
  Object.assign(document, { assetId, revision: 1 });
  document.integrity.sha256 = computeIntegrityV2(document);
  await db
    .insertInto('content.assets')
    .values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' })
    .execute();
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision: 1,
      provenance_kind: 'authored_editorial',
      document_version: V2,
      document: JSON.stringify(document),
      document_sha256: document.integrity.sha256,
      explanation_unit_id: `ci-cover-${assetId.slice(0, 8)}`,
      language: 'en',
      title: document.title,
      reading_facts: '{}',
    })
    .execute();
  return { assetId, document };
}

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}
const offersOf = (outcome: Ready): EncounterOffer[] => [outcome.offer, ...outcome.bufferedOffers];

describe('offer covers on Scroll offers (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases;
  let stage: { assetId: string; document: ScrollDocumentV2 };
  let plain: { assetId: string; document: ScrollDocumentV2 };
  let v1Ids: string[];
  let reelId: string;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('navigation_offer_cover');
    c = await scrollUseCases(database, { recording: true });
    v1Ids = [];
    for (let i = 0; i < 3; i += 1) {
      const src = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      src.assetId = randomUUID();
      src.publication.explanationUnitId = `fixture-cover-${randomUUID()}`;
      const imported = await c.importScroll(src);
      if (imported.kind !== 'imported') throw new Error('fixture admission refused');
      v1Ids.push(imported.assetId);
    }
    stage = await seedV2(database.db, 'seasons-stage-ci');
    plain = await seedV2(database.db, 'scale-chart-blocks-ci');
    reelId = (await seedReel(database.db)).assetId;
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  const open = async (schemas: string[], commandId = randomUUID()) => {
    const person = await recordingPerson(database);
    const command = { commandId, target: { kind: 'discover' as const }, capabilities: capabilities(...schemas) };
    return { person, command, outcome: ready(await c.navigate(person.authority, command)) };
  };

  it('gives every Scroll offer of a declaring session its kicker and minutes, read from the offered revision', async () => {
    const { outcome } = await open([V1, COVER]);
    const offers = offersOf(outcome);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.map((offer) => offer.assetId).every((id) => v1Ids.includes(id))).toBe(true);
    const stored = await database.db
      .selectFrom('content.asset_revisions')
      .select(['asset_id', 'document'])
      .where('asset_id', 'in', v1Ids)
      .execute();
    for (const offer of offers) {
      const row = stored.find((entry) => entry.asset_id === offer.assetId);
      const document = (typeof row?.document === 'string' ? JSON.parse(row.document) : row?.document) as {
        kicker: string;
        measures: { readingMinutes: number };
      };
      // A v1 Scroll has no stage and no stops: its cover is the kicker and the minutes, nothing more.
      expect(offer.cover).toEqual({
        version: COVER,
        kicker: document.kicker,
        readingMinutes: document.measures.readingMinutes,
      });
    }
  });

  it('gives a v2 Scroll its read stops and its first stage frame, and no figure when it has no stage', async () => {
    const { outcome } = await open([V2, COVER]);
    const offers = offersOf(outcome);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      const source = offer.assetId === stage.assetId ? stage : plain;
      expect([stage.assetId, plain.assetId]).toContain(offer.assetId);
      expect(offer.cover).toMatchObject({
        version: COVER,
        kicker: source.document.kicker,
        readingMinutes: source.document.measures.readingMinutes,
        readStops: source.document.stops.filter((stop) => stop.kind === 'read').length,
      });
      if (source === stage) expect(offer.cover?.figure).toEqual(firstFrameOf(stage.document));
      else expect(offer.cover).not.toHaveProperty('figure');
    }
    expect(offers.map((offer) => offer.assetId)).toContain(stage.assetId);
  });

  it('sends no cover key at all to a session that did not declare it, whatever the format', async () => {
    const outcomes = [await open([V1]), await open([V1, V2]), await open([REEL])];
    for (const { outcome } of outcomes) {
      expect(offersOf(outcome).length).toBeGreaterThan(0);
      for (const offer of offersOf(outcome)) expect(Object.hasOwn(offer, 'cover')).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain('offer-cover');
    }
  });

  it('never gives a Reel a cover, even in a declaring session', async () => {
    const { outcome } = await open([REEL, COVER]);
    const offers = offersOf(outcome);
    expect(offers.map((offer) => offer.assetId)).toContain(reelId);
    for (const offer of offers) {
      expect(offer.metadata.kind).toBe('reel');
      expect(Object.hasOwn(offer, 'cover')).toBe(false);
    }
  });

  it('replays the same open with the stored offers, covers included, byte for byte', async () => {
    const { person, command, outcome } = await open([V1, V2, COVER]);
    expect(outcome.offer.cover).toBeDefined();
    const again = ready(await c.navigate(person.authority, command));
    expect(again.replayed).toBe(true);
    expect(again.offer).toEqual(outcome.offer);
    expect(again.bufferedOffers).toEqual(outcome.bufferedOffers);
    expect(JSON.stringify(offersOf(again))).toBe(JSON.stringify(offersOf(outcome)));
    // The stored offer is what is replayed: it holds the cover it was made with, not one built again.
    const row = await database.db
      .selectFrom('experience.offers')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('id', '=', outcome.offer.offerId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).toContain(outcome.offer.cover?.kicker);
  });
});
