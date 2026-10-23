import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { createConversationsHttp } from './conversations-http';
import type { ConversationInput, ConversationOperation } from './conversations-types';
// Authored protocol fixtures through the actual scope API, not real messages or memberships.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'conversations@fixture.test' };
const scopeValue = { accountId: account.accountId, privacyEpoch: 1 }, ref = { conversationId: id(3), membershipId: id(4), membershipRevision: 2 };
const peer = { kind: 'person', personId: id(5), handle: 'fixture.peer', displayName: 'Fixture peer' };
const own = { readThroughSequence: 0, muted: false }, message = { status: 'available', messageId: id(6), sequence: 1, author: peer, recordedAt: '2026-10-23T00:00:00.000Z', body: { kind: 'text', text: 'Authored private canary' } };
const hcur = `kch1_${'h'.repeat(43)}`, ccur = `kcc1_${'c'.repeat(43)}`, icur = `kci1_${'i'.repeat(43)}`;
const envelope = { version: 'direct-conversation.v1', scope: scopeValue }, read = { version: 'direct-conversation.v1', readId: id(7) }, cmd = { version: 'direct-conversation.v1', commandId: id(8) };
const receipt = { ...envelope, commandId: id(8), recordedAt: message.recordedAt, replayed: false, outcome: 'accepted' };
function fixture(handler: (path: string, input: Record<string, unknown>) => unknown) {
  const store = memoryStore(), calls: { path: string; method: string; body: unknown; claim: string | null }[] = [];
  const scope = createAccountScope({ account, store, authorization: () => undefined, baseUrl: 'https://conversation.fixture.test', fetch: async (request) => { const body = await request.json() as Record<string, unknown>; calls.push({ path: new URL(request.url).pathname, method: request.method, body, claim: request.headers.get('X-KS-Scope') }); const result = await handler(new URL(request.url).pathname, body); return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }); } });
  return { scope, store, calls, http: createConversationsHttp(scope) };
}
const cases: { operation: ConversationOperation; input: unknown; output: unknown; route: string }[] = [
  { operation: 'start', route: 'start', input: { ...cmd, peerPersonId: peer.personId, expectedPairRevision: 3 }, output: { ...receipt, operation: 'conversation.start', conversation: ref, peerPersonId: peer.personId } },
  { operation: 'inbox', route: 'inbox', input: { ...read, limit: 50 }, output: { ...envelope, readId: id(7), status: 'ready', limit: 50, viewRevision: 1, items: [{ conversation: ref, peer, latestMessageSequence: 1, own, lastMessage: message }], continuation: { kind: 'end' } } },
  { operation: 'read', route: 'read', input: { ...read, conversation: ref, limit: 50 }, output: { ...envelope, readId: id(7), status: 'ready', conversation: ref, peer, own, latestMessageSequence: 1, messages: [message], limit: 50, history: { kind: 'more', cursor: hcur }, catchUpCursor: ccur } },
  { operation: 'history', route: 'history', input: { ...read, conversation: ref, limit: 50, cursor: hcur }, output: { ...envelope, readId: id(7), status: 'ready', conversation: ref, limit: 50, requestCursor: hcur, messages: [message], continuation: { kind: 'end' } } },
  { operation: 'changes', route: 'changes', input: { ...read, conversation: ref, limit: 50, cursor: ccur }, output: { ...envelope, readId: id(7), status: 'ready', conversation: ref, limit: 50, requestCursor: ccur, fromChangeSequence: 1, throughChangeSequence: 2, changes: [{ changeSequence: 2, message: { status: 'unavailable', messageId: id(6), sequence: 1 } }], continuation: { kind: 'caught_up', cursor: `kcc1_${'d'.repeat(43)}` } } },
  { operation: 'send', route: 'send', input: { ...cmd, conversation: ref, body: { kind: 'text', text: 'Authored private canary' } }, output: { ...receipt, operation: 'message.send', conversation: ref, messageId: id(6), messageSequence: 1, sent: { kind: 'text' } } },
  { operation: 'readOwnSend', route: 'send/read', input: { ...read, conversation: ref, selector: { kind: 'command', commandId: id(8) } }, output: { ...envelope, readId: id(7), status: 'accepted', conversation: ref, selector: { kind: 'command', commandId: id(8) }, messageId: id(6), messageSequence: 1, recordedAt: message.recordedAt, sent: { kind: 'text' } } },
  { operation: 'markRead', route: 'mark-read', input: { ...cmd, conversation: ref, throughSequence: 1 }, output: { ...receipt, operation: 'conversation.read', conversation: ref, requestedThroughSequence: 1, acceptedThroughSequence: 1 } },
  { operation: 'mute', route: 'mute', input: { ...cmd, conversation: ref, muted: true }, output: { ...receipt, operation: 'conversation.mute', conversation: ref, muted: true } },
  { operation: 'leave', route: 'leave', input: { ...cmd, conversation: ref }, output: { ...receipt, operation: 'conversation.leave', conversation: ref } },
];
describe('Conversations strict actual HTTP boundary (authored fixtures)', () => {
  it.each(cases)('binds all ten real methods: $operation', async ({ operation, route, input, output }) => {
    const h = fixture(() => output);
    expect(await h.http.call(operation, input as ConversationInput<typeof operation>)).toEqual(output);
    expect(h.calls).toEqual([{ path: `/v1/social/conversations/${route}`, method: 'POST', body: input, claim: `${account.accountId}:1` }]);
    expect(h.store.keys()).toEqual([]); expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]); h.scope.end();
  });
  it.each(['scope', 'epoch', 'readId', 'ref', 'limit', 'cursor'] as const)('rejects valid-looking wrong %s current replies', async (kind) => {
    const sample = cases[3]!, output = structuredClone(sample.output) as Record<string, unknown>;
    if (kind === 'scope') output.scope = { accountId: id(99), privacyEpoch: 1 };
    if (kind === 'epoch') output.scope = { ...scopeValue, privacyEpoch: 2 };
    if (kind === 'readId') output.readId = id(99);
    if (kind === 'ref') output.conversation = { ...ref, membershipRevision: 3 };
    if (kind === 'limit') output.limit = 49;
    if (kind === 'cursor') output.requestCursor = `kch1_${'z'.repeat(43)}`;
    const h = fixture(() => output); await expect(h.http.call('history', sample.input as ConversationInput<'history'>)).rejects.toMatchObject({ reason: 'invalid', ambiguous: true }); h.scope.end();
  });
  it('requires own-send selector/current ref and preserves body-free recovery even after a tombstone', async () => {
    const sample = cases[6]!, output = structuredClone(sample.output) as Record<string, unknown>;
    const h = fixture(() => ({ ...output, selector: { kind: 'command', commandId: id(99) } }));
    await expect(h.http.call('readOwnSend', sample.input as ConversationInput<'readOwnSend'>)).rejects.toMatchObject({ reason: 'invalid' }); h.scope.end();
    const valid = fixture(() => sample.output); const recovered = await valid.http.call('readOwnSend', sample.input as ConversationInput<'readOwnSend'>);
    expect(JSON.stringify(recovered)).not.toContain('Authored private canary'); expect(JSON.stringify(recovered)).not.toContain('body'); valid.scope.end();
  });
  it('refuses unknown fields, undefined, cycles and accessors without evaluating private canaries', async () => {
    const h = fixture(() => cases[5]!.output), input = cases[5]!.input as ConversationInput<'send'>; let reads = 0;
    const accessor = Object.defineProperty({ ...input }, 'body', { enumerable: true, get() { reads++; throw new Error('CANARY'); } });
    for (const body of [accessor, { ...input, extra: 'CANARY' }, { ...input, unknown: undefined }]) await expect(h.http.call('send', body as ConversationInput<'send'>)).rejects.toMatchObject({ reason: 'invalid', ambiguous: false });
    expect(reads).toBe(0); expect(h.calls).toEqual([]); h.scope.end();
  });
  it('does not leak error details, downgrade private transport or retry network failures', async () => {
    const h = fixture(() => { throw new Error('PRIVATE_BODY_OR_TOKEN'); });
    const e = await h.http.call('send', cases[5]!.input as ConversationInput<'send'>).catch((error: unknown) => error);
    expect(e).toMatchObject({ ambiguous: true, reason: 'network' }); expect(String(e)).not.toContain('PRIVATE'); expect(h.calls).toHaveLength(1); h.scope.end();
    const refused = fixture(() => new Response(JSON.stringify(problemDetails('FORBIDDEN')), { status: 403, headers: { 'content-type': 'application/problem+json' } }));
    await expect(refused.http.call('inbox', { ...read, version: 'direct-conversation.v1', limit: 50, cursor: icur })).rejects.toMatchObject({ reason: 'authority', ambiguous: false }); expect(refused.calls).toHaveLength(1); refused.scope.end();
  });
  it('compares UUID references semantically and rejects case-only duplicate message identities', async () => {
    const sample = cases[2]!, value = structuredClone(sample.output) as Record<string, unknown>;
    value.conversation = { ...ref, conversationId: ref.conversationId.toUpperCase() };
    const h = fixture(() => value); await expect(h.http.call('read', sample.input as ConversationInput<'read'>)).resolves.toMatchObject({ status: 'ready' });
    value.messages = [message, { ...message, messageId: message.messageId.toUpperCase(), sequence: 2 }]; value.latestMessageSequence = 2;
    await expect(h.http.call('read', sample.input as ConversationInput<'read'>)).rejects.toMatchObject({ reason: 'invalid' }); h.scope.end();
  });
});
