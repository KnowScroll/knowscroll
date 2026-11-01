import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * What the schema allows of a run's recording proof (migration 0094, D-264): the Planner's and Cartographer's, as before, and
 * Supply's four steps, at an odd generation and with both hashes. The code never writes anything else; this is the last line.
 */
describe('the recording proof of a personal run in the schema', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply_recording_proof');
    person = await seedPerson(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const digest = 'a'.repeat(64);
  const insert = (proof: {
    readonly owner: string;
    readonly purpose: string;
    readonly generation: number | null;
    readonly hash?: string | null;
  }) =>
    sql`insert into reasoning.business_runs
      (universe_id, id, owner_module, purpose, privacy_epoch, role_id, role_version, policy_version, provider, model,
       context_bundle_ref, context_refs, recording_account_id, recording_generation,
       recording_context_sha256, recording_model_context_sha256)
      values (${person.universeId}::uuid, ${randomUUID()}::uuid, ${proof.owner}, ${proof.purpose}, 1, 'ci.role', 'v1', 'ci.v1',
        'ci', 'ci', 'ci:bundle', '[]'::jsonb,
        ${proof.generation === null ? null : person.accountId}::uuid, ${proof.generation},
        ${proof.hash === undefined ? (proof.generation === null ? null : digest) : proof.hash},
        ${proof.hash === undefined ? (proof.generation === null ? null : digest) : proof.hash})`.execute(database.db);

  it.each(['ask-scope', 'ask-library', 'quick-answer', 'quick-answer-support'])(
    'accepts Supply’s %s at a later odd generation',
    async (purpose) => {
      await insert({ owner: 'supply', purpose, generation: 3 });
    },
  );

  it('still accepts the Planner’s and the Cartographer’s, and a run with no proof at all', async () => {
    await insert({ owner: 'planner', purpose: 'personal-planner', generation: 5 });
    await insert({ owner: 'geography', purpose: 'personal-cartographer', generation: 1 });
    await insert({ owner: 'supply', purpose: 'match-request', generation: null });
  });

  it('refuses a Supply step it does not list, another owner’s step under Supply, and Supply’s under another owner', async () => {
    for (const bad of [
      { owner: 'supply', purpose: 'match-request' },
      { owner: 'supply', purpose: 'personal-planner' },
      { owner: 'planner', purpose: 'ask-scope' },
      { owner: 'geography', purpose: 'quick-answer' },
      { owner: 'rooms', purpose: 'ask-scope' },
    ])
      await expect(insert({ ...bad, generation: 3 })).rejects.toThrow('reasoning_personal_recording_proof_shape');
  });

  it('refuses an even generation, a missing hash and a hash that is not a lowercase digest', async () => {
    await expect(insert({ owner: 'supply', purpose: 'ask-scope', generation: 4 })).rejects.toThrow(
      'reasoning_personal_recording_proof_shape',
    );
    await expect(insert({ owner: 'supply', purpose: 'ask-scope', generation: 3, hash: null })).rejects.toThrow(
      'reasoning_personal_recording_proof_shape',
    );
    await expect(
      insert({ owner: 'supply', purpose: 'ask-scope', generation: 3, hash: 'A'.repeat(64) }),
    ).rejects.toThrow('reasoning_personal_recording_proof_shape');
  });
});
