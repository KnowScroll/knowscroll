import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { waitFor } from '@testing-library/react-native';
import type { SavedPageResponse, RemoveKeepEntry } from '@knowscroll/contracts';
import { createSavedPages, createSavedRemoval, savedQueryOptions, REMOVE_GRACE_MS } from './saved-query';

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const item: SavedPageResponse['items'][number] = {
  assetId: id(3),
  assetRevision: 2,
  savedAt: '2026-10-20T10:00:00.000Z',
  kind: 'scroll',
  savedEntryId: id(4),
  availability: 'withdrawn',
};
/** Authored HTTP fixture. No live Saved membership or product activity. */
function fixture() {
  let membership = id(4);
  let wrongTarget = false;
  let fail = false;
  let gate: Promise<void> | undefined;
  const bodies: RemoveKeepEntry[] = [];
  const paths: string[] = [];
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'saved@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const body = (await request.json()) as RemoveKeepEntry;
      await gate;
      const scopeRef = { accountId: id(1), privacyEpoch: 1 };
      if (path.endsWith('/read'))
        return json({
          version: 'keep-place.v1',
          scope: scopeRef,
          target: { assetId: wrongTarget ? id(90) : item.assetId, assetRevision: 2 },
          status: 'saved_unavailable',
          entry: { assetId: wrongTarget ? id(90) : item.assetId, assetRevision: 2, savedEntryId: membership },
        });
      bodies.push(body);
      if (fail) throw new Error('Unknown acknowledgement fixture');
      return json({
        version: 'keep-remove.v1',
        scope: scopeRef,
        commandId: body.commandId,
        recordedAt: '2026-10-22T00:00:00.000Z',
        replayed: bodies.length > 1,
        outcome: 'accepted',
        operation: 'keep.entry.remove',
        entry: body.entry,
      });
    },
  });
  scope.queryClient.setQueryData(scope.queryKey('saved'), { revision: 1, items: [item] });
  const newId = jest.fn(() => id(8));
  return {
    scope,
    bodies,
    paths,
    newId,
    remove: createSavedRemoval(scope, newId),
    wrongTarget: () => {
      wrongTarget = true;
    },
    replace: () => {
      membership = id(5);
    },
    fail: (value: boolean) => {
      fail = value;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
  };
}
describe('exact Saved removal and cancellable grace', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  it('scopes the bounded list and never optimistically removes a cached item', async () => {
    const f = fixture();
    try {
      expect(savedQueryOptions(f.scope).queryKey).toEqual(['scope', f.scope.id, 'saved', 'page', 'all', 'first']);
      expect(await f.remove.prepare(item)).toBe(true);
      expect(f.remove.getState().status).toBe('grace');
      expect(f.bodies).toEqual([]);
      expect(f.scope.queryClient.getQueryData(f.scope.queryKey('saved'))).toEqual({ revision: 1, items: [item] });
      expect(f.remove.undo()).toBe(true);
      await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
      expect(f.bodies).toEqual([]);
      expect(f.remove.getState().status).toBe('idle');
    } finally {
      f.scope.end();
    }
  });
  it('revalidates exact membership before dispatch, removes withdrawn membership and closes Undo synchronously', async () => {
    const f = fixture();
    try {
      await f.remove.prepare(item);
      await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS - 1);
      expect(f.bodies).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await waitFor(() => expect(f.remove.getState().status).toBe('confirmed'));
      expect(f.remove.undo()).toBe(false);
      expect(f.paths).toEqual(['/v1/experience/keep/read', '/v1/experience/keep/read', '/v1/experience/keep/remove']);
      expect(f.bodies).toEqual([
        {
          version: 'keep-remove.v1',
          commandId: id(8),
          entry: { assetId: item.assetId, assetRevision: 2, savedEntryId: id(4) },
        },
      ]);
    } finally {
      f.scope.end();
    }
  });
  it('rejects a valid same-scope snapshot for another target before binding any removal command', async () => {
    const f = fixture();
    try {
      f.wrongTarget();
      expect(await f.remove.prepare(item)).toBe(false);
      expect(f.remove.getState().status).toBe('unavailable');
      await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
      expect(f.bodies).toEqual([]);
      expect(f.newId).not.toHaveBeenCalled();
    } finally {
      f.scope.end();
    }
  });
  it('refuses displayed membership A when the initial preparation reads B, before minting a UUID', async () => {
    const f = fixture();
    try {
      f.replace();
      expect(await f.remove.prepare(item)).toBe(false);
      expect(f.remove.getState().status).toBe('unavailable');
      expect(f.newId).not.toHaveBeenCalled();
      expect(f.bodies).toEqual([]);
    } finally {
      f.scope.end();
    }
  });
  it('refuses ABA during grace without deleting the replacement', async () => {
    const f = fixture();
    try {
      await f.remove.prepare(item);
      f.replace();
      await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
      await waitFor(() => expect(f.remove.getState().status).toBe('unavailable'));
      expect(f.bodies).toEqual([]);
    } finally {
      f.scope.end();
    }
  });
  it('retries an unknown removal with the identical UUID/ref and body, even after ABA; never resaves', async () => {
    const f = fixture();
    try {
      f.fail(true);
      await f.remove.prepare(item);
      await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
      await waitFor(() => expect(f.remove.getState().status).toBe('unknown'));
      expect(f.remove.undo()).toBe(false);
      expect(await f.remove.prepare(item)).toBe(false);
      f.replace();
      const replacement = { ...item, savedAt: '2026-10-22T10:00:00.000Z' };
      f.scope.queryClient.setQueryData(f.scope.queryKey('saved'), { revision: 2, items: [replacement] });
      f.fail(false);
      expect(f.remove.retry()).toBe(true);
      await waitFor(() => expect(f.remove.getState().status).toBe('confirmed'));
      expect(f.bodies).toEqual([f.bodies[0], f.bodies[0]]);
      expect(f.bodies[0]?.entry.savedEntryId).toBe(id(4));
      expect(f.newId).toHaveBeenCalledTimes(1);
      expect(f.scope.queryClient.getQueryData(f.scope.queryKey('saved'))).toEqual({
        revision: 2,
        items: [replacement],
      });
      expect(f.paths.every((path) => path.includes('/keep/'))).toBe(true);
    } finally {
      f.scope.end();
    }
  });
  it('scope end cancels grace, clears private state and fences late abort-ignoring reads', async () => {
    const f = fixture();
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.remove.prepare(item);
    f.scope.end();
    expect(f.remove.getState()).toEqual({ status: 'ended' });
    release();
    await pending;
    await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
    expect(f.bodies).toEqual([]);
    expect(f.scope.queryClient.getQueryData(f.scope.queryKey('saved'))).toBeUndefined();
  });
  it('scope end also cancels an already prepared grace timer', async () => {
    const f = fixture();
    await f.remove.prepare(item);
    f.scope.end();
    await jest.advanceTimersByTimeAsync(REMOVE_GRACE_MS);
    expect(f.bodies).toEqual([]);
    expect(f.remove.getState()).toEqual({ status: 'ended' });
  });
});

const cursorFor = (n: number) => `ksp1_${'a'.repeat(43)}${String(n).padStart(4, '0')}`;
function pageFixture(change: (value: SavedPageResponse) => unknown = (value) => value) {
  const requests: URL[] = [];
  let revision = 1;
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'paged@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(url);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const n = cursor ? Number(cursor.slice(-4)) : 0;
      const filter = url.searchParams.get('filter') as SavedPageResponse['filter'];
      return Promise.resolve(
        json(
          change({
            pagination: 'saved-page.v1',
            consistency: 'live',
            scope: { accountId: id(1), privacyEpoch: 1 },
            filter,
            limit: 20,
            ...(cursor ? { requestCursor: cursor } : {}),
            revision,
            items: filter === 'reel' ? [] : [{ ...item, assetId: id(100 + n), savedEntryId: id(1000 + n) }],
            continuation: n < 30 ? { status: 'more', cursor: cursorFor(n + 1) } : { status: 'end' },
          }),
        ),
      );
    },
  });
  return {
    scope,
    requests,
    pages: createSavedPages(scope),
    regress: () => {
      revision = 0;
    },
  };
}
describe('live Saved page admission and bounded traversal', () => {
  it('traverses arbitrary depth, retains twenty opaque previous cursors and deletes inactive payloads', async () => {
    const f = pageFixture();
    try {
      f.pages.start();
      for (let n = 0; n <= 30; n++) {
        await waitFor(() => expect(f.pages.getState().page?.items[0]?.assetId).toBe(id(100 + n)));
        expect(f.scope.queryClient.getQueryCache().findAll({ queryKey: f.scope.queryKey('saved') })).toHaveLength(1);
        if (n < 30) expect(f.pages.next()).toBe(true);
      }
      expect(f.pages.next()).toBe(false);
      for (let n = 29; n >= 10; n--) {
        expect(f.pages.previous()).toBe(true);
        await waitFor(() => expect(f.pages.getState().page?.items[0]?.assetId).toBe(id(100 + n)));
      }
      expect(f.pages.getState()).toMatchObject({ canPrevious: false, olderDiscarded: true });
      expect(f.pages.previous()).toBe(false);
      f.pages.select(f.pages.getState().page?.items[0]);
      expect(f.pages.getState().selected).toBeDefined();
      f.pages.refresh('reel');
      expect(f.pages.getState().selected).toBeUndefined();
      await waitFor(() => expect(f.pages.getState().status).toBe('ready'));
      expect(f.pages.getState()).toMatchObject({
        filter: 'reel',
        canPrevious: false,
        olderDiscarded: false,
        page: { items: [], continuation: { status: 'more' } },
      });
      expect(f.requests.at(-1)?.searchParams.get('cursor')).toBeNull();
      f.scope.end();
      expect(f.pages.getState()).toEqual({ status: 'ended', filter: 'all', canPrevious: false, olderDiscarded: false });
      expect(f.scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
    } finally {
      f.pages.stop();
      f.scope.end();
    }
  });
  it.each(['legacy', 'account', 'epoch', 'filter', 'limit', 'cursor'] as const)(
    'refuses %s correlation instead of displaying a page',
    async (mismatch) => {
      const f = pageFixture((value) => {
        if (mismatch === 'legacy') return { revision: value.revision, items: [] };
        if (mismatch === 'account') return { ...value, scope: { ...value.scope, accountId: id(90) } };
        if (mismatch === 'epoch') return { ...value, scope: { ...value.scope, privacyEpoch: 2 } };
        if (mismatch === 'filter') return { ...value, filter: 'reel', items: [] };
        if (mismatch === 'limit') return { ...value, limit: 19 };
        return { ...value, requestCursor: cursorFor(99) };
      });
      try {
        f.pages.start();
        await waitFor(() => expect(f.pages.getState().status).toBe('unavailable'));
        expect(f.pages.getState().page).toBeUndefined();
      } finally {
        f.pages.stop();
        f.scope.end();
      }
    },
  );
  it('drops an abort-ignoring prior-filter response and purges a late response on scope end', async () => {
    const replies: ((value: Response) => void)[] = [];
    const urls: URL[] = [];
    const scope = createAccountScope({
      account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'late@fixture.test' },
      baseUrl: 'https://fixture.test',
      authorization: () => undefined,
      store: memoryStore(),
      fetch: (request) => {
        urls.push(new URL(request.url));
        return new Promise((resolve) => {
          replies.push(resolve);
        });
      },
    });
    const pages = createSavedPages(scope);
    const response = (filter: 'all' | 'reel') =>
      json({
        pagination: 'saved-page.v1',
        consistency: 'live',
        scope: { accountId: id(1), privacyEpoch: 1 },
        filter,
        limit: 20,
        revision: 2,
        items: [],
        continuation: { status: 'end' },
      });
    try {
      pages.start();
      await waitFor(() => expect(replies).toHaveLength(1));
      pages.refresh('reel');
      await waitFor(() => expect(replies).toHaveLength(2));
      replies[1]!(response('reel'));
      await waitFor(() => expect(pages.getState().status).toBe('ready'));
      replies[0]!(response('all'));
      await Promise.resolve();
      expect(pages.getState()).toMatchObject({ filter: 'reel', page: { filter: 'reel' } });
      expect(scope.queryClient.getQueryCache().getAll()).toHaveLength(1);
      pages.refresh();
      await waitFor(() => expect(replies).toHaveLength(3));
      scope.end();
      replies[2]!(response('reel'));
      await Promise.resolve();
      expect(pages.getState()).toEqual({ status: 'ended', filter: 'all', canPrevious: false, olderDiscarded: false });
      expect(scope.queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(urls.map((url) => url.searchParams.get('filter'))).toEqual(['all', 'reel', 'reel']);
    } finally {
      pages.stop();
      scope.end();
    }
  });
  it('rejects a regressive revision within a traversal; explicit Refresh starts a new traversal', async () => {
    const f = pageFixture();
    try {
      f.pages.start();
      await waitFor(() => expect(f.pages.getState().status).toBe('ready'));
      f.regress();
      f.pages.next();
      await waitFor(() => expect(f.pages.getState().status).toBe('unavailable'));
      expect(f.pages.getState().page).toBeUndefined();
      f.pages.refresh();
      await waitFor(() => expect(f.pages.getState().status).toBe('ready'));
      expect(f.pages.getState().page?.revision).toBe(0);
    } finally {
      f.pages.stop();
      f.scope.end();
    }
  });
});
