import { describe, expect, it } from 'vitest';
import {
  ConversationReactionAcceptanceSchema,
  MESSAGE_REACTION_KINDS,
  ReactToConversationMessageSchema,
  StartDirectConversationSchema,
  SendConversationMessageSchema,
  ConversationMessageSchema,
  ConversationChangesPageSchema,
  ConversationHistoryPageSchema,
  DirectConversationSnapshotSchema,
  ConversationInboxSchema,
  ConversationContentProjectionSchema,
  ConversationMessageAcceptanceSchema,
  ConversationReadAcceptanceSchema,
  ConversationTextSchema,
  ReadConversationChangesSchema,
  ReadConversationHistorySchema,
  ReadConversationInboxSchema,
  MarkConversationReadSchema,
  ReadOwnConversationSendSchema,
  OwnConversationSendSchema,
  ownConversationSendForRead,
} from './conversations.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { accountId: id(1), privacyEpoch: 2 };
const conversation = { conversationId: id(2), membershipId: id(3), membershipRevision: 1 };
const version = 'direct-conversation.v1';
const read = { version, readId: id(4), scope };
const person = { kind: 'person', personId: id(5), handle: 'friend.a', displayName: '友人' };
const target = { assetId: id(6), assetRevision: 7 };
const metadata = { kind: 'scroll', title: 'An exact explanation', summary: 'Consumer metadata', language: 'en' };
const cursor = (prefix: string, value = 'a') => `${prefix}_${value.repeat(43)}`;
const message = (sequence: number) => ({
  status: 'available',
  messageId: id(sequence + 20),
  sequence,
  author: person,
  recordedAt: '2026-10-22T00:00:00.000Z',
  body: { kind: 'text', text: 'An actual message fixture' },
});
const changes = () => ({
  ...read,
  status: 'ready',
  conversation,
  limit: 2,
  requestCursor: cursor('kcc1'),
  fromChangeSequence: 5,
  throughChangeSequence: 9,
  changes: [
    { changeSequence: 6, message: message(2) },
    { changeSequence: 9, message: { status: 'unavailable', messageId: id(21), sequence: 1 } },
  ],
  continuation: { kind: 'caught_up', cursor: cursor('kcc1', 'b') },
});

describe('direct conversation wire prerequisite (authored fixtures, no social runtime)', () => {
  it('allows one deliberate selected human friend, never a group, invitation or private account binding', () => {
    const command = { version, commandId: id(7), peerPersonId: person.personId, expectedPairRevision: 1 };
    expect(StartDirectConversationSchema.parse(command)).toEqual(command);
    for (const extra of [{ members: [id(8)] }, { accountId: id(8) }, { invite: id(8) }, { aiRole: 'moderator' }])
      expect(StartDirectConversationSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    expect(StartDirectConversationSchema.safeParse({ ...command, expectedPairRevision: 0 }).success).toBe(false);
  });
  it('keeps text and exact full-content sends disjoint and refuses locators, state and private inference', () => {
    const base = { version, commandId: id(7), conversation };
    const command = { ...base, body: { kind: 'content', target, note: 'A note\nwith a second line' } };
    expect(SendConversationMessageSchema.parse(command)).toEqual(command);
    expect(SendConversationMessageSchema.safeParse({ ...base, body: { kind: 'text', text: 'Hello' } }).success).toBe(
      true,
    );
    for (const field of [
      'playheadMs',
      'seen',
      'currentBranch',
      'interests',
      'exposureId',
      'threadId',
      'blockState',
      'startMs',
    ]) {
      expect(SendConversationMessageSchema.safeParse({ ...command, [field]: 1 }).success).toBe(false);
      expect(
        SendConversationMessageSchema.safeParse({ ...command, body: { ...command.body, [field]: 1 } }).success,
      ).toBe(false);
      expect(
        SendConversationMessageSchema.safeParse({
          ...command,
          body: { ...command.body, target: { ...target, [field]: 1 } },
        }).success,
      ).toBe(false);
    }
    expect(
      SendConversationMessageSchema.safeParse({
        ...command,
        body: { kind: 'content', target: { assetId: target.assetId } },
      }).success,
    ).toBe(false);
  });
  it('retains literal untrusted Unicode text without transforms and bounds controls/length', () => {
    expect(ConversationTextSchema.parse('友人\nHello\tworld')).toBe('友人\nHello\tworld');
    for (const text of ['', ' leading', 'trailing ', 'x'.repeat(2001), 'x\u0000y', 'x\u0085y'])
      expect(ConversationTextSchema.safeParse(text).success).toBe(false);
    expect(ConversationTextSchema.safeParse('x'.repeat(2000)).success).toBe(true);
  });
  it('retains exact old target and makes correction explicit instead of replacing it', () => {
    expect(ConversationContentProjectionSchema.safeParse({ status: 'available', target, metadata }).success).toBe(true);
    const corrected = { status: 'corrected', target, current: { ...target, assetRevision: 8, metadata } };
    expect(ConversationContentProjectionSchema.parse(corrected)).toEqual(corrected);
    expect(
      ConversationContentProjectionSchema.safeParse({ ...corrected, current: { ...target, metadata } }).success,
    ).toBe(false);
    expect(
      ConversationContentProjectionSchema.safeParse({ ...corrected, current: { ...target, assetId: id(99), metadata } })
        .success,
    ).toBe(false);
    expect(ConversationContentProjectionSchema.safeParse({ status: 'unavailable', target, metadata }).success).toBe(
      false,
    );
  });
  it('orders visible changes independently of original message order and allows neutral redaction only', () => {
    expect(ConversationChangesPageSchema.parse(changes())).toEqual(changes());
    expect(
      ConversationChangesPageSchema.safeParse({
        ...changes(),
        throughChangeSequence: 10,
        continuation: { kind: 'more', cursor: cursor('kcc1', 'b') },
      }).success,
    ).toBe(true);
    const tombstone = { status: 'unavailable', messageId: id(21), sequence: 1 };
    expect(ConversationMessageSchema.parse(tombstone)).toEqual(tombstone);
    for (const extra of [{ author: person }, { text: 'erased private body' }, { reason: 'blocked' }, { seen: true }])
      expect(ConversationMessageSchema.safeParse({ ...tombstone, ...extra }).success).toBe(false);
    expect(
      ConversationMessageSchema.safeParse({ ...message(1), author: { kind: 'ai', name: 'pretend friend' } }).success,
    ).toBe(false);
  });
  it('refuses duplicate/regressive/out-of-window change positions, future bubbles, loops and unbounded pages', () => {
    const page = changes();
    for (const changed of [
      { ...page, changes: [...page.changes].reverse() },
      { ...page, changes: [page.changes[0], page.changes[0]] },
      { ...page, fromChangeSequence: 9 },
      { ...page, throughChangeSequence: 5 },
      { ...page, throughChangeSequence: 10 },
      {
        ...page,
        changes: [
          { changeSequence: 6, message: message(1) },
          { changeSequence: 9, message: { ...message(2), messageId: message(1).messageId } },
        ],
      },
      {
        ...page,
        changes: [
          { changeSequence: 6, message: message(1) },
          { changeSequence: 9, message: { ...message(2), sequence: 1 } },
        ],
      },
      { ...page, changes: [{ changeSequence: 6, message: message(7) }] },
      { ...page, limit: 1 },
      { ...page, continuation: { kind: 'more', cursor: page.requestCursor } },
      { ...page, changes: [], continuation: { kind: 'more', cursor: cursor('kcc1', 'b') } },
      { ...page, changes: Array(51).fill(page.changes[0]) },
      { ...page, changes: [{ changeSequence: 6, kind: 'peer.read', personId: person.personId }] },
    ])
      expect(ConversationChangesPageSchema.safeParse(changed).success).toBe(false);
    expect(
      ConversationChangesPageSchema.safeParse({
        ...page,
        changes: [],
        fromChangeSequence: 9,
        continuation: { kind: 'caught_up', cursor: page.requestCursor },
      }).success,
    ).toBe(true);
  });
  it('binds separate opaque cursor purposes and keeps all private read selectors in JSON', () => {
    const body = { version, readId: id(4), conversation, limit: 50, cursor: cursor('kcc1') };
    expect(ReadConversationChangesSchema.parse(body)).toEqual(body);
    expect(ReadConversationHistorySchema.safeParse(body).success).toBe(false);
    expect(
      ReadConversationInboxSchema.safeParse({ version, readId: id(4), limit: 1, cursor: cursor('kch1') }).success,
    ).toBe(false);
    for (const limit of [0, 51, 1.5, '20'])
      expect(ReadConversationChangesSchema.safeParse({ ...body, limit }).success).toBe(false);
    for (const token of ['decoded-private-anchor', cursor('kcc1') + '=', 'kcc1_' + 'a'.repeat(1025)])
      expect(ReadConversationChangesSchema.safeParse({ ...body, cursor: token }).success).toBe(false);
    expect(
      ConversationChangesPageSchema.safeParse({ ...read, status: 'refresh_required', requestCursor: cursor('kcc1') })
        .success,
    ).toBe(true);
  });
  it('requires unique ascending history bubbles and bounded current snapshot read cursors', () => {
    const page = {
      ...read,
      status: 'ready',
      conversation,
      limit: 2,
      requestCursor: cursor('kch1'),
      messages: [message(1), message(2)],
      continuation: { kind: 'end' },
    };
    expect(ConversationHistoryPageSchema.safeParse(page).success).toBe(true);
    for (const messages of [
      [message(2), message(1)],
      [message(1), message(1)],
    ])
      expect(ConversationHistoryPageSchema.safeParse({ ...page, messages }).success).toBe(false);
    const snapshot = {
      ...read,
      status: 'ready',
      conversation,
      peer: person,
      own: { readThroughSequence: 2, muted: false },
      latestMessageSequence: 2,
      messages: [message(1), message(2)],
      limit: 2,
      history: { kind: 'end' },
      catchUpCursor: cursor('kcc1'),
    };
    expect(DirectConversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      DirectConversationSnapshotSchema.safeParse({ ...snapshot, own: { readThroughSequence: 3, muted: false } })
        .success,
    ).toBe(false);
    expect(DirectConversationSnapshotSchema.safeParse({ ...snapshot, latestMessageSequence: 1 }).success).toBe(false);
    expect(DirectConversationSnapshotSchema.safeParse({ ...read, status: 'unavailable', peer: person }).success).toBe(
      false,
    );
  });
  it('carries SEEN as a position the other person has read to, never a time, a name or a flag', () => {
    const snapshot = {
      ...read,
      status: 'ready',
      conversation,
      peer: person,
      own: { readThroughSequence: 2, muted: false },
      latestMessageSequence: 2,
      messages: [message(1), message(2)],
      limit: 2,
      history: { kind: 'end' },
      catchUpCursor: cursor('kcc1'),
    };
    expect(DirectConversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    for (const throughSequence of [0, 1, 2])
      expect(DirectConversationSnapshotSchema.safeParse({ ...snapshot, peerRead: { throughSequence } }).success).toBe(
        true,
      );
    for (const peerRead of [
      { throughSequence: 3 },
      { throughSequence: -1 },
      { throughSequence: 1, readAt: '2026-10-22T00:00:00.000Z' },
      { throughSequence: 1, shared: true },
      {},
    ])
      expect(DirectConversationSnapshotSchema.safeParse({ ...snapshot, peerRead }).success).toBe(false);
    const page = changes();
    expect(ConversationChangesPageSchema.safeParse({ ...page, peerRead: { throughSequence: 9 } }).success).toBe(true);
    expect(ConversationChangesPageSchema.safeParse({ ...page, peerRead: { throughSequence: 10 } }).success).toBe(false);
    expect(
      ConversationChangesPageSchema.safeParse({ ...page, peerRead: { throughSequence: 1, typing: true } }).success,
    ).toBe(false);
  });
  it('includes the latest committed bubble before handing off to catch-up, with bounded older history', () => {
    const snapshot = {
      ...read,
      status: 'ready',
      conversation,
      peer: person,
      own: { readThroughSequence: 0, muted: false },
      latestMessageSequence: 0,
      messages: [],
      limit: 2,
      history: { kind: 'end' },
      catchUpCursor: cursor('kcc1'),
    };
    expect(DirectConversationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const changed of [
      { ...snapshot, messages: [message(1)] },
      { ...snapshot, latestMessageSequence: 1 },
      { ...snapshot, latestMessageSequence: 2, messages: [message(1)] },
      { ...snapshot, latestMessageSequence: 3, messages: [message(1), message(2)] },
    ])
      expect(DirectConversationSnapshotSchema.safeParse(changed).success).toBe(false);
    const recent = {
      ...snapshot,
      latestMessageSequence: 50,
      messages: [message(49), message(50)],
      history: { kind: 'more', cursor: cursor('kch1') },
    };
    expect(DirectConversationSnapshotSchema.parse(recent)).toEqual(recent);
    const redactedLatest = {
      ...recent,
      messages: [message(49), { status: 'unavailable', messageId: id(70), sequence: 50 }],
    };
    expect(DirectConversationSnapshotSchema.parse(redactedLatest)).toEqual(redactedLatest);
  });
  it('does not invent inbox rows, last-message state or peer seen/presence information', () => {
    const row = {
      conversation,
      peer: person,
      latestMessageSequence: 2,
      own: { readThroughSequence: 1, muted: true },
      lastMessage: message(2),
    };
    const page = { ...read, status: 'ready', viewRevision: 1, limit: 1, items: [row], continuation: { kind: 'end' } };
    expect(ConversationInboxSchema.safeParse(page).success).toBe(true);
    for (const changed of [
      { ...page, items: [row, row] },
      { ...page, items: [{ ...row, lastMessage: message(1) }] },
      { ...page, items: [{ ...row, peerReadSequence: 1 }] },
      { ...page, items: [{ ...row, online: true }] },
    ])
      expect(ConversationInboxSchema.safeParse(changed).success).toBe(false);
    expect(ConversationInboxSchema.safeParse({ ...page, items: [] }).success).toBe(true);
  });
  it('keeps a historical acceptance separate from current resource access and original retry body', () => {
    const command = {
      version,
      commandId: id(7),
      conversation,
      body: { kind: 'content', target, note: 'Original exact note' },
    };
    const receipt = {
      version,
      scope,
      commandId: id(7),
      conversation,
      operation: 'message.send',
      recordedAt: '2026-10-22T00:00:00.000Z',
      replayed: true,
      outcome: 'accepted',
      messageId: id(21),
      messageSequence: 1,
      sent: { kind: 'content', target },
    };
    expect(SendConversationMessageSchema.parse(command)).toEqual(command);
    expect(ConversationMessageAcceptanceSchema.parse(receipt)).toEqual(receipt);
    for (const extra of [
      { currentAccess: true },
      { body: command.body },
      { delivered: true },
      { seenBy: [person.personId] },
    ])
      expect(ConversationMessageAcceptanceSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
    expect(DirectConversationSnapshotSchema.safeParse({ ...read, status: 'unavailable' }).success).toBe(true);
    const readReceipt = {
      version,
      scope,
      commandId: id(8),
      conversation,
      operation: 'conversation.read',
      recordedAt: receipt.recordedAt,
      replayed: false,
      outcome: 'accepted',
      requestedThroughSequence: 2,
      acceptedThroughSequence: 2,
    };
    expect(ConversationReadAcceptanceSchema.safeParse(readReceipt).success).toBe(true);
    expect(ConversationReadAcceptanceSchema.safeParse({ ...readReceipt, acceptedThroughSequence: 1 }).success).toBe(
      false,
    );
    expect(
      MarkConversationReadSchema.safeParse({
        version,
        commandId: id(7),
        conversation,
        throughSequence: 2,
        peerPersonId: id(5),
      }).success,
    ).toBe(false);
  });
});

describe('current own-send identity lookup (#242; contract fixtures only)', () => {
  const selector = { kind: 'command', commandId: id(7) };
  const request = { version, readId: id(40), conversation, selector };
  const accepted = {
    ...request,
    scope,
    status: 'accepted',
    messageId: id(41),
    messageSequence: 1,
    recordedAt: '2026-10-22T00:00:00.000Z',
    sent: { kind: 'text' },
  };
  it('uses a fresh read and current participation with an immutable, body-free sent identity', () => {
    const pending = {
      version,
      commandId: selector.commandId,
      conversation,
      body: { kind: 'text', text: 'PRIVATE_MESSAGE_CANARY' },
    };
    const original = JSON.stringify(pending);
    expect(SendConversationMessageSchema.parse(pending)).toEqual(pending);
    expect(ReadOwnConversationSendSchema.parse(request)).toEqual(request);
    expect(OwnConversationSendSchema.parse(accepted)).toEqual(accepted);
    expect(OwnConversationSendSchema.parse({ ...accepted, sent: { kind: 'content', target } })).toEqual({
      ...accepted,
      sent: { kind: 'content', target },
    });
    const serialised = JSON.stringify(OwnConversationSendSchema.parse(accepted));
    expect(serialised).not.toContain('PRIVATE_MESSAGE_CANARY');
    expect(serialised).toContain('"kind":"text"');
    // The text discriminator is public identity metadata; private property names remain forbidden.
    for (const field of ['body', 'text', 'note', 'replayed', 'operation', 'outcome', 'token'])
      expect(serialised).not.toContain(`"${field}":`);
    expect(JSON.stringify(pending)).toBe(original);
  });
  it('keeps unavailable ambiguous, without reauthorisation, resend flags or historical epoch receipts', () => {
    const unavailable = { version, readId: request.readId, scope, selector, status: 'unavailable' };
    expect(OwnConversationSendSchema.parse(unavailable)).toEqual(unavailable);
    for (const extra of [
      { notSent: true },
      { reason: 'never_recorded' },
      { conversation },
      { sent: { kind: 'text' } },
      { executeAgain: true },
      { replayed: true },
    ])
      expect(OwnConversationSendSchema.safeParse({ ...unavailable, ...extra }).success).toBe(false);
    for (const status of ['not_sent', 'unknown', 'revoked', 'not_recorded'])
      expect(OwnConversationSendSchema.safeParse({ ...unavailable, status }).success).toBe(false);
    for (const extra of [
      { scope },
      { body: { kind: 'text', text: 'PRIVATE_MESSAGE_CANARY' } },
      { commandId: selector.commandId },
      { recordingGeneration: 3 },
    ])
      expect(ReadOwnConversationSendSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(
      ReadOwnConversationSendSchema.safeParse({ ...request, selector: { kind: 'message', messageId: id(41) } }).success,
    ).toBe(false);
    // Syntax cannot compare separate messages. The consumer must match all initiating echoes,
    // current scope and current DirectRef after waiting, before accepting this result.
    expect(OwnConversationSendSchema.safeParse({ ...accepted, readId: id(42) }).success).toBe(true);
    expect(accepted.readId).toBe(request.readId);
    expect(accepted.selector).toEqual(request.selector);
    expect(accepted.conversation).toEqual(request.conversation);
  });
  it('refuses private extras, coerced identities and unbounded/invalid counters without stripping them', () => {
    for (const extra of [
      { body: { text: 'PRIVATE_MESSAGE_CANARY' } },
      { note: 'PRIVATE_NOTE_CANARY' },
      { token: 'PRIVATE_TOKEN_CANARY' },
      { currentGeneration: 3 },
    ])
      expect(OwnConversationSendSchema.safeParse({ ...accepted, ...extra }).success).toBe(false);
    for (const messageSequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
      expect(OwnConversationSendSchema.safeParse({ ...accepted, messageSequence }).success).toBe(false);
    expect(
      ReadOwnConversationSendSchema.safeParse({
        ...request,
        conversation: { ...conversation, membershipRevision: '1' },
      }).success,
    ).toBe(false);
    expect(
      ReadOwnConversationSendSchema.safeParse({ ...request, selector: { ...selector, commandId: undefined } }).success,
    ).toBe(false);
  });
  it('rejects nested getters and non-JSON data before evaluating or defaulting any received value', () => {
    let calls = 0;
    const selectorAccessor = Object.defineProperty({ kind: 'command' }, 'commandId', {
      enumerable: true,
      get: () => {
        calls++;
        return selector.commandId;
      },
    });
    expect(ReadOwnConversationSendSchema.safeParse({ ...request, selector: selectorAccessor }).success).toBe(false);
    const scopeAccessor = Object.defineProperty({ accountId: scope.accountId }, 'privacyEpoch', {
      enumerable: true,
      get: () => {
        calls++;
        return 2;
      },
    });
    expect(OwnConversationSendSchema.safeParse({ ...accepted, scope: scopeAccessor }).success).toBe(false);
    expect(calls).toBe(0);
    const symbolic = { ...request, [Symbol('PRIVATE_KEY_CANARY')]: true };
    const hidden = Object.defineProperty({ ...request }, 'PRIVATE_KEY_CANARY', { value: true, enumerable: false });
    const inherited: unknown = Object.assign(Object.create({ private: true }) as object, request);
    const cyclic: Record<string, unknown> = { ...request };
    cyclic['self'] = cyclic;
    for (const value of [
      symbolic,
      hidden,
      inherited,
      cyclic,
      { ...request, ignored: undefined },
      { ...request, ignored: Infinity },
    ])
      expect(ReadOwnConversationSendSchema.safeParse(value).success).toBe(false);
  });
});

it('correlates own-send identity with every current request/scope/incarnation field without granting authority', () => {
  const selector = { kind: 'command', commandId: id(70) };
  const request = { version, readId: id(71), conversation, selector };
  const result = {
    ...request,
    scope,
    status: 'accepted',
    messageId: id(72),
    messageSequence: 1,
    recordedAt: '2026-10-22T00:00:00.000Z',
    sent: { kind: 'text' },
  };
  const current = { scope, conversation };
  expect(ownConversationSendForRead(request, result, current)).toEqual(result);
  const unavailable = { version, readId: request.readId, selector, scope, status: 'unavailable' };
  expect(ownConversationSendForRead(request, unavailable, current)).toEqual(unavailable);
  for (const changed of [
    { ...result, readId: id(73) },
    { ...result, selector: { ...selector, commandId: id(73) } },
    { ...result, scope: { ...scope, accountId: id(73) } },
    { ...result, scope: { ...scope, privacyEpoch: 3 } },
    { ...result, conversation: { ...conversation, conversationId: id(73) } },
    { ...result, conversation: { ...conversation, membershipId: id(73) } },
    { ...result, conversation: { ...conversation, membershipRevision: 2 } },
    { ...result, sent: { kind: 'text', text: 'PRIVATE_CANARY' } },
  ])
    expect(ownConversationSendForRead(request, changed, current)).toBeUndefined();
  for (const changed of [
    undefined,
    {},
    { ...current, scope: { ...scope, privacyEpoch: 3 } },
    { ...current, conversation: { ...conversation, membershipRevision: 2 } },
  ])
    expect(ownConversationSendForRead(request, result, changed)).toBeUndefined();
  expect(
    ownConversationSendForRead(
      { ...request, conversation: { ...conversation, membershipId: id(73) } },
      unavailable,
      current,
    ),
  ).toBeUndefined();
  const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  expect(
    ownConversationSendForRead(
      { ...request, readId: uppercase },
      { ...result, readId: uppercase.toLowerCase() },
      current,
    )?.readId,
  ).toBe(uppercase.toLowerCase());
  let calls = 0;
  const accessor = Object.defineProperty({ conversation }, 'scope', {
    enumerable: true,
    get: () => {
      calls++;
      return scope;
    },
  });
  expect(ownConversationSendForRead(request, result, accessor)).toBeUndefined();
  expect(calls).toBe(0);
});

describe('replies and reactions (v3 T-B)', () => {
  const reply = { version, commandId: id(60), conversation, body: { kind: 'text', text: 'part 2 abhi start kiya' } };
  it('lets a send name the message it answers by ID, and nothing else', () => {
    expect(SendConversationMessageSchema.safeParse({ ...reply, replyTo: id(61) }).success).toBe(true);
    expect(SendConversationMessageSchema.safeParse(reply).success).toBe(true);
    for (const replyTo of ['not-an-id', 3, { messageId: id(61) }, null])
      expect(SendConversationMessageSchema.safeParse({ ...reply, replyTo }).success).toBe(false);
  });

  it('has exactly the five reactions, and a command states a wanted state', () => {
    expect(MESSAGE_REACTION_KINDS).toEqual(['spark', 'mind_blown', 'ha', 'heart', 'question']);
    const react = { version, commandId: id(62), conversation, messageId: id(63), kind: 'heart', present: true };
    expect(ReactToConversationMessageSchema.safeParse(react).success).toBe(true);
    expect(ReactToConversationMessageSchema.safeParse({ ...react, present: false }).success).toBe(true);
    for (const patch of [
      { kind: 'thumbs_up' },
      { kind: '❤️' },
      { present: 'yes' },
      { present: undefined },
      { extra: 1 },
    ])
      expect(ReactToConversationMessageSchema.safeParse({ ...react, ...patch }).success).toBe(false);
    const accepted = {
      version,
      scope,
      commandId: id(62),
      recordedAt: '2026-10-31T08:00:00.000Z',
      replayed: false,
      outcome: 'accepted',
      operation: 'message.react',
      conversation,
      messageId: id(63),
      kind: 'heart',
      present: true,
      changed: false,
    };
    expect(ConversationReactionAcceptanceSchema.safeParse(accepted).success).toBe(true);
  });

  it('carries each kind once with the people behind it, and a quote of the original, and no time', () => {
    const ravi = { ...person, personId: id(64), handle: 'friend.b' };
    const reactions = [
      { kind: 'spark', mine: false, people: [ravi] },
      { kind: 'heart', mine: true, people: [person, ravi] },
    ];
    const quote = {
      messageId: id(61),
      sequence: 1,
      original: { status: 'available', author: ravi, preview: 'who is on part 2?' },
    };
    expect(ConversationMessageSchema.safeParse({ ...message(2), reactions, replyTo: quote }).success).toBe(true);
    expect(
      ConversationMessageSchema.safeParse({ ...message(2), replyTo: { ...quote, original: { status: 'unavailable' } } })
        .success,
    ).toBe(true);
    // A kind twice, an empty kind, a sixth kind, a time on a reaction and a person without a name are all refused.
    for (const bad of [
      [reactions[0], reactions[0]],
      [{ kind: 'spark', mine: false, people: [] }],
      [{ ...reactions[0], at: '2026-10-31T08:00:00.000Z' }],
      [{ kind: 'thumbs_up', mine: false, people: [ravi] }],
      [{ kind: 'spark', mine: false, people: [{ personId: id(65) }] }],
    ])
      expect(ConversationMessageSchema.safeParse({ ...message(2), reactions: bad }).success).toBe(false);
    // A removed message carries neither.
    expect(
      ConversationMessageSchema.safeParse({ status: 'unavailable', messageId: id(66), sequence: 3, reactions }).success,
    ).toBe(false);
  });
});
