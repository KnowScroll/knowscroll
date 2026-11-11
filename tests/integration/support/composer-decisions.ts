import { randomUUID } from 'node:crypto';
import {
  COMPOSER_POLICY_V2,
  composeEncounter,
  type ComposerDecision,
  type ComposerPolicy,
  type ComposerSnapshot,
} from '@knowscroll/backend/modules/composer';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { FixturePerson } from './fixtures.js';

/**
 * Composer decisions built by the Composer's own code (`composeEncounter`), for the watchdog's rule over stored decisions. The
 * snapshot is a labelled CI fixture; the decision, its evaluations, its selection and its recorded history are what the code makes.
 */
export interface FixtureCandidate {
  readonly asset: string;
  readonly unit: string;
  readonly topic: string;
  /** The person has met the unit (an activated exposure): `true`; known unseen: `false`; history not read: absent. */
  readonly met?: boolean;
}

type Candidate = ComposerSnapshot['candidates'][number];
const candidateOf = (c: FixtureCandidate): Candidate => ({
  admitted: true,
  accessible: true,
  renderable: true,
  encounter: {
    assetId: c.asset,
    assetRevision: 1,
    kind: 'scroll',
    explanationUnitId: c.unit,
    metadata: { kind: 'scroll', title: 'CI Fixture', summary: 'A labelled CI fixture.', language: 'en' },
    topics: [{ topicId: c.topic, role: 'primary', weight: 1 }],
    facets: ['ci-facet'],
    siblings: [],
    catalogWatermark: 'ci-catalog',
    attributionVersion: 'ci-attribution',
  },
});

/**
 * A snapshot of a move. `intentTopic` is the topic the person is moving towards and `interest` how active they are in it: a
 * candidate about it ranks first unless a policy leaves it out, which is how a regression offers a met explanation first.
 */
export function snapshotOf(
  person: FixturePerson,
  candidates: readonly FixtureCandidate[],
  options: {
    readonly mode?: ComposerSnapshot['mode'];
    readonly exactTarget?: string;
    readonly intentTopic?: string;
  } = {},
): ComposerSnapshot {
  const evaluatedAt = new Date().toISOString();
  const watermark = 'ci-context';
  return {
    universeId: person.universeId,
    privacyEpoch: 1,
    evaluatedAt,
    seed: `ci-seed-${randomUUID()}`,
    mode: options.mode ?? 'vertical',
    intent: {
      language: 'en',
      topicIds: options.intentTopic === undefined ? [] : [options.intentTopic],
      text: '',
      ...(options.exactTarget === undefined ? {} : { exactTarget: { assetId: options.exactTarget, assetRevision: 1 } }),
    },
    candidates: candidates.map(candidateOf),
    explorationPool: [],
    evidence: {
      universeId: person.universeId,
      privacyEpoch: 1,
      evaluatedAt,
      watermark,
      policyVersion: 'ci-evidence',
      topics: options.intentTopic === undefined ? [] : [{ topicId: options.intentTopic, activity: 5, formats: [] }],
      recent: [],
      established: {
        policyVersion: 'ci-evidence',
        watermark,
        units: candidates.flatMap((c) =>
          c.met === undefined ? [] : [{ explanationUnitId: c.unit, encountered: c.met, facets: [] }],
        ),
      },
      hiddenAssetIds: [],
    },
    watermarks: { catalog: 'ci-catalog', continuity: 'none', taxonomy: 'ci-taxonomy', context: watermark },
  };
}

/** The decision policy v2 makes for `snapshot`. */
export const v2Decision = (snapshot: ComposerSnapshot): ComposerDecision =>
  composeEncounter(snapshot, COMPOSER_POLICY_V2);

/**
 * What a regression of policy v2 would record: the same code with unseen-first switched off, so a met explanation can be offered
 * beside an eligible unseen one, under the v2 label. The store refuses to keep it (it must replay under the real v2), so
 * `storeRaw` writes it the way only a bug would.
 */
export const regressedDecision = (snapshot: ComposerSnapshot): ComposerDecision => {
  const regressed: ComposerPolicy = { ...COMPOSER_POLICY_V2, encountered: 'score' };
  return composeEncounter(snapshot, regressed);
};

/** Stores a decision through the Composer's own persist function (which refuses anything that is not a replay of its input). */
export async function storeDecision(db: Kysely<Database>, person: FixturePerson, decision: ComposerDecision) {
  const { persistComposerDecision } = makeComposerStore({ isOperator: () => false });
  const outcome = await makeWithPersonalScope(db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
    persistComposerDecision(scope, { decisionId: randomUUID(), commandId: randomUUID() }, decision),
  );
  if (outcome.kind !== 'entered') throw new Error('CI scope refused');
  return outcome.value;
}

/** Writes a decision straight into the table, as only a regression could, with the same bytes the store writes. */
export async function storeRaw(db: Kysely<Database>, person: FixturePerson, decision: ComposerDecision) {
  await sql`insert into composer.decisions (id, universe_id, privacy_epoch, command_id, input_sha256, policy_version, payload, expires_at)
    values (${randomUUID()}::uuid, ${person.universeId}::uuid, 1, ${randomUUID()}::uuid, ${'b'.repeat(64)}, ${decision.policyVersion},
      ${JSON.stringify(decision)}::jsonb, now() + interval '30 days')`.execute(db);
}
