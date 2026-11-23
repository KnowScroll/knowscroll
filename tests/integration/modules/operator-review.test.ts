import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewListSchema, ReviewShowSchema } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  coverageHeadPorts,
  makeAdmissionStore,
  makeOperatorReview,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { OperatorReview } from '@knowscroll/backend/modules/content';
import { operatorAddressMatcher } from '@knowscroll/backend/modules/identity';
import { makeIsOperator } from '@knowscroll/backend/modules/operator';
import { beatsOfV3 } from '@knowscroll/scroll-model';
import { readAccountAddress } from '../../../packages/backend/src/modules/identity/adapters/postgres-store.js';
import { admitRecipeCoverage } from '../../../packages/backend/src/modules/content/application/admit-recipe-coverage.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { LIBRARY_SUPPORT_POLICY } from '../../../packages/backend/src/modules/content/domain/library-support.js';
import { compileEditorialSourceV3 } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler-v3.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../../../packages/backend/src/modules/content/production/library-support.js';
import { libraryCheckStore } from '../../../packages/backend/src/modules/content/production/library-support-store.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { documentV3Source } from '../support/scroll.js';

/**
 * The operator's review of held Scrolls on the app's screen (#780): who may see a held revision, what the screen is sent for
 * it, and the two decisions it makes through the review gate. The Scrolls are the hand-written document v3 fixtures stored as
 * held revisions by the admission store's own flag, as the writer's output will be; the support check result is a labelled
 * fixture row, never provider output. The operator is named the way `KS_OPERATOR_ACCOUNTS` names it, by an address pattern.
 */
describe('the operator review of held Scrolls (real PostgreSQL, hand-written fixture Scrolls)', () => {
  let database: TestDatabase<Database>;
  let review: OperatorReview;
  let liveReview: OperatorReview;
  let operator: FixturePerson;
  let stranger: FixturePerson;
  let nameless: FixturePerson;
  const operatorAddress = 'ops@ci.invalid';

  async function personWithAddress(address: string | undefined): Promise<FixturePerson> {
    const person = await seedPerson(database.db);
    if (address !== undefined)
      await database.db
        .insertInto('identity.email_addresses')
        .values({ account_id: person.accountId, address })
        .execute();
    return person;
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('operator_review');
    const matches = operatorAddressMatcher(operatorAddress);
    if (matches === undefined) throw new Error('the operator pattern is valid');
    const isOperator = makeIsOperator({
      readAddress: (accountId) => readAccountAddress(database.db, accountId),
      matchers: [matches],
    });
    review = makeOperatorReview({ db: database.db, isOperator, world: 'dev' });
    liveReview = makeOperatorReview({ db: database.db, isOperator, world: 'live' });
    operator = await personWithAddress(operatorAddress);
    stranger = await personWithAddress('someone@ci.invalid');
    nameless = await personWithAddress(undefined);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** Stores a hand-written document v3 as a revision held for review, with no topic and no coverage. */
  async function holdV3(name: 'fence' | 'seasons' | 'broad-street') {
    const source = documentV3Source(name);
    const assetId = randomUUID();
    const compiled = compileEditorialSourceV3({ ...source, assetId }, 1);
    if (compiled.kind !== 'compiled') throw new Error(`fixture ${name} did not compile`);
    const store = makeAdmissionStore(database.db);
    await store.inAdmission((tx) =>
      store.storeRevision(tx, {
        assetId,
        revision: 1,
        provenanceKind: 'authored_editorial',
        compiled,
        createsAsset: true,
        held: true,
      }),
    );
    return { assetId, source, compiled, target: { assetId, revision: 1 } };
  }
  type Held = Awaited<ReturnType<typeof holdV3>>;

  /** Admits the beat coverage of a held revision by the recipe the source names, so it can be released. */
  async function admitCoverage(held: Held) {
    const recipe = RECIPES[held.source['recipe'] as keyof typeof RECIPES];
    const store = makeAdmissionStore(database.db);
    await store.inAdmission((tx) =>
      admitRecipeCoverage(coverageHeadPorts, tx, recipe, { assetId: held.assetId, assetRevision: 1 }),
    );
  }

  /** A labelled fixture result of the support check: one sentence supported, one the passages do not state. */
  async function storeSupportCheck(held: Held) {
    const [first] = beatsOfV3(held.compiled.document as Parameters<typeof beatsOfV3>[0]);
    if (first === undefined) throw new Error('the fixture has a beat');
    await database.db.transaction().execute((trx) =>
      libraryCheckStore.write(trx, {
        assetId: held.assetId,
        revision: 1,
        checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
        state: 'checked',
        code: null,
        verdict: 'flagged',
        policyVersion: LIBRARY_SUPPORT_POLICY.id,
        round: 1,
        batchFailures: {},
        sentenceCount: 2,
        batches: 1,
        requests: 1,
        sentences: [
          { n: 1, part: first.id, field: 'paragraph', text: 'A sentence the passages state.', outcome: 'supported' },
          {
            n: 2,
            part: first.id,
            field: 'paragraph',
            text: 'A sentence the passages do not state.',
            outcome: 'unsupported',
            kind: 'not_stated',
            problem: 'No passage says this.',
          },
        ],
      }),
    );
  }

  const stateOf = (assetId: string) =>
    database.db
      .selectFrom('content.revision_reviews')
      .select(['state', 'decided_by', 'reason'])
      .where('asset_id', '=', assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();

  describe('an account that is not an operator', () => {
    it('gets not found on every route, whether or not the revision exists, and changes nothing', async () => {
      const held = await holdV3('fence');
      await admitCoverage(held);
      const missing = { assetId: randomUUID(), revision: 1 };
      for (const who of [stranger, nameless]) {
        const notOperator = { kind: 'not_found', why: 'not_operator' };
        expect(await review.list(who.accountId)).toEqual(notOperator);
        for (const target of [held.target, missing]) {
          expect(await review.show(who.accountId, target)).toEqual(notOperator);
          expect(await review.release(who.accountId, target)).toEqual(notOperator);
          expect(await review.reject(who.accountId, target, 'Not for me to say.')).toEqual(notOperator);
        }
      }
      expect(await stateOf(held.assetId)).toEqual({ state: 'held', decided_by: null, reason: null });
    });
  });

  describe('an operator in the live world', () => {
    it('gets not found on every route and changes nothing, as the CLI refuses live: review runs only where operator tools do', async () => {
      const held = await holdV3('fence');
      await admitCoverage(held);
      const notOperator = { kind: 'not_found', why: 'not_operator' };
      expect(await liveReview.list(operator.accountId)).toEqual(notOperator);
      expect(await liveReview.show(operator.accountId, held.target)).toEqual(notOperator);
      expect(await liveReview.release(operator.accountId, held.target)).toEqual(notOperator);
      expect(await liveReview.reject(operator.accountId, held.target, 'Not here.')).toEqual(notOperator);
      expect(await stateOf(held.assetId)).toEqual({ state: 'held', decided_by: null, reason: null });
    });
  });

  describe('an operator', () => {
    it('lists the held revisions with their facts and the words of both checks, and no body text', async () => {
      const held = await holdV3('broad-street');
      await admitCoverage(held);
      await storeSupportCheck(held);
      const unchecked = await holdV3('seasons');
      const listed = await review.list(operator.accountId);
      if (listed.kind !== 'listed') throw new Error('the operator lists');
      const parsed = ReviewListSchema.parse({ revisions: listed.revisions });
      const item = parsed.revisions.find((candidate) => candidate.assetId === held.assetId);
      expect(item).toMatchObject({
        revision: 1,
        documentVersion: 'scroll-document.v3',
        coverage: 'mapped',
        topic: null,
        // A document v3 has no calls: there is no answer check.
        answerCheck: null,
        supportCheck: 'flagged',
      });
      expect(item?.title).toBe((held.compiled.document as { title: string }).title);
      expect(item?.heldAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(parsed.revisions.find((candidate) => candidate.assetId === unchecked.assetId)).toMatchObject({
        coverage: 'unmapped',
        supportCheck: null,
      });
      // A list holds counts and titles, never a beat's words.
      const firstBeat = beatsOfV3(held.compiled.document as Parameters<typeof beatsOfV3>[0])[0];
      expect(JSON.stringify(parsed)).not.toContain(firstBeat?.text ?? 'x');
    });

    it('is shown the document as stored, its cover, the passages each part cites and what the support check found', async () => {
      const held = await holdV3('broad-street');
      await storeSupportCheck(held);
      const shown = await review.show(operator.accountId, held.target);
      if (shown.kind !== 'shown') throw new Error('the operator reads a held revision');
      const parsed = ReviewShowSchema.parse(shown.review);
      const stored = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', held.assetId)
        .where('revision', '=', 1)
        .executeTakeFirstOrThrow();
      expect(parsed.document).toEqual(stored.document);
      expect(parsed.cover?.version).toBe('offer-cover.v2');
      // A document v3's figure is a picture in a state, drawn by the general renderer.
      expect(parsed.cover?.figure !== undefined && 'picture' in parsed.cover.figure).toBe(true);
      expect(parsed.coverage).toBe('unmapped');
      // Every part that cites a passage names the quote and the title of its page, and carries no address.
      const first = beatsOfV3(held.compiled.document as Parameters<typeof beatsOfV3>[0])[0];
      const cited = parsed.parts.find((part) => part.partId === first?.id);
      expect(typeof cited?.passages[0]?.quote).toBe('string');
      expect(typeof cited?.passages[0]?.source).toBe('string');
      expect(Object.keys(cited?.passages[0] ?? {}).sort()).toEqual(['quote', 'source']);
      expect(JSON.stringify(parsed.parts)).not.toMatch(/https?:\/\//u);
      expect(parsed.parts.some((part) => part.partId === 'takeaway')).toBe(true);
      expect(parsed.answerCheck).toBeNull();
      expect(parsed.supportCheck).toMatchObject({
        verdict: 'flagged',
        counts: { sentences: 2, supported: 1, unsupported: 1 },
        attention: [{ partId: first?.id, outcome: 'unsupported', problem: 'No passage says this.' }],
      });
    });

    it('releases a held revision that has its coverage, records the account as the decider and never an address', async () => {
      const held = await holdV3('broad-street');
      await admitCoverage(held);
      const released = await review.release(operator.accountId, held.target);
      expect(released).toMatchObject({
        kind: 'decided',
        result: { outcome: 'released', reason: null, replacedRevision: null },
      });
      const row = await stateOf(held.assetId);
      expect(row.state).toBe('released');
      expect(row.decided_by).toMatch(/^app:[0-9a-f]{16}$/u);
      expect(row.decided_by).not.toContain(operatorAddress);
      expect(row.decided_by).not.toContain(operator.accountId);
      const asset = await database.db
        .selectFrom('content.assets')
        .select(['status', 'revision'])
        .where('id', '=', held.assetId)
        .executeTakeFirstOrThrow();
      expect(asset).toEqual({ status: 'admitted', revision: 1 });
      // The revision is not held any more, so every route finds nothing: a repeat does not read as a second release.
      const gone = { kind: 'not_found', why: 'not_held' };
      expect(await review.show(operator.accountId, held.target)).toEqual(gone);
      expect(await review.release(operator.accountId, held.target)).toEqual(gone);
      expect(await review.reject(operator.accountId, held.target, 'Too late.')).toEqual(gone);
      expect(await stateOf(held.assetId)).toMatchObject({ state: 'released' });
    });

    it('is told why the gate refuses a release, and the revision stays held', async () => {
      const held = await holdV3('fence');
      const refused = await review.release(operator.accountId, held.target);
      expect(refused).toMatchObject({
        kind: 'decided',
        result: { outcome: 'refused', reason: 'coverage_missing', replacedRevision: null },
      });
      expect(await stateOf(held.assetId)).toEqual({ state: 'held', decided_by: null, reason: null });
      expect(await review.show(operator.accountId, held.target)).toMatchObject({ kind: 'shown' });
    });

    it('rejects a held revision with a reason, keeps the reason and refuses an empty one', async () => {
      const held = await holdV3('seasons');
      expect(await review.reject(operator.accountId, held.target, '   ')).toEqual({ kind: 'reason_invalid' });
      expect(await review.reject(operator.accountId, held.target, 'x'.repeat(501))).toEqual({ kind: 'reason_invalid' });
      expect(await stateOf(held.assetId)).toMatchObject({ state: 'held' });
      expect(
        await review.reject(operator.accountId, held.target, '  The second picture says the opposite.  '),
      ).toMatchObject({
        kind: 'decided',
        result: { outcome: 'rejected', reason: null },
      });
      const row = await stateOf(held.assetId);
      expect(row).toMatchObject({ state: 'rejected', reason: 'The second picture says the opposite.' });
      expect(row.decided_by).toMatch(/^app:[0-9a-f]{16}$/u);
      expect(await review.show(operator.accountId, held.target)).toEqual({ kind: 'not_found', why: 'not_held' });
    });

    it('finds nothing for a revision that is not held, or that does not exist', async () => {
      const held = await holdV3('fence');
      const gone = { kind: 'not_found', why: 'not_held' };
      for (const target of [
        { assetId: randomUUID(), revision: 1 },
        { assetId: held.assetId, revision: 2 },
      ]) {
        expect(await review.show(operator.accountId, target)).toEqual(gone);
        expect(await review.release(operator.accountId, target)).toEqual(gone);
        expect(await review.reject(operator.accountId, target, 'No such revision.')).toEqual(gone);
      }
      expect(await stateOf(held.assetId)).toMatchObject({ state: 'held' });
    });

    it('leaves the support check replay with its own answer key: a decision made on the screen is not counted', async () => {
      const held = await holdV3('fence');
      expect(await review.reject(operator.accountId, held.target, 'Read with the verdict in view.')).toMatchObject({
        kind: 'decided',
      });
      const decided = await libraryCheckStore.decided(database.db, { since: undefined, limit: 500 });
      expect(decided.filter((entry) => entry.assetId === held.assetId)).toEqual([]);
    });
  });
});
