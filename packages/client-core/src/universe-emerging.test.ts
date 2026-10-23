import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { readDustCues } from './universe-emerging';

/** Authored protocol fixtures only. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'dust@fixture.test' };

function scopeReplying(respond: () => Response | Promise<Response>) {
  return createAccountScope({
    account,
    baseUrl: 'https://dust.fixture.test',
    store: memoryStore(),
    authorization: () => undefined,
    fetch: async () => respond(),
  });
}
const body = (overrides: Record<string, unknown> = {}) => ({
  version: 'universe-emerging.v1',
  universeId: account.universeId,
  privacyEpoch: 1,
  personalWatermark: 12,
  recordedAt: '2026-10-24T00:00:00.000Z',
  geography: { revision: 4, structureRevision: 4, activityRevision: 0 },
  dust: [{ id: id(50) }],
  ...overrides,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('readDustCues', () => {
  it('returns the opaque cues of this universe', async () => {
    const scope = scopeReplying(() => json(body()));
    expect(await readDustCues(scope)).toEqual({ status: 'ready', cues: [{ id: id(50) }], geographyRevision: 4 });
  });

  it('refuses a reply for another universe or epoch', async () => {
    const other = scopeReplying(() => json(body({ universeId: id(3) })));
    expect(await readDustCues(other)).toEqual({ status: 'unavailable', reason: 'invalid' });
    const stale = scopeReplying(() => json(body({ privacyEpoch: 2 })));
    expect(await readDustCues(stale)).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  it('maps authority, server and network failures to typed outcomes', async () => {
    const authority = scopeReplying(() => json(problemDetails('NOT_FOUND'), 404));
    expect((await readDustCues(authority)).status).toBe('unavailable');
    const offline = scopeReplying(() => {
      throw new TypeError('offline');
    });
    expect(await readDustCues(offline)).toEqual({ status: 'unavailable', reason: 'network' });
  });
});
