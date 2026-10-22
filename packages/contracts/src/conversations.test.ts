import { describe, expect, it } from 'vitest';
import {
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
