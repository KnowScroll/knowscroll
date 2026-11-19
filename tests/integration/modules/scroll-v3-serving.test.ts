import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeReadLibraryCalls,
  makeReadLibraryPassages,
  readDiscoveryCandidates,
  readExactEncounter,
  readScrollAskFacts,
  readScrollPlayFacts,
  readScrollQuickAnswerFacts,
  validateSnippetAnchor,
} from '@knowscroll/backend/modules/content/nest-providers';
import { ExposureDocumentResponseSchema, type EncounterOffer, type NavigationOutcome } from '@knowscroll/contracts';
import {
  beatsOfV3,
  coverFrameOfV3,
  firstFrameOf,
  momentAnchorOf,
  momentOfBeat,
  parseDocumentV3,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
} from '@knowscroll/scroll-model';
import { readOfferEncounter } from '../../../packages/backend/src/modules/content/adapters/discovery-store.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { reportCases } from '../support/feedback.js';
import { seedPerson } from '../support/fixtures.js';
import { recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { capabilitiesOf, seedDocumentV2, seedDocumentV3, v1Client, v2Client, v3Client } from '../support/scroll-v3.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

const V1 = 'scroll-document.v1';
const V2 = 'scroll-document.v2';
const V3 = 'scroll-document.v3';
const COVER_V1 = 'offer-cover.v1';
const COVER_V2 = 'offer-cover.v2';

/**
 * Serving a document v3 (#763, D-129): a client that declares the schema is served the document whole; one that does not
 * is offered the latest earlier revision whose schema it declares; a revision pinned by an offer or a link is never swapped.
 * Fixtures are scroll-model's labelled CI documents, re-sealed under fresh assets, over real PostgreSQL; no provider.
 */
describe('serving a document v3 (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let c: Cases;
  /** An asset whose only revision is a document v3. */
  let onlyV3: Awaited<ReturnType<typeof seedDocumentV3>>;
  /** An asset corrected twice: v1 (revision 1), v2 (revision 2) and now a document v3 (revision 3). */
  let threeAges: {
    assetId: string;
    v3: Awaited<ReturnType<typeof seedDocumentV3>>;
    v2: Awaited<ReturnType<typeof seedDocumentV2>>;
  };
  /** An asset that was v2 and is now a document v3, with no v1 revision at all. */
  let twoAges: {
    assetId: string;
    v3: Awaited<ReturnType<typeof seedDocumentV3>>;
    v2: Awaited<ReturnType<typeof seedDocumentV2>>;
  };

  beforeAll(async () => {
    database = await createTestDatabase<Database>('scroll_v3_serving');
    c = await scrollUseCases(database, { recording: true });
    onlyV3 = await seedDocumentV3(database.db, 'fence-v3-ci');

    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-three-ages-${randomUUID()}`;
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    const into = (revision: number) => ({
      assetId: imported.assetId,
      revision,
      unit: source.publication.explanationUnitId,
    });
    const v2 = await seedDocumentV2(database.db, 'seasons-stage-ci', into(2));
    threeAges = { assetId: imported.assetId, v2, v3: await seedDocumentV3(database.db, 'seasons-v3-ci', into(3)) };

    const first = await seedDocumentV2(database.db, 'scale-chart-blocks-ci');
    const unit = `ci-two-ages-${randomUUID()}`;
    const rewritten = await seedDocumentV3(database.db, 'broad-street-v3-ci', {
      assetId: first.assetId,
      revision: 2,
      unit,
    });
    twoAges = { assetId: first.assetId, v2: first, v3: rewritten };
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  async function inScope<T>(run: (scope: Parameters<Parameters<ReturnType<typeof withScope>>[1]>[0]) => Promise<T>) {
    const person = await recordingPerson(database);
    const entered = await withScope()(person.authority, run);
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value;
  }

  /** What discovery offers a client of the given capabilities, of the assets these tests made. */
  async function offered(capabilities: ReturnType<typeof capabilitiesOf>) {
    const ours = new Set([onlyV3.assetId, threeAges.assetId, twoAges.assetId]);
    const found = await inScope((scope) =>
      readDiscoveryCandidates(scope, { languages: ['en'], formats: ['scroll'], capabilities, limit: 100 }),
    );
    return new Map(
      found.filter((entry) => ours.has(entry.assetId)).map((entry) => [entry.assetId, entry.assetRevision]),
    );
  }

  describe('the document itself', () => {
    it('is served whole to a client that declares scroll-document.v3, and the wire contract and client parse accept it', async () => {
      const rendition = await c.renderScroll({ assetId: onlyV3.assetId, revision: 1, capabilities: v3Client });
      if (rendition.kind !== 'rendition') throw new Error('CI expected a rendition');
      expect(rendition.degradedEssential).toEqual([]);
      expect(rendition.document).toEqual(onlyV3.document);
      const wire = ExposureDocumentResponseSchema.parse({
        exposureId: randomUUID(),
        assetId: onlyV3.assetId,
        assetRevision: 1,
        document: JSON.parse(JSON.stringify(rendition.document)) as unknown,
        degradedEssential: [],
      });
      expect(parseDocumentV3(wire.document, { verify: true }).kind).toBe('valid');
      for (const internal of ['claimId', 'citations', 'scroll-provenance', 'snapshotSha256'])
        expect(JSON.stringify(rendition.document)).not.toContain(internal);
    });

    it('is cannot_render to a client that does not declare it, and to one whose capabilities do not parse', async () => {
      for (const capabilities of [v2Client, v1Client, capabilitiesOf(V1, V2)])
        expect(await c.renderScroll({ assetId: onlyV3.assetId, revision: 1, capabilities })).toEqual({
          kind: 'cannot_render',
          reason: 'unsupported_document',
        });
      expect(
        await c.renderScroll({ assetId: onlyV3.assetId, revision: 1, capabilities: { documentSchemas: [] } }),
      ).toEqual({ kind: 'cannot_render', reason: 'capabilities_invalid' });
    });

    it('is read through an exposure by the client that opened it with the schema, and refused to one that did not', async () => {
      const person = await seedPerson(database.db);
      const open = (capabilities: ReturnType<typeof capabilitiesOf>) =>
        c.openExposure(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId: onlyV3.assetId },
          origin: { kind: 'direct' },
          capabilities,
        });
      const opened = await open(v3Client);
      if (opened.kind !== 'opened') throw new Error('CI open refused');
      const read = await c.readExposureDocument(person.authority, opened.outcome.exposureId);
      if (read.kind !== 'document') throw new Error('CI expected the document');
      expect(read.document.schemaVersion).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
      expect(read.degradedEssential).toEqual([]);

      const old = await open(v2Client);
      if (old.kind !== 'opened') throw new Error('CI open refused');
      expect(await c.readExposureDocument(person.authority, old.outcome.exposureId)).toMatchObject({
        kind: 'refused',
        reason: 'cannot_render',
        cannotRender: 'unsupported_document',
      });
    });
  });

  describe('the revision an older app is offered (decision H)', () => {
    it('is the current revision for a client that declares the schema', async () => {
      expect(await offered(v3Client)).toEqual(
        new Map([
          [onlyV3.assetId, 1],
          [threeAges.assetId, 3],
          [twoAges.assetId, 2],
        ]),
      );
    });

    it('is the latest earlier v2 revision for a v2-only client, and nothing for an asset that is only a document v3', async () => {
      // threeAges holds a v1 revision 1 and a v2 revision 2: the later of the two it can read, not the oldest.
      expect(await offered(v2Client)).toEqual(
        new Map([
          [threeAges.assetId, 2],
          [twoAges.assetId, 1],
        ]),
      );
    });

    it('is the latest earlier v1 revision for a v1-only client, exactly as before document v3 existed', async () => {
      expect(await offered(v1Client)).toEqual(new Map([[threeAges.assetId, 1]]));
    });

    it('is nothing for a client that declares no Scroll schema it can use', async () => {
      expect(await offered(capabilitiesOf('reel-document.v1'))).toEqual(new Map());
      expect(await offered({ documentSchemas: [] } as unknown as ReturnType<typeof capabilitiesOf>)).toEqual(new Map());
    });

    it('is never swapped for an exact revision pinned by an offer or a link: the v3 revision is not read for a v2-only client', async () => {
      const pinned = { assetId: twoAges.assetId, assetRevision: 2 };
      expect(
        await inScope((scope) => readExactEncounter(scope, { ...pinned, capabilities: v2Client })),
      ).toBeUndefined();
      expect(
        await inScope((scope) => readOfferEncounter(scope, { ...pinned, capabilities: v2Client })),
      ).toBeUndefined();
      expect(await inScope((scope) => readExactEncounter(scope, { ...pinned, capabilities: v3Client }))).toMatchObject({
        assetId: twoAges.assetId,
        assetRevision: 2,
      });
      expect(await c.renderScroll({ assetId: twoAges.assetId, revision: 2, capabilities: v2Client })).toEqual({
        kind: 'cannot_render',
        reason: 'unsupported_document',
      });
      // The earlier revision is still its own exact revision, readable by the client that can render it.
      expect(
        await inScope((scope) =>
          readExactEncounter(scope, { assetId: twoAges.assetId, assetRevision: 1, capabilities: v2Client }),
        ),
      ).toMatchObject({ assetRevision: 1 });
    });
  });

  describe('the cover of an offer (offer-cover.v2)', () => {
    const open = async (schemas: string[]) => {
      const person = await recordingPerson(database);
      const result = await c.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' as const },
        capabilities: capabilitiesOf(...schemas),
      });
      if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
      const outcome: Ready = result.outcome;
      return [outcome.offer, ...outcome.bufferedOffers].filter((offer: EncounterOffer) =>
        [onlyV3.assetId, threeAges.assetId, twoAges.assetId].includes(offer.assetId),
      );
    };

    it('is offer-cover.v2 with a picture frame for a document v3, to a session that declared it', async () => {
      const offers = await open([V1, V2, V3, COVER_V2]);
      const seen = new Map(offers.map((offer) => [offer.assetId, offer]));
      expect([...seen.keys()].sort()).toEqual([onlyV3.assetId, threeAges.assetId, twoAges.assetId].sort());
      const first = seen.get(onlyV3.assetId);
      expect(first?.cover).toEqual({
        version: COVER_V2,
        kicker: onlyV3.document.kicker,
        readingMinutes: onlyV3.document.measures.readingMinutes,
        readStops: beatsOfV3(onlyV3.document).length,
        figure: coverFrameOfV3(onlyV3.document),
      });
      expect(first?.cover?.figure).toHaveProperty('picture');
      expect(seen.get(threeAges.assetId)?.cover).toMatchObject({
        version: COVER_V2,
        figure: coverFrameOfV3(threeAges.v3.document),
      });
    });

    it('is offer-cover.v1 with the count and no figure to a session that declared only that', async () => {
      const offers = await open([V1, V2, V3, COVER_V1]);
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(offer.cover?.version).toBe(COVER_V1);
        expect(offer.cover).not.toHaveProperty('figure');
      }
      const first = offers.find((offer) => offer.assetId === onlyV3.assetId);
      expect(first?.cover).toEqual({
        version: COVER_V1,
        kicker: onlyV3.document.kicker,
        readingMinutes: onlyV3.document.measures.readingMinutes,
        readStops: beatsOfV3(onlyV3.document).length,
      });
    });

    it('is no cover at all, not even a key, to a session that declared neither', async () => {
      const offers = await open([V1, V2, V3]);
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) expect(Object.hasOwn(offer, 'cover')).toBe(false);
    });

    it('is the stage frame of the earlier v2 revision a v2-only session is offered, under the version it declared', async () => {
      const offers = await open([V1, V2, COVER_V2]);
      const stand = offers.find((offer) => offer.assetId === threeAges.assetId);
      expect(stand?.assetRevision).toBe(2);
      expect(stand?.cover).toMatchObject({ version: COVER_V2, figure: firstFrameOf(threeAges.v2.document) });
      expect(offers.some((offer) => offer.assetId === onlyV3.assetId)).toBe(false);
    });
  });

  describe('beats as places', () => {
    const ref = () => ({ assetId: onlyV3.assetId, assetRevision: 1 });

    it('gives Ask the beat’s words and the questions the Scroll invites, and nothing for a beat it does not have', async () => {
      const beat = beatsOfV3(onlyV3.document)[2]!;
      const facts = await inScope((scope) => readScrollAskFacts(scope, ref(), beat.id));
      expect(facts).toEqual({
        title: onlyV3.document.title,
        stopText: beat.text,
        suggestions: onlyV3.document.askSuggestions,
      });
      expect(await inScope((scope) => readScrollAskFacts(scope, ref(), 'no-such-beat'))).toBeUndefined();
      expect(
        await inScope((scope) => readScrollAskFacts(scope, { assetId: onlyV3.assetId, assetRevision: 2 }, beat.id)),
      ).toBeUndefined();
    });

    it('gives a Quick answer the beats up to and including the reader’s own, and the beat’s simpler words', async () => {
      const all = beatsOfV3(onlyV3.document);
      const at = 3;
      const facts = await inScope((scope) => readScrollQuickAnswerFacts(scope, ref(), all[at]!.id));
      expect(facts?.title).toBe(onlyV3.document.title);
      expect(facts?.passages).toEqual(all.slice(0, at + 1).map((beat) => ({ stopId: beat.id, text: beat.text })));
      expect(facts?.anchorSimple).toBe(all[at]!.simple);
      expect(JSON.stringify(facts)).not.toContain(all[at + 1]!.text.slice(0, 30));
      expect(await inScope((scope) => readScrollQuickAnswerFacts(scope, ref(), 'no-such-beat'))).toBeUndefined();
    });

    it('lets a person share a beat as a moment, and refuses a changed range or a beat that is not there', async () => {
      const beat = beatsOfV3(onlyV3.document)[1]!;
      const moment = momentOfBeat(onlyV3.document, beat.id)!;
      const anchor = momentAnchorOf(moment);
      const valid = await inScope((scope) => validateSnippetAnchor(scope, ref(), anchor));
      expect(valid).toEqual({ status: 'valid', anchor: { ...anchor, quote: beat.text } });
      expect(await inScope((scope) => validateSnippetAnchor(scope, ref(), { ...anchor, end: anchor.end - 1 }))).toEqual(
        { status: 'invalid' },
      );
      expect(
        await inScope((scope) => validateSnippetAnchor(scope, ref(), { ...anchor, blockId: 'no-such-beat' })),
      ).toEqual({ status: 'invalid' });
      // A Scroll corrected since the sender saw it no longer resolves the old revision as current.
      expect(
        await inScope((scope) =>
          validateSnippetAnchor(scope, { assetId: threeAges.assetId, assetRevision: 2 }, anchor),
        ),
      ).toEqual({ status: 'unavailable' });
    });

    it('accepts a Report that names a beat, with the exact revision', async () => {
      const person = await seedPerson(database.db);
      const reports = reportCases(database.db);
      const beat = beatsOfV3(onlyV3.document)[4]!;
      const result = await reports.reportContentError(person.authority, {
        commandId: randomUUID(),
        target: ref(),
        category: 'wrong',
        anchor: { kind: 'scroll', blockId: beat.id },
      });
      expect(result.kind).toBe('received');
      const stored = await database.db
        .selectFrom('feedback.reports')
        .select(['asset_id', 'asset_revision', 'anchor'])
        .where('asset_id', '=', onlyV3.assetId)
        .execute();
      expect(stored).toMatchObject([{ asset_revision: 1, anchor: { kind: 'scroll', blockId: beat.id } }]);
    });

    it('gives a room’s daily items the beats as passages, the same text a reader sees', async () => {
      const seasons = await seedDocumentV3(database.db, 'seasons-v3-ci');
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: seasons.assetId,
          asset_revision: 1,
          topic_id: 'earth.seasons',
          role: 'primary',
          weight: 0.8,
        })
        .execute();
      const found = (await makeReadLibraryPassages(database.db)({ kind: 'planet', id: 'earth.seasons' }, 100)).find(
        (entry) => entry.assetId === seasons.assetId,
      );
      expect(found?.blocks).toEqual(beatsOfV3(seasons.document).map((beat) => ({ blockId: beat.id, text: beat.text })));
    });
  });

  describe('a document v3 has no calls (decision I1)', () => {
    it('reads as no play facts, never as a throw, so a lock, a challenge or a landmark finds nothing', async () => {
      expect(await inScope((scope) => readScrollPlayFacts(scope, onlyV3.assetId, 1))).toBeUndefined();
      // Its older v2 revision still has its calls: the facts follow the exact revision.
      const older = await inScope((scope) => readScrollPlayFacts(scope, threeAges.assetId, 2));
      expect(older?.calls.length).toBeGreaterThan(0);
      expect(await inScope((scope) => readScrollPlayFacts(scope, threeAges.assetId, 3))).toBeUndefined();
    });

    it('offers a room’s Launch no calls from a library Scroll that is a document v3, and does not fail', async () => {
      const seasons = await seedDocumentV3(database.db, 'seasons-v3-ci');
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: seasons.assetId,
          asset_revision: 1,
          topic_id: 'earth.seasons',
          role: 'primary',
          weight: 0.8,
        })
        .execute();
      const calls = await makeReadLibraryCalls(database.db)({ kind: 'planet', id: 'earth.seasons' }, 100);
      expect(calls.map((entry) => entry.assetId)).not.toContain(seasons.assetId);
    });
  });
});
