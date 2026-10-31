/**
 * `KS_COMPOSER_POLICY` (v3 S-5, D-190) on real PostgreSQL: a process makes new decisions under the policy it is set to
 * (`v0` unless set), stores them with that label, and every stored decision replays under the policy it names, so
 * decisions of both labels live in one database and neither stops replaying. Labelled CI fixtures: the starter
 * document under three explanation identities.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  COMPOSE_ENCOUNTER,
  composeEncounter,
  policyOf,
  type ComposeEncounter,
  type ComposerDecision,
} from '@knowscroll/backend/modules/composer';
import { composerConfiguredProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { fixtureSnapshots } from '../../../packages/backend/src/modules/composer/application/snapshot-fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Which policy a process makes new decisions under follows its configuration, `KS_COMPOSER_POLICY`. No database needed. */
describe('the composer providers choose the policy for new decisions (labelled CI fixtures)', () => {
  const access = { isOperator: () => false };
  const snapshot = fixtureSnapshots().find((candidate) => candidate.mode === 'vertical')!;
  const CONFIG = Symbol('test.config');

  const composeOf = (providers: readonly { provide: symbol; useValue?: unknown }[]) =>
    providers.find((provider) => provider.provide === COMPOSE_ENCOUNTER)!.useValue as ComposeEncounter;
  const configured = (setting: 'v0' | 'v1'): ComposeEncounter => {
    const provider = composerConfiguredProviders(access, CONFIG).find((p) => p.provide === COMPOSE_ENCOUNTER)!;
    if (!('useFactory' in provider) || provider.inject[0] !== CONFIG)
      throw new Error('CI expected a factory over the config');
    return provider.useFactory({ composerPolicy: setting });
  };

  it('names v0 unless a setting says v1, for a fixed setting', () => {
    expect(composeOf(composerProviders(access))(snapshot).policyVersion).toBe('composer-policy.v0');
    expect(composeOf(composerProviders(access, 'v0'))(snapshot).policyVersion).toBe('composer-policy.v0');
    expect(composeOf(composerProviders(access, 'v1'))(snapshot).policyVersion).toBe('composer-policy.v1');
  });

  it('follows the process configuration', () => {
    expect(configured('v0')(snapshot).policyVersion).toBe('composer-policy.v0');
    expect(configured('v1')(snapshot).policyVersion).toBe('composer-policy.v1');
  });

  it('keeps the other providers whatever the policy', () => {
    for (const providers of [composerProviders(access, 'v1'), composerConfiguredProviders(access, CONFIG)])
      expect(providers).toHaveLength(3);
  });
});

describe.each([
  [undefined, 'composer-policy.v0'],
  ['v0', 'composer-policy.v0'],
  ['v1', 'composer-policy.v1'],
] as const)('the Composer policy setting %s (real PostgreSQL, labelled CI fixtures)', (setting, label) => {
  let database: TestDatabase<Database> | undefined;
  let cases: Awaited<ReturnType<typeof scrollUseCases>> | undefined;
  afterAll(async () => {
    await cases?.close();
    await database?.drop();
  });

  it(`stores a navigation's decision under ${label}, and it replays under the policy it names`, async () => {
    database = await createTestDatabase<Database>(`composer_setting_${setting ?? 'unset'}`);
    cases = await scrollUseCases(database, setting === undefined ? {} : { composerPolicy: setting });
    for (const name of ['a', 'b', 'c']) {
      const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      source.assetId = randomUUID();
      source.publication.explanationUnitId = `ci-setting-${name}-${randomUUID()}`;
      const imported = await cases.importScroll(source);
      if (imported.kind !== 'imported') throw new Error('CI fixture refused');
    }
    const person = await seedPerson(database.db);
    const result = await cases.navigate(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'discover' },
      capabilities: textCapabilities,
    });
    if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI expected a ready offer');
    const row = (
      await sql<{
        policy_version: string;
        payload: ComposerDecision;
      }>`select policy_version, payload from composer.decisions where id = ${result.outcome.decisionId}::uuid`.execute(
        database.db,
      )
    ).rows[0]!;
    expect(row.policy_version).toBe(label);
    expect(row.payload.policyVersion).toBe(label);
    // The saved bytes are the replay of the input under the policy named, which the store checked on the way in.
    expect(canonical(composeEncounter(row.payload.input, policyOf(row.payload.policyVersion)))).toBe(
      canonical(row.payload),
    );
    // Only v1 carries the recent-topic share; a v0 decision has no such feature.
    const features = row.payload.evaluations.map((evaluation) => Object.keys(evaluation.features));
    expect(features.every((keys) => keys.includes('recentTopic'))).toBe(label === 'composer-policy.v1');
  });
});
