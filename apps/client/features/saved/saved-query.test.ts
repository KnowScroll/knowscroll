import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import type { ListSavedResponse } from '@knowscroll/contracts';
import { createSavedRemoval, savedQueryOptions } from './saved-query';

const ID = '0199a000-0000-7000-8000-000000000001';
const item: ListSavedResponse['items'][number] = {
  assetId: ID,
  assetRevision: 2,
  savedAt: '2026-10-20T10:00:00.000Z',
  metadata: { kind: 'scroll', title: 'Withdrawn fixture', summary: 'CI metadata only', language: 'en' },
  availability: 'withdrawn',
};
function fixture() {
  let fail = true;
  const bodies: unknown[] = [];
  const scope = createAccountScope({
    account: { accountId: ID, universeId: ID, privacyEpoch: 1, email: 'saved@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      bodies.push(await request.clone().json());
      if (fail) throw new Error('Unknown outcome fixture');
      return new Response(
        JSON.stringify({
          commandId: ID,
          actionId: ID,
          kind: 'unsave',
          assetId: ID,
          assetRevision: 2,
          saved: false,
          changed: true,
          revision: 2,
          replayed: false,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  scope.queryClient.setQueryData(scope.queryKey('saved'), { revision: 1, items: [item] });
  const newId = jest.fn(() => ID);
  return {
    scope,
    bodies,
    newId,
    remove: createSavedRemoval(scope, newId),
    succeed: () => {
      fail = false;
    },
  };
}
describe('bounded Saved query and removal', () => {
  it('asks for at most 100 and scopes its query cache', () => {
    const f = fixture();
    try {
      expect(savedQueryOptions(f.scope).queryKey).toEqual(['scope', f.scope.id, 'saved']);
    } finally {
      f.scope.end();
    }
  });
  it('removes a withdrawn exact saved reference, rolls back unknown failure and retries the same command', async () => {
    const f = fixture();
    try {
      expect(await f.remove(item)).toBe(false);
      expect(f.scope.queryClient.getQueryData(f.scope.queryKey('saved'))).toEqual({ revision: 1, items: [item] });
      f.succeed();
      expect(await f.remove(item)).toBe(true);
      expect(f.bodies).toEqual([f.bodies[0], f.bodies[0]]);
      expect(f.bodies[0]).toEqual({ commandId: ID, kind: 'unsave', target: { assetId: ID, assetRevision: 2 } });
      expect(f.newId).toHaveBeenCalledTimes(1);
      expect(f.scope.queryClient.getQueryData<ListSavedResponse>(f.scope.queryKey('saved'))?.items).toEqual([]);
    } finally {
      f.scope.end();
    }
  });
  it('does not resurrect an optimistic item after the scope ends', async () => {
    const f = fixture();
    const pending = f.remove(item);
    f.scope.end();
    await pending;
    expect(f.scope.queryClient.getQueryData(f.scope.queryKey('saved'))).toBeUndefined();
    expect(f.bodies).toEqual([]);
  });
});
