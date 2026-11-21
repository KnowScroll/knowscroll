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
 * Serving a document v3 (#763, D-129, D-435): a client that declares the schema is served the document whole; a client that does not
 * is offered nothing for an asset whose current revision is a v3, because a released v3 retires the asset's earlier revisions (they are served
 * to no one, pinned or not); a revision pinned by an offer or a link is never swapped. The second suite, `retirement`, is what is left of the
 * fallback and the rest of retirement. Fixtures are scroll-model's labelled CI documents, re-sealed under fresh assets, over real PostgreSQL; no provider.
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

  describe('the revision an older app is offered (decision H1, amended by D-435)', () => {
    it('is the current revision for a client that declares the schema', async () => {
      expect(await offered(v3Client)).toEqual(
        new Map([
          [onlyV3.assetId, 1],
          [threeAges.assetId, 3],
          [twoAges.assetId, 2],
        ]),
      );
    });

    it('is nothing for a v2-only client, for an asset that is only a document v3 and for an asset whose earlier v1 and v2 revisions a document v3 retired', async () => {
      // threeAges holds a v1 revision 1 and a v2 revision 2, and twoAges a v2 revision 1: all retired by the document v3 that followed (D-435).
      expect(await offered(v2Client)).toEqual(new Map());
    });

    it('is nothing for a v1-only client for such an asset too; the fallback to a v1 remains only where the current revision is a v2 (see `retirement`)', async () => {
      expect(await offered(v1Client)).toEqual(new Map());
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
      // The earlier revision was retired by the v3 that followed it: no exact read opens it, for the client that could render it either.
      for (const capabilities of [v2Client, v3Client])
        expect(
          await inScope((scope) =>
            readExactEncounter(scope, { assetId: twoAges.assetId, assetRevision: 1, capabilities }),
          ),
        ).toBeUndefined();
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
      // Its older v2 revision had calls, and the document v3 that followed retired it (D-435): the facts follow the exact revision, and a retired one is absent.
      expect(await inScope((scope) => readScrollPlayFacts(scope, threeAges.assetId, 2))).toBeUndefined();
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

/**
 * Retirement (D-435, amending decision H1 of #756 and D-433): a released document v3 retires its asset's earlier v1 and v2 revisions, so an app without
 * v3 gets nothing for that Scroll and no earlier revision is opened by anyone. The rule is read from rows that already exist: an asset whose current
 * revision is a `scroll-document.v3` has retired every revision before it. Where the current revision is a v2, a v1 still stands in for a v1-only app.
 * An asset of its own for each case, in a database of its own, over real PostgreSQL; no provider.
 */
describe('retirement: a released document v3 retires its asset’s v1 and v2 revisions (D-435, real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let c: Cases;
  /** v1 revision 1, v2 revision 2 and a document v3 revision 3. */
  let threeAges: {
    assetId: string;
    v3: Awaited<ReturnType<typeof seedDocumentV3>>;
    v2: Awaited<ReturnType<typeof seedDocumentV2>>;
  };
  /** v2 revision 1 and a document v3 revision 2, no v1. */
  let twoAges: { assetId: string; v3: Awaited<ReturnType<typeof seedDocumentV3>> };
  /** v1 revision 1 and v2 revision 2, and no document v3: the v1 still stands in for a v1-only app. */
  let standIn: { assetId: string; v2: Awaited<ReturnType<typeof seedDocumentV2>> };

  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  async function inScope<T>(run: (scope: Parameters<Parameters<ReturnType<typeof withScope>>[1]>[0]) => Promise<T>) {
    const person = await recordingPerson(database);
    const entered = await withScope()(person.authority, run);
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value;
  }
  const offeredFor = async (capabilities: ReturnType<typeof capabilitiesOf>, assetId: string) =>
    (
      await inScope((scope) =>
        readDiscoveryCandidates(scope, { languages: ['en'], formats: ['scroll'], capabilities, limit: 100 }),
      )
    ).find((entry) => entry.assetId === assetId)?.assetRevision;

  /** An asset whose first revision is a v1 from the starter source, so a later v2 and v3 are corrections of it. */
  async function v1Asset(label: string) {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-${label}-${randomUUID()}`;
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    return { assetId: imported.assetId, unit: source.publication.explanationUnitId };
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('scroll_v3_retirement');
    c = await scrollUseCases(database, { recording: true });

    const three = await v1Asset('retire-three');
    const into = (revision: number) => ({ assetId: three.assetId, revision, unit: three.unit });
    const v2 = await seedDocumentV2(database.db, 'seasons-stage-ci', into(2));
    threeAges = { assetId: three.assetId, v2, v3: await seedDocumentV3(database.db, 'seasons-v3-ci', into(3)) };

    const first = await seedDocumentV2(database.db, 'scale-chart-blocks-ci');
    twoAges = {
      assetId: first.assetId,
      v3: await seedDocumentV3(database.db, 'broad-street-v3-ci', {
        assetId: first.assetId,
        revision: 2,
        unit: `ci-retire-two-${randomUUID()}`,
      }),
    };

    const older = await v1Asset('stand-in');
    standIn = {
      assetId: older.assetId,
      v2: await seedDocumentV2(database.db, 'seasons-stage-ci', {
        assetId: older.assetId,
        revision: 2,
        unit: older.unit,
      }),
    };
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  describe('what an app is offered', () => {
    it('is the current revision for an app that declares the v3, and nothing for an app that does not, for an asset whose current revision is a v3', async () => {
      expect(await offeredFor(v3Client, threeAges.assetId)).toBe(3);
      expect(await offeredFor(v3Client, twoAges.assetId)).toBe(2);
      for (const capabilities of [v2Client, v1Client]) {
        expect(await offeredFor(capabilities, threeAges.assetId)).toBeUndefined();
        expect(await offeredFor(capabilities, twoAges.assetId)).toBeUndefined();
      }
    });

    it('is still the latest earlier revision the app reads where the current revision is a v2: a v1 stands in for a v1-only app', async () => {
      expect(await offeredFor(v3Client, standIn.assetId)).toBe(2);
      expect(await offeredFor(v2Client, standIn.assetId)).toBe(2);
      expect(await offeredFor(v1Client, standIn.assetId)).toBe(1);
    });

    it('is nothing from a v2 asset’s earlier revision once a v3 follows it, and the v1 stand-in comes back for no one: a held v3 retires nothing, a released one retires at once', async () => {
      const held = await v1Asset('held-v3');
      const into = (revision: number) => ({ assetId: held.assetId, revision, unit: held.unit });
      await seedDocumentV2(database.db, 'seasons-stage-ci', into(2));
      await seedDocumentV3(database.db, 'seasons-v3-ci', into(3));
      // A revision the review gate holds never becomes the asset's current revision: put the pointer where it would be, with the row that holds revision 3.
      await database.db.updateTable('content.assets').set({ revision: 2 }).where('id', '=', held.assetId).execute();
      await database.db
        .insertInto('content.revision_reviews')
        .values({ asset_id: held.assetId, revision: 3, state: 'held' })
        .execute();
      expect(await offeredFor(v1Client, held.assetId)).toBe(1);
      expect(await offeredFor(v2Client, held.assetId)).toBe(2);
      expect(await offeredFor(v3Client, held.assetId)).toBe(2);
      expect(await c.renderScroll({ assetId: held.assetId, revision: 2, capabilities: v2Client })).toMatchObject({
        kind: 'rendition',
      });
      // Released: the pointer moves and the review row says so, as the gate does in one transaction.
      await database.db.updateTable('content.assets').set({ revision: 3 }).where('id', '=', held.assetId).execute();
      await database.db
        .updateTable('content.revision_reviews')
        .set({ state: 'released', decided_at: new Date(), decided_by: 'cli:ci-reviewer' })
        .where('asset_id', '=', held.assetId)
        .where('revision', '=', 3)
        .execute();
      expect(await offeredFor(v1Client, held.assetId)).toBeUndefined();
      expect(await offeredFor(v2Client, held.assetId)).toBeUndefined();
      expect(await offeredFor(v3Client, held.assetId)).toBe(3);
      expect(await c.renderScroll({ assetId: held.assetId, revision: 2, capabilities: v2Client })).toEqual({
        kind: 'not_found',
      });
    });

    it('leaves an earlier document v3 readable when a later v3 corrects it: only v1 and v2 revisions retire', async () => {
      const first = await seedDocumentV3(database.db, 'fence-v3-ci');
      await seedDocumentV3(database.db, 'broad-street-v3-ci', {
        assetId: first.assetId,
        revision: 2,
        unit: `ci-v3-over-v3-${randomUUID()}`,
      });
      expect(await offeredFor(v3Client, first.assetId)).toBe(2);
      // A person who opened revision 1 before the correction can still read it, as for any correction (D-129).
      expect(await c.renderScroll({ assetId: first.assetId, revision: 1, capabilities: v3Client })).toMatchObject({
        kind: 'rendition',
      });
    });

    it('is the stage frame of a v2 Scroll that is the current revision, to a v2-only session, and no cover for an asset that is now a v3', async () => {
      const person = await recordingPerson(database);
      const result = await c.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' as const },
        capabilities: capabilitiesOf(V1, V2, COVER_V2),
      });
      if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
      const outcome: Ready = result.outcome;
      const offers = [outcome.offer, ...outcome.bufferedOffers];
      const current = offers.find((offer: EncounterOffer) => offer.assetId === standIn.assetId);
      expect(current?.assetRevision).toBe(2);
      expect(current?.cover).toMatchObject({ version: COVER_V2, figure: firstFrameOf(standIn.v2.document) });
      for (const retired of [threeAges.assetId, twoAges.assetId])
        expect(offers.some((offer: EncounterOffer) => offer.assetId === retired)).toBe(false);
    });
  });

  describe('what is opened by a revision pinned by an offer, a link or an exposure', () => {
    const pinned = (assetId: string, assetRevision: number, capabilities: ReturnType<typeof capabilitiesOf>) => ({
      assetId,
      assetRevision,
      capabilities,
    });

    it('opens no earlier revision of an asset whose current revision is a v3, for any app, not even one that reads it', async () => {
      for (const [asset, revisions] of [
        [twoAges.assetId, [1]],
        [threeAges.assetId, [1, 2]],
      ] as const)
        for (const revision of revisions)
          for (const capabilities of [v3Client, v2Client, v1Client]) {
            expect(
              await inScope((scope) => readExactEncounter(scope, pinned(asset, revision, capabilities))),
            ).toBeUndefined();
            expect(
              await inScope((scope) => readOfferEncounter(scope, pinned(asset, revision, capabilities))),
            ).toBeUndefined();
          }
      // Its current revision opens, for the app that declares it; a v2 that is current opens for its own app.
      expect(await inScope((scope) => readExactEncounter(scope, pinned(threeAges.assetId, 3, v3Client)))).toMatchObject(
        {
          assetRevision: 3,
        },
      );
      expect(await inScope((scope) => readExactEncounter(scope, pinned(standIn.assetId, 2, v2Client)))).toMatchObject({
        assetRevision: 2,
      });
    });

    it('answers a render of such a revision as it answers any revision that cannot be read, not_found, to every app, and leaves the current revision alone', async () => {
      for (const capabilities of [v3Client, v2Client, v1Client]) {
        expect(await c.renderScroll({ assetId: twoAges.assetId, revision: 1, capabilities })).toEqual({
          kind: 'not_found',
        });
        expect(await c.renderScroll({ assetId: threeAges.assetId, revision: 1, capabilities })).toEqual({
          kind: 'not_found',
        });
        expect(await c.renderScroll({ assetId: threeAges.assetId, revision: 2, capabilities })).toEqual({
          kind: 'not_found',
        });
      }
      expect(await c.renderScroll({ assetId: threeAges.assetId, revision: 3, capabilities: v3Client })).toMatchObject({
        kind: 'rendition',
      });
      // A v2 that is current is still rendered for a v2 app, and its v1 for a v1 app, as before.
      expect(await c.renderScroll({ assetId: standIn.assetId, revision: 2, capabilities: v2Client })).toMatchObject({
        kind: 'rendition',
      });
      expect(await c.renderScroll({ assetId: standIn.assetId, revision: 1, capabilities: v1Client })).toMatchObject({
        kind: 'rendition',
      });
    });

    it('does not render after the v3 was released a revision that was rendered before it: the cache never answers for a retired one', async () => {
      const early = await seedDocumentV2(database.db, 'scale-chart-blocks-ci');
      expect(await c.renderScroll({ assetId: early.assetId, revision: 1, capabilities: v2Client })).toMatchObject({
        kind: 'rendition',
      });
      await seedDocumentV3(database.db, 'broad-street-v3-ci', {
        assetId: early.assetId,
        revision: 2,
        unit: `ci-cache-${randomUUID()}`,
      });
      expect(await c.renderScroll({ assetId: early.assetId, revision: 1, capabilities: v2Client })).toEqual({
        kind: 'not_found',
      });
    });

    it('refuses the exposure of a person who opened the earlier revision before the v3 was released, as it refuses any exposure whose document cannot be read', async () => {
      const person = await seedPerson(database.db);
      const before = await seedDocumentV2(database.db, 'scale-chart-blocks-ci');
      const opened = await c.openExposure(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: before.assetId },
        origin: { kind: 'direct' },
        capabilities: v2Client,
      });
      if (opened.kind !== 'opened') throw new Error('CI open refused');
      expect(await c.readExposureDocument(person.authority, opened.outcome.exposureId)).toMatchObject({
        kind: 'document',
      });
      await seedDocumentV3(database.db, 'broad-street-v3-ci', {
        assetId: before.assetId,
        revision: 2,
        unit: `ci-exposure-${randomUUID()}`,
      });
      expect(await c.readExposureDocument(person.authority, opened.outcome.exposureId)).toEqual({
        kind: 'refused',
        reason: 'exposure_not_found',
      });
    });

    it('gives Ask, a Quick answer and a call’s facts nothing from such a revision, and still gives them from a v2 that is current', async () => {
      const firstStop = (document: { stops: { id: string }[] }) => document.stops[0]!.id;
      const retired = { assetId: threeAges.assetId, assetRevision: 2 };
      expect(
        await inScope((scope) => readScrollAskFacts(scope, retired, firstStop(threeAges.v2.document))),
      ).toBeUndefined();
      expect(
        await inScope((scope) => readScrollQuickAnswerFacts(scope, retired, firstStop(threeAges.v2.document))),
      ).toBeUndefined();
      expect(await inScope((scope) => readScrollPlayFacts(scope, threeAges.assetId, 2))).toBeUndefined();
      const current = { assetId: standIn.assetId, assetRevision: 2 };
      expect(
        await inScope((scope) => readScrollAskFacts(scope, current, firstStop(standIn.v2.document))),
      ).toMatchObject({
        title: standIn.v2.document.title,
      });
      expect((await inScope((scope) => readScrollPlayFacts(scope, standIn.assetId, 2)))?.calls.length).toBeGreaterThan(
        0,
      );
    });
  });
});
