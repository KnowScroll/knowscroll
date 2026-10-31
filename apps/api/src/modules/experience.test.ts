import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { COMPOSE_ENCOUNTER, type ComposeEncounter, type ComposerSnapshot } from '@knowscroll/backend/modules/composer';
import { experienceWiring } from './experience.js';
import { API_CONFIG } from '../tokens.js';

/** A labelled CI fixture: a vertical move with nothing to offer, which still names the policy it was made under. */
const SNAPSHOT: ComposerSnapshot = {
  universeId: 'ci-universe',
  privacyEpoch: 1,
  evaluatedAt: '2026-10-31T12:00:00.000Z',
  seed: 'ci-seed',
  mode: 'vertical',
  intent: { language: 'en', topicIds: [], text: '' },
  candidates: [],
  explorationPool: [],
  watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
};

describe('the API ranks under the policy its own configuration sets (KS_COMPOSER_POLICY, D-190)', () => {
  const providers = experienceWiring.filter(
    (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === COMPOSE_ENCOUNTER,
  );

  it('builds the compose provider from the API configuration token, not from a fixed policy', () => {
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    // A fixed `composerProviders()` would give a `useValue`; the configured one is a factory over the API's token.
    expect('useValue' in provider).toBe(false);
    expect(provider).toMatchObject({ inject: [API_CONFIG] });
  });

  it('makes a decision under v0 by default and under v1 only when the configuration says v1', () => {
    const provider = providers[0]!;
    if (!('useFactory' in provider)) throw new Error('CI expected a factory provider');
    const composeUnder = (composerPolicy: 'v0' | 'v1') =>
      (provider.useFactory as (config: { composerPolicy: 'v0' | 'v1' }) => ComposeEncounter)({ composerPolicy });
    expect(composeUnder('v0')(SNAPSHOT).policyVersion).toBe('composer-policy.v0');
    expect(composeUnder('v1')(SNAPSHOT).policyVersion).toBe('composer-policy.v1');
  });
});
