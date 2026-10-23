import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createContentSharesSession } from './content-shares-session';
import { createConversationsSession } from './conversations-session';
import { SOCIAL_LIMITS, socialOwnerFor } from './conversations-types';
// Authored private API fixtures. No real share, link delivery, membership or content grant.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'share@fixture.test' },
  scopeValue = { accountId: id(1), privacyEpoch: 1 };
const target = { assetId: id(3), assetRevision: 1 },
  ref = { conversationId: id(4), membershipId: id(5), membershipRevision: 1 };
const token = `kssh_${'z'.repeat(43)}`,
  version = 'content-share.v1',
  recordedAt = '2026-10-23T00:00:00.000Z',
  expiresAt = '2026-10-24T00:00:00.000Z';
const content = {
  status: 'available',
  target,
  metadata: { kind: 'reel', title: 'Authored public card', summary: 'PUBLIC_CARD_CANARY', language: 'en' },
};
function deferred<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function reply(path: string, x: Record<string, unknown>): unknown {
  const receipt = {
    version,
    scope: scopeValue,
    commandId: x.commandId,
    outcome: 'accepted',
    replayed: false,
    recordedAt,
  };
  if (path.endsWith('/create'))
    return {
      acceptance: {
        ...receipt,
        operation: 'content-share.create',
        shareId: id(6),
        target: x.target,
        audience: x.audience,
        expiresAt,
      },
      delivery: { status: 'available', token },
    };
  if (path.endsWith('/revoke')) return { ...receipt, operation: 'content-share.revoke', shareId: x.shareId };
  if (path.endsWith('/read'))
    return {
      version,
      scope: scopeValue,
      readId: x.readId,
      selector: x.selector,
      status: 'available',
      shareId: id(6),
      target,
      audience: { kind: 'public_metadata' },
      state: 'active',
      expiresAt,
    };
  if (path.endsWith('/resolve')) return { version, readId: x.readId, status: 'public_metadata', content };
  throw new Error('UNEXPECTED_FIXTURE_REQUEST');
}
function fixture(handler: (path: string, input: Record<string, unknown>, request: Request) => unknown = reply) {
  let next = 100;
  const calls: { path: string; body: Record<string, unknown>; url: string }[] = [],
    store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    baseUrl: 'https://shares.fixture.test',
    authorization: () => undefined,
    fetch: async (request) => {
      const path = new URL(request.url).pathname,
        body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body, url: request.url });
      const value = await handler(path, body, request);
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { scope, store, calls, session: createContentSharesSession({ scope, newCommandId: () => id(next++) }) };
}
const draft = { target, audience: { kind: 'public_metadata' as const } };
function noPersistence(scope: AccountScope, keys: readonly string[]) {
  expect(keys).toEqual([]);
  expect(scope.queryClient.getQueryCache().getAll()).toEqual([]);
}
describe('private ContentShares scope owner (authored fixtures)', () => {
  it('delivers the first token exactly once, never in state/cache/URL, and does not treat an ACK as active share state', async () => {
    const h = fixture();
    await h.session.create(draft);
    expect(h.session.getState()).toMatchObject({
      tokenAvailable: true,
      command: { status: 'accepted' },
      own: { status: 'idle' },
    });
    expect(JSON.stringify(h.session.getState())).not.toContain(token);
    await h.session.create(draft);
    expect(h.session.getState().failure).toBe('busy');
    expect(h.calls).toHaveLength(1);
    expect(h.session.takeToken()).toBe(token);
    expect(h.session.takeToken()).toBeUndefined();
    await h.session.readOwn({ kind: 'share', shareId: id(6) });
    expect(h.session.getState().own.status).toBe('ready');
    await h.session.revoke(id(6));
    expect(h.session.getState().command).toMatchObject({ status: 'accepted', operation: 'revoke' });
    expect(h.session.getState().own.status).toBe('idle');
    expect(h.calls.every((c) => !c.url.includes(token))).toBe(true);
    noPersistence(h.scope, h.store.keys());
    h.scope.end();
  });
  it('purges own authority before publication and abort reentry while preserving the other ready lane', async () => {
    const held = deferred<unknown>();
    let hold = false,
      aborted = false;
    let abortOwn: unknown, publishedOwn: unknown;
    const h = fixture((path, input, request) => {
      if (hold && path.endsWith('/resolve')) {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            abortOwn = h.session.getState().own;
            void h.session.revoke(id(6));
          },
          { once: true },
        );
        return held.promise;
      }
      return reply(path, input);
    });
    await h.session.readOwn({ kind: 'share', shareId: id(6) });
    await h.session.resolve(token);
    const currentCard = h.session.getState().resolved;
    hold = true;
    const old = h.session.resolve(token);
    await expect.poll(() => h.calls.filter((c) => c.path.endsWith('/resolve')).length).toBe(2);
    h.session.subscribe(() => {
      if (h.session.getState().own.status === 'loading' && publishedOwn === undefined) {
        publishedOwn = h.session.getState().own;
        void h.session.revoke(id(6));
      }
    });
    const next = h.session.readOwn({ kind: 'share', shareId: id(6) });
    expect(publishedOwn).toEqual({ status: 'loading' });
    expect(aborted).toBe(true);
    expect(abortOwn).toEqual({ status: 'loading' });
    expect(h.calls.some((c) => c.path.endsWith('/revoke'))).toBe(false);
    // The resolve refresh owns its loading state; no old card is resurrected by abort.
    expect(currentCard.status).toBe('ready');
    expect(h.session.getState().resolved.status).toBe('loading');
    held.open(reply('/v1/content-shares/resolve', h.calls.at(-1)!.body));
    await old;
    await next;
    expect(h.session.getState().own.status).toBe('ready');
    expect(h.session.getState().resolved.status).toBe('loading');
    noPersistence(h.scope, h.store.keys());
    h.scope.end();
  });
  it('keeps the opposite ready card during own recheck and fences reentrant scope end before dispatch', async () => {
    const h = fixture();
    await h.session.resolve(token);
    const card = h.session.getState().resolved;
    let observed: unknown;
    const before = h.calls.length;
    h.session.subscribe(() => {
      if (h.session.getState().own.status === 'loading') {
        observed = h.session.getState().resolved;
        h.scope.end();
      }
    });
    await h.session.readOwn({ kind: 'share', shareId: id(6) });
    expect(observed).toEqual(card);
    expect(h.calls).toHaveLength(before);
    expect(h.session.getState()).toMatchObject({
      status: 'ended',
      own: { status: 'idle' },
      resolved: { status: 'idle' },
    });
    noPersistence(h.scope, h.store.keys());
  });
  it('keeps opposite-lane preview bytes admitted until that lane is purged, then releases the actual shared budget', async () => {
    const h = fixture(),
      owner = socialOwnerFor(h.scope),
      probe = {};
    await h.session.resolve(token);
    await h.session.readOwn({ kind: 'share', shareId: id(6) });
    expect(h.session.getState().resolved.status).toBe('ready');
    // Direct owner-budget probe only: not a wire payload, message or simulated server proof.
    expect(owner.retain(probe, { text: 'x'.repeat(SOCIAL_LIMITS.bodyBytes) })).toBe(false);
    let admitted: boolean | undefined;
    h.session.subscribe(() => {
      if (h.session.getState().resolved.status === 'loading' && admitted === undefined) {
        admitted = owner.retain(probe, { text: 'x'.repeat(SOCIAL_LIMITS.bodyBytes) });
        owner.drop(probe);
      }
    });
    await h.session.resolve(token);
    expect(admitted).toBe(true);
    expect(owner.retain(probe, { text: 'x'.repeat(SOCIAL_LIMITS.bodyBytes) })).toBe(false);
    h.scope.end();
    expect(owner.live()).toBe(false);
    expect(owner.retain(probe, { text: 'after end' })).toBe(false);
    expect(h.session.getState()).toMatchObject({ status: 'ended', resolved: { status: 'idle' } });
  });
  it('keeps one original unknown command across controllers and later 4xx; status unavailable cannot prove not sent', async () => {
    let sent = 0,
      statusAvailable = false;
    const h = fixture((path, input) => {
      if (path.endsWith('/create')) {
        if (++sent === 1) throw new Error('SECRET_NETWORK');
        return new Response(JSON.stringify(problemDetails('FORBIDDEN')), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      if (path.endsWith('/read') && !statusAvailable)
        return { version, readId: input.readId, scope: scopeValue, status: 'unavailable', selector: input.selector };
      return reply(path, input);
    });
    await h.session.create(draft);
    const original = h.calls[0]!.body;
    expect(h.session.getState().command.status).toBe('unknown');
    const chat = createConversationsSession({ scope: h.scope, newCommandId: () => id(901) });
    await chat.start(id(902));
    expect(chat.getState().failure).toBe('busy');
    expect(h.calls).toHaveLength(1);
    await h.session.retryCommand();
    expect(h.calls[1]!.body).toEqual(original);
    expect(h.session.getState().command.status).toBe('unknown');
    await h.session.readOwn({ kind: 'command', commandId: original.commandId as string });
    expect(h.session.getState().command.status).toBe('unknown');
    statusAvailable = true;
    await h.session.readOwn({ kind: 'command', commandId: original.commandId as string });
    expect(h.session.getState().command.status).toBe('accepted');
    expect(h.session.getState().tokenAvailable).toBe(false);
    expect(h.session.takeToken()).toBeUndefined();
    expect(sent).toBe(2);
    h.scope.end();
    expect(h.session.getState()).toMatchObject({
      status: 'ended',
      own: { status: 'idle' },
      command: { status: 'idle' },
    });
  });
  it('never recreates a first token from replay or an own-share receipt', async () => {
    const h = fixture((path, input) =>
      path.endsWith('/create')
        ? {
            acceptance: { ...(reply(path, input) as { acceptance: object }).acceptance, replayed: true },
            delivery: { status: 'unavailable' },
          }
        : reply(path, input),
    );
    await h.session.create(draft);
    expect(h.session.takeToken()).toBeUndefined();
    await h.session.readOwn({ kind: 'share', shareId: id(6) });
    expect(h.session.takeToken()).toBeUndefined();
    expect(h.calls).toHaveLength(2);
    h.scope.end();
  });
  it('keeps the private resolver in JSON, returns neutral tombstones and never downgrades through public HTTP', async () => {
    let available = true;
    const h = fixture((path, input) =>
      path.endsWith('/resolve') && !available
        ? { version, readId: input.readId, status: 'unavailable' }
        : reply(path, input),
    );
    await h.session.resolve(token);
    expect(h.session.getState().resolved).toMatchObject({ status: 'ready', data: { status: 'public_metadata' } });
    available = false;
    await h.session.resolve(token);
    expect(h.session.getState().resolved).toMatchObject({ status: 'ready', data: { status: 'unavailable' } });
    expect(JSON.stringify(h.session.getState())).not.toContain('PUBLIC_CARD_CANARY');
    expect(JSON.stringify(h.session.getState())).not.toContain(token);
    expect(h.calls.map((c) => c.path)).toEqual([
      '/v1/social/content-shares/resolve',
      '/v1/social/content-shares/resolve',
    ]);
    expect(h.calls.every((c) => !c.url.includes(token))).toBe(true);
    noPersistence(h.scope, h.store.keys());
    h.scope.end();
  });
  it('requires a server-supplied live locator for a conversation audience instead of accepting a deep-link ref', async () => {
    const h = fixture((path, input) =>
      path.endsWith('/resolve')
        ? { version, readId: input.readId, scope: scopeValue, status: 'conversation', conversation: ref, content }
        : reply(path, input),
    );
    await h.session.create({ target, audience: { kind: 'conversation', conversation: ref } });
    expect(h.calls).toEqual([]);
    expect(h.session.getState().failure).toBe('refresh_required');
    await h.session.resolve(token);
    await h.session.create({ target, audience: { kind: 'conversation', conversation: ref } });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.body).toMatchObject({ audience: { kind: 'conversation', conversation: ref } });
    h.scope.end();
  });
  it('purges cards/token/unknown selectors synchronously, fences late fetch and publishes all owners already ended', async () => {
    const held = deferred<unknown>();
    let hold = false;
    const h = fixture((path, input) => (hold && path.endsWith('/resolve') ? held.promise : reply(path, input)));
    await h.session.create(draft);
    const chat = createConversationsSession({ scope: h.scope, newCommandId: () => id(900) });
    hold = true;
    const reading = h.session.resolve(token);
    await expect.poll(() => h.calls.length).toBe(2);
    let publications = 0,
      otherAtEnd: unknown,
      tokenAtEnd: string | undefined = 'not called';
    h.session.subscribe(() => {
      if (h.session.getState().status === 'ended') {
        publications++;
        otherAtEnd = chat.getState();
        tokenAtEnd = h.session.takeToken();
      }
    });
    h.scope.end();
    expect(publications).toBe(1);
    expect(otherAtEnd).toMatchObject({ status: 'ended', windows: [], drafts: [] });
    expect(tokenAtEnd).toBeUndefined();
    expect(h.session.getState()).toMatchObject({
      status: 'ended',
      own: { status: 'idle' },
      resolved: { status: 'idle' },
      tokenAvailable: false,
    });
    held.open(reply('/v1/social/content-shares/resolve', h.calls[1]!.body));
    await reading;
    expect(h.session.getState().resolved).toEqual({ status: 'idle' });
    const count = h.calls.length;
    await h.session.retryCommand();
    await h.session.resolve(token);
    expect(h.calls).toHaveLength(count);
    noPersistence(h.scope, h.store.keys());
  });
  it('bounds reads to one underlying plus one latest queued and never auto-retries', async () => {
    const held = deferred<unknown>();
    let number = 0;
    const h = fixture((path, input) => (++number === 1 ? held.promise : reply(path, input)));
    const a = h.session.resolve(token);
    await expect.poll(() => h.calls.length).toBe(1);
    const b = h.session.resolve(`kssh_${'b'.repeat(43)}`),
      c = h.session.resolve(`kssh_${'c'.repeat(43)}`);
    await b;
    expect(h.calls).toHaveLength(1);
    held.open(reply('/v1/social/content-shares/resolve', h.calls[0]!.body));
    await a;
    await c;
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.body.token).toBe(`kssh_${'c'.repeat(43)}`);
    h.scope.end();
  });
  it('keeps scope objects independent and clears a consumed token before a reentrant end subscriber', async () => {
    const a = fixture(),
      b = fixture();
    expect(a.session).not.toBe(b.session);
    expect(createContentSharesSession({ scope: a.scope, newCommandId: () => id(900) })).toBe(a.session);
    await a.session.create(draft);
    a.session.subscribe(() => {
      if (!a.session.getState().tokenAvailable) a.scope.end();
    });
    expect(a.session.takeToken()).toBeUndefined();
    expect(a.session.getState().status).toBe('ended');
    expect(b.session.getState().status).toBe('active');
    b.scope.end();
  });
});
