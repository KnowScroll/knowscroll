import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { readSystemFinds } from './universe-system-finds';

/** Authored protocol fixtures only. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'finds@fixture.test' };
const input = { systemId: id(20), readId: id(21) };

function scopeReplying(respond: (body: unknown) => Response | Promise<Response>) {
  return createAccountScope({
    account,
    baseUrl: 'https://finds.fixture.test',
    store: memoryStore(),
    authorization: () => undefined,
    fetch: async (request) => respond(await request.json()),
  });
}
const body = (overrides: Record<string, unknown> = {}) => ({
  version: 'universe-system-finds.v1',
  readId: input.readId,
  universeId: account.universeId,
  privacyEpoch: 1,
  personalWatermark: 12,
  systemId: input.systemId,
  status: 'ready',
  finds: [{ assetId: id(50), assetRevision: 1, kind: 'reel', title: 'Attention, watched' }],
  ...overrides,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('readSystemFinds (#697)', () => {
  it('asks for one system by its map id and returns its finds', async () => {
    const asked: unknown[] = [];
    const scope = scopeReplying((sent) => {
      asked.push(sent);
      return json(body());
    });
    expect(await readSystemFinds(scope, input)).toEqual({
      status: 'ready',
      finds: [{ assetId: id(50), assetRevision: 1, kind: 'reel', title: 'Attention, watched' }],
    });
    expect(asked).toEqual([{ version: 'universe-system-finds.v1', readId: input.readId, systemId: input.systemId }]);
  });

  it('passes on that a system is not on the map', async () => {
    const scope = scopeReplying(() => json(body({ status: 'unavailable', reason: 'not_on_map', finds: undefined })));
    expect(await readSystemFinds(scope, input)).toEqual({ status: 'unavailable', reason: 'not_on_map' });
  });

  it('refuses a reply for another universe, epoch, read or system', async () => {
    for (const over of [{ universeId: id(3) }, { privacyEpoch: 2 }, { readId: id(9) }, { systemId: id(9) }])
      expect(
        await readSystemFinds(
          scopeReplying(() => json(body(over))),
          input,
        ),
      ).toEqual({
        status: 'unavailable',
        reason: 'invalid',
      });
  });

  it('maps authority, server and network failures to typed outcomes', async () => {
    const away = scopeReplying(() => json(problemDetails('UNIVERSE_UNAVAILABLE'), 404));
    expect(await readSystemFinds(away, input)).toEqual({ status: 'unavailable', reason: 'authority' });
    const offline = scopeReplying(() => {
      throw new TypeError('offline');
    });
    expect(await readSystemFinds(offline, input)).toEqual({ status: 'unavailable', reason: 'network' });
  });
});
