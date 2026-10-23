import { describe, expect, it } from 'vitest';
import { createAccountScope, memoryStore } from './account-scope';
import { createContentSharesHttp } from './content-shares-http';
import type { ShareInput, ShareOperation } from './conversations-types';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'share@fixture.test' },
  scopeValue = { accountId: id(1), privacyEpoch: 1 };
const target = { assetId: id(3), assetRevision: 1 },
  token = `kssh_${'s'.repeat(43)}`,
  version = 'content-share.v1';
const acceptance = {
  version,
  scope: scopeValue,
  commandId: id(4),
  operation: 'content-share.create',
  shareId: id(5),
  target,
  audience: { kind: 'public_metadata' },
  outcome: 'accepted',
  replayed: false,
  recordedAt: '2026-10-23T00:00:00.000Z',
  expiresAt: '2026-10-24T00:00:00.000Z',
};
function fixture(reply: unknown) {
  const calls: { path: string; body: unknown }[] = [],
    store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    baseUrl: 'https://share.fixture.test',
    authorization: () => undefined,
    fetch: async (request) => {
      calls.push({ path: new URL(request.url).pathname, body: await request.json() });
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { scope, calls, store, http: createContentSharesHttp(scope) };
}
const cases: { operation: ShareOperation; route: string; input: unknown; output: unknown }[] = [
  {
    operation: 'create',
    route: 'create',
    input: { version, commandId: id(4), target, audience: { kind: 'public_metadata' } },
    output: { acceptance, delivery: { status: 'available', token } },
  },
  {
    operation: 'revoke',
    route: 'revoke',
    input: { version, commandId: id(4), shareId: id(5) },
    output: {
      version,
      scope: scopeValue,
      commandId: id(4),
      operation: 'content-share.revoke',
      shareId: id(5),
      outcome: 'accepted',
      replayed: false,
      recordedAt: acceptance.recordedAt,
    },
  },
  {
    operation: 'own',
    route: 'read',
    input: { version, readId: id(6), selector: { kind: 'share', shareId: id(5) } },
    output: {
      version,
      readId: id(6),
      scope: scopeValue,
      status: 'available',
      selector: { kind: 'share', shareId: id(5) },
      shareId: id(5),
      target,
      audience: { kind: 'public_metadata' },
      state: 'active',
      expiresAt: acceptance.expiresAt,
    },
  },
  {
    operation: 'resolve',
    route: 'resolve',
    input: { version, readId: id(6), token },
    output: {
      version,
      readId: id(6),
      status: 'public_metadata',
      content: {
        status: 'available',
        target,
        metadata: { kind: 'reel', title: 'Authored public card', summary: 'No private conversation', language: 'en' },
      },
    },
  },
];
describe('Content share strict private HTTP (authored fixtures)', () => {
  it.each(cases)(
    'calls exact private $operation with token only in sensitive JSON',
    async ({ operation, route, input, output }) => {
      const h = fixture(output);
      expect(await h.http.call(operation, input as ShareInput<typeof operation>)).toEqual(output);
      expect(h.calls).toEqual([{ path: `/v1/social/content-shares/${route}`, body: input }]);
      expect(h.calls[0]!.path).not.toContain(token);
      expect(h.store.keys()).toEqual([]);
      expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
      h.scope.end();
    },
  );
  it.each(['scope', 'command', 'target', 'audience', 'replayToken'] as const)(
    'refuses wrong %s creation delivery',
    async (field) => {
      const value = structuredClone(cases[0]!.output) as { acceptance: Record<string, unknown>; delivery: unknown };
      if (field === 'scope') value.acceptance.scope = { ...scopeValue, accountId: id(99) };
      if (field === 'command') value.acceptance.commandId = id(99);
      if (field === 'target') value.acceptance.target = { ...target, assetRevision: 2 };
      if (field === 'audience')
        value.acceptance.audience = {
          kind: 'conversation',
          conversation: { conversationId: id(7), membershipId: id(8), membershipRevision: 1 },
        };
      if (field === 'replayToken') value.acceptance.replayed = true;
      const h = fixture(value);
      await expect(h.http.call('create', cases[0]!.input as ShareInput<'create'>)).rejects.toMatchObject({
        reason: 'invalid',
        ambiguous: true,
      });
      h.scope.end();
    },
  );
  it('rejects own selector, readID and forbidden private expansion rather than fallback', async () => {
    for (const output of [
      { ...(cases[2]!.output as object), readId: id(99) },
      { ...(cases[2]!.output as object), selector: { kind: 'command', commandId: id(4) } },
      { ...(cases[3]!.output as object), privateBody: 'PRIVATE_CANARY' },
    ]) {
      const h = fixture(output),
        index = 'privateBody' in output ? 3 : 2;
      await expect(
        h.http.call(cases[index]!.operation, cases[index]!.input as ShareInput<ShareOperation>),
      ).rejects.toMatchObject({ reason: 'invalid' });
      expect(h.calls).toHaveLength(1);
      h.scope.end();
    }
  });
  it('rejects a secret getter before invoking it or sending anything', async () => {
    const h = fixture(cases[3]!.output);
    let count = 0;
    const input = Object.defineProperty({ version, readId: id(6) }, 'token', {
      enumerable: true,
      get() {
        count++;
        return token;
      },
    });
    await expect(h.http.call('resolve', input as ShareInput<'resolve'>)).rejects.toMatchObject({
      reason: 'invalid',
      ambiguous: false,
    });
    expect(count).toBe(0);
    expect(h.calls).toEqual([]);
    h.scope.end();
  });
});
