import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { EncounterOffer, NavigationOutcome } from '@knowscroll/contracts';
import { computeIntegrityV2, firstFrameOf, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { seedReel, seedScroll } from '../support/thread-fixtures.js';

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

/**
 * scroll-model's labelled v2 CI fixture, re-sealed and admitted: under a fresh asset, or as a later revision
 * of an existing one (a regenerated Scroll keeps its asset). Not product content.
 */
async function seedV2(
  db: Kysely<Database>,
  name: string,
  into: { assetId: string; revision: number; unit: string } | undefined = undefined,
): Promise<{ assetId: string; document: ScrollDocumentV2 }> {
  const assetId = into?.assetId ?? randomUUID();
  const revision = into?.revision ?? 1;
  const document = fixtureDocument(name);
  Object.assign(document, { assetId, revision });
  document.integrity.sha256 = computeIntegrityV2(document);
  if (into === undefined)
    await db
      .insertInto('content.assets')
      .values({ id: assetId, revision, kind: 'scroll', status: 'admitted' })
      .execute();
  await db
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision,
      provenance_kind: 'authored_editorial',
      document_version: V2,
      document: JSON.stringify(document),
      document_sha256: document.integrity.sha256,
      explanation_unit_id: into?.unit ?? `ci-cover-${assetId.slice(0, 8)}`,
      language: 'en',
      title: document.title,
      reading_facts: '{}',
    })
    .execute();
  if (into !== undefined) await db.updateTable('content.assets').set({ revision }).where('id', '=', assetId).execute();
  return { assetId, document };
}

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}
const offersOf = (outcome: Ready): EncounterOffer[] => [outcome.offer, ...outcome.bufferedOffers];
const activation = (o: Ready) => ({
  commandId: randomUUID(),
  target: {
    kind: 'offer' as const,
    sessionId: o.sessionId,
    offerId: o.offer.offerId,
    expectedIntentRevision: o.intentRevision,
  },
});

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

  it('never writes a cover into the Composer decision it was offered from', async () => {
    const { outcome } = await open([V1, V2, COVER]);
    expect(offersOf(outcome).every((offer) => offer.cover !== undefined)).toBe(true);
    // The decision is ranked data and is read again by buffers and replays: the cover belongs to the offer alone.
    const stored = await sql<{ text: string }>`select payload::text as text from composer.decisions
      where id = ${outcome.decisionId}::uuid`.execute(database.db);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.text).not.toContain('"cover"');
    expect(stored.rows[0]?.text).not.toContain('offer-cover');
  });

  it.each([
    ['declares the cover', [V1, V2, COVER], true],
    ['does not declare the cover', [V1, V2], false],
  ])('gives the offers of a vertical move covers only when the session %s', async (_name, schemas, covered) => {
    const { person, outcome } = await open(schemas);
    const activated = await c.activateOffer(person.authority, activation(outcome));
    if (activated.kind !== 'accepted') throw new Error('activation refused');
    const next = ready(
      await c.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: outcome.sessionId,
        expectedIntentRevision: outcome.intentRevision,
        from: { offerId: outcome.offer.offerId, exposureId: activated.outcome.exposureId },
        intent: { mode: 'vertical', direction: 'next' },
      }),
    );
    const offers = offersOf(next);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.metadata.kind).toBe('scroll');
      expect(Object.hasOwn(offer, 'cover')).toBe(covered);
    }
  });
});

describe('the cover of an asset regenerated as v2 (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases;
  let v1: Awaited<ReturnType<typeof seedScroll>>;
  let v2: { assetId: string; document: ScrollDocumentV2 };

  beforeAll(async () => {
    database = await createTestDatabase<Database>('navigation_offer_cover_fallback');
    c = await scrollUseCases(database, { recording: true });
    // The only Scroll in this world: revision 1 is v1, and the current revision 2 is v2 under the same asset.
    v1 = await seedScroll(database.db, 'attention-slowly');
    v2 = await seedV2(database.db, 'seasons-stage-ci', {
      assetId: v1.assetId,
      revision: 2,
      unit: v1.document.explanationUnitId,
    });
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  const offered = async (schemas: string[]) => {
    const person = await recordingPerson(database);
    const command = {
      commandId: randomUUID(),
      target: { kind: 'discover' as const },
      capabilities: capabilities(...schemas),
    };
    return ready(await c.navigate(person.authority, command));
  };

  it('offers the v1 revision, with the v1 cover, to a declaring client that cannot render v2', async () => {
    const outcome = await offered([V1, COVER]);
    expect(outcome.offer).toMatchObject({ assetId: v1.assetId, assetRevision: 1 });
    expect(outcome.offer.cover).toEqual({
      version: COVER,
      kicker: v1.document.kicker,
      readingMinutes: v1.document.measures.readingMinutes,
    });
    expect(outcome.offer.cover).not.toHaveProperty('readStops');
    expect(outcome.offer.cover).not.toHaveProperty('figure');
  });

  it('offers the current v2 revision, with the v2 cover, to a declaring client that renders v2', async () => {
    const outcome = await offered([V1, V2, COVER]);
    expect(outcome.offer).toMatchObject({ assetId: v2.assetId, assetRevision: 2 });
    expect(outcome.offer.cover).toEqual({
      version: COVER,
      kicker: v2.document.kicker,
      readingMinutes: v2.document.measures.readingMinutes,
      readStops: v2.document.stops.filter((stop) => stop.kind === 'read').length,
      figure: firstFrameOf(v2.document),
    });
  });
});

describe('the cover and the audience of a Scroll made for a thread (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases;
  let ordered: string, open: string;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('navigation_offer_cover_audience');
    // No test names an audience, so nobody who opens here is in the thread the Scroll was made for.
    c = await scrollUseCases(database, { recording: true });
    ordered = (await seedScroll(database.db, 'attention-slowly')).assetId;
    open = (await seedScroll(database.db, 'spring-neap-tides')).assetId;
    await sql`insert into content.made_to_order_scrolls (recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing)
      values (${'order-' + randomUUID().replaceAll('-', '')}, ${ordered}::uuid, 'ci-order-unit', 'what_if', 'A CI brief.',
        array['https://example.test/ci'], 'What if', '{}'::jsonb)`.execute(database.db);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  it.each([
    ['declares the cover', [V1, COVER]],
    ['does not declare the cover', [V1]],
  ])('never offers it to a caller outside its audience, whether the session %s', async (_name, schemas) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const person = await recordingPerson(database);
      const result = await c.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' as const },
        capabilities: capabilities(...schemas),
      });
      const offers = offersOf(ready(result));
      // The open Scroll is offered, so an empty world is not what keeps the ordered one out.
      expect(offers.map((offer) => offer.assetId)).toEqual([open]);
    }
  });
});
