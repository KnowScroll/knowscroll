import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import { COMPOSE_ENCOUNTER, type ComposeEncounter, type ComposerSnapshot } from '@knowscroll/backend/modules/composer';
import {
  RUN_FEED_HEARTBEAT,
  RUN_NIGHTLY_RITUALS,
  RUN_SCOUT_HEARTBEAT,
  feedHeartbeatQueue,
  nightlyRitualsQueue,
  scoutHeartbeatQueue,
} from '@knowscroll/backend/modules/rooms';
import { jobWiring } from './jobs.js';
import { WORKER_CONFIG } from './tokens.js';

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

describe('the worker ranks buffers under the policy its own configuration sets (KS_COMPOSER_POLICY, D-190)', () => {
  const providers = jobWiring.filter(
    (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === COMPOSE_ENCOUNTER,
  );

  it('builds the compose provider from the worker configuration token, not from a fixed policy', () => {
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    // A fixed `composerProviders()` would give a `useValue`; the configured one is a factory over the worker's token.
    expect('useValue' in provider).toBe(false);
    expect(provider).toMatchObject({ inject: [WORKER_CONFIG] });
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

describe('the night’s ritual batch (rooms.nightly-rituals, D-176)', () => {
  it('is a declared release queue that runs once a night with a payload of its version only', () => {
    const declared = releaseQueues.find((queue) => queue.name === nightlyRitualsQueue.name);
    expect(declared?.schedule).toEqual({ cron: '10 3 * * *', payload: { v: 1 } });
    expect(nightlyRitualsQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    expect(nightlyRitualsQueue.payload.safeParse({ v: 1, roomId: 'x' }).success).toBe(false);
  });

  it('has its consumer built from the worker wiring', () => {
    const provided = jobWiring.filter(
      (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === RUN_NIGHTLY_RITUALS,
    );
    expect(provided).toHaveLength(1);
  });
});

describe('the residents’ heartbeat (rooms.feed-heartbeat, v3 R-8, D-248)', () => {
  it('is a declared release queue that looks three times a day, at the start of each 8-hour slot, with a payload of its version only', () => {
    const declared = releaseQueues.find((queue) => queue.name === feedHeartbeatQueue.name);
    expect(declared?.schedule).toEqual({ cron: '7 0,8,16 * * *', payload: { v: 1 } });
    expect(feedHeartbeatQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    // It names no person and no universe: its work is the room's own.
    expect(feedHeartbeatQueue.payload.safeParse({ v: 1, universeId: 'x' }).success).toBe(false);
    expect(feedHeartbeatQueue.payload.safeParse({ v: 1, roomId: 'x' }).success).toBe(false);
  });

  it('has its consumer built from the worker wiring', () => {
    const provided = jobWiring.filter(
      (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === RUN_FEED_HEARTBEAT,
    );
    expect(provided).toHaveLength(1);
  });
});

describe('the scouts’ heartbeat (rooms.scout-heartbeat, v3 R-9, D-259)', () => {
  it('is a declared release queue that looks three times a day a little after the residents, with a payload of its version only', () => {
    const declared = releaseQueues.find((queue) => queue.name === scoutHeartbeatQueue.name);
    expect(declared?.schedule).toEqual({ cron: '37 0,8,16 * * *', payload: { v: 1 } });
    expect(scoutHeartbeatQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    // It names no member, no room and no universe: whose scouts to look at is read from rows, under the room's own scope.
    expect(scoutHeartbeatQueue.payload.safeParse({ v: 1, universeId: 'x' }).success).toBe(false);
    expect(scoutHeartbeatQueue.payload.safeParse({ v: 1, ownerId: 'x' }).success).toBe(false);
  });

  it('has its consumer built from the worker wiring', () => {
    const provided = jobWiring.filter(
      (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === RUN_SCOUT_HEARTBEAT,
    );
    expect(provided).toHaveLength(1);
  });
});
