import {
  ConversationChangesPageSchema,
  ConversationHistoryPageSchema,
  ConversationInboxSchema,
  DirectConversationSnapshotSchema,
  OwnConversationSendSchema,
  ReadConversationChangesSchema,
  ReadConversationHistorySchema,
  ReadConversationInboxSchema,
  ReadDirectConversationSchema,
  ReadOwnConversationSendSchema,
  type ConversationMessage,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { changesCursor, historyCursor, inboxCursor } from '../domain/cursors.js';
import { enterConversation, refOf } from './conversation-gate.js';
import type { ConversationPorts, InboxRow, MessageRow } from './conversation-ports.js';
import { viewMessages } from './message-view.js';
import { conversationEnvelope, refuse, type Result } from './ports.js';

const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

const own = (row: { readThroughSequence: number; muted: boolean }) => ({
  readThroughSequence: row.readThroughSequence,
  muted: row.muted,
});

/**
 * The reads of direct conversations: the Talk inbox, a thread's snapshot, older history and
 * catch-up after a hint. Every read checks current authority (gates, pair lock, membership) and
 * answers `unavailable` identically for a stranger, a blocked pair and a missing conversation.
 * Reading creates no evidence, receipt or notice.
 */
export function makeConversationReads(p: ConversationPorts) {
  return {
    /**
     * The caller's open conversations that have at least one message, newest activity first, a
     * page at a time. A cursor that does not decode answers `refresh_required`: start again.
     */
    async inbox(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationInboxSchema>>> {
      const parsed = ReadConversationInboxSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const envelope = { ...conversationEnvelope(scope), readId: query.readId };
        const position = query.cursor === undefined ? undefined : inboxCursor.decode(query.cursor);
        if (query.cursor !== undefined && position === undefined)
          return ok(
            ConversationInboxSchema.parse({
              ...envelope,
              status: 'refresh_required',
              limit: query.limit,
              requestCursor: query.cursor,
            }),
          );
        const rows = await p.conversations.inbox(scope, gate.owner.accountId, {
          ...(position === undefined ? {} : { after: position }),
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const messages = await viewMessages(
          p,
          scope,
          page.flatMap((row) => (row.lastMessage ? [row.lastMessage] : [])),
        );
        const items = page.map((row) => summary(row, messages));
        return ok(
          ConversationInboxSchema.parse({
            ...envelope,
            status: 'ready',
            limit: query.limit,
            ...(query.cursor === undefined ? {} : { requestCursor: query.cursor }),
            viewRevision: await p.conversations.inboxRevision(scope, gate.owner.accountId),
            items,
            continuation:
              rows.length > query.limit && last
                ? {
                    kind: 'more',
                    cursor: inboxCursor.encode({
                      activityMs: last.conversation.lastActivityAt.getTime(),
                      conversationId: last.conversation.conversationId,
                    }),
                  }
                : { kind: 'end' },
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** The newest messages of a thread plus the cursor to catch up from, read under one lock. */
    async read(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DirectConversationSnapshotSchema>>> {
      const parsed = ReadDirectConversationSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...conversationEnvelope(scope), readId: query.readId };
        const entered = await enterConversation(p, scope, query.conversation);
        if (!entered) return ok(DirectConversationSnapshotSchema.parse({ ...envelope, status: 'unavailable' }));
        const { conversation } = entered;
        const rows = (
          await p.conversations.messages(entered.lock, conversation.conversationId, { limit: query.limit })
        ).toReversed();
        return ok(
          DirectConversationSnapshotSchema.parse({
            ...envelope,
            status: 'ready',
            conversation: refOf(entered),
            peer: await peerOf(p, scope, entered.peer.accountId),
            own: own(entered.own),
            ...(conversation.closed ? { ended: true } : {}),
            latestMessageSequence: conversation.lastSequence,
            messages: await viewMessages(p, entered.lock, rows),
            limit: query.limit,
            history: olderThan(rows, conversation.conversationId),
            catchUpCursor: changesCursor.encode({
              conversationId: conversation.conversationId,
              afterChangeSequence: conversation.lastChangeSequence,
            }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** Messages older than the oldest the caller holds. A cursor of another thread is stale. */
    async history(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationHistoryPageSchema>>> {
      const parsed = ReadConversationHistorySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...conversationEnvelope(scope), readId: query.readId };
        const entered = await enterConversation(p, scope, query.conversation);
        if (!entered) return ok(ConversationHistoryPageSchema.parse({ ...envelope, status: 'unavailable' }));
        const position = historyCursor.decode(query.cursor);
        if (position?.conversationId !== entered.conversation.conversationId)
          return ok(
            ConversationHistoryPageSchema.parse({
              ...envelope,
              status: 'refresh_required',
              requestCursor: query.cursor,
            }),
          );
        const rows = (
          await p.conversations.messages(entered.lock, position.conversationId, {
            before: position.beforeSequence,
            limit: query.limit,
          })
        ).toReversed();
        return ok(
          ConversationHistoryPageSchema.parse({
            ...envelope,
            status: 'ready',
            conversation: refOf(entered),
            limit: query.limit,
            requestCursor: query.cursor,
            messages: await viewMessages(p, entered.lock, rows),
            continuation: olderThan(rows, position.conversationId),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Changes after the caller's last confirmed change: new messages and tombstones, in change
     * order, up to the number the thread had when this read took its lock. A position from the
     * future or from another thread is stale.
     */
    async changes(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationChangesPageSchema>>> {
      const parsed = ReadConversationChangesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...conversationEnvelope(scope), readId: query.readId };
        const entered = await enterConversation(p, scope, query.conversation);
        if (!entered) return ok(ConversationChangesPageSchema.parse({ ...envelope, status: 'unavailable' }));
        const { conversation } = entered;
        const position = changesCursor.decode(query.cursor);
        if (
          position?.conversationId !== conversation.conversationId ||
          position.afterChangeSequence > conversation.lastChangeSequence
        )
          return ok(
            ConversationChangesPageSchema.parse({
              ...envelope,
              status: 'refresh_required',
              requestCursor: query.cursor,
            }),
          );
        const rows = await p.conversations.messages(entered.lock, conversation.conversationId, {
          after: position.afterChangeSequence,
          limit: query.limit,
        });
        const views = await viewMessages(p, entered.lock, rows);
        const changes = rows.map((row, index) => ({ changeSequence: row.changeSequence, message: views[index]! }));
        const through = conversation.lastChangeSequence;
        const last = changes.at(-1)?.changeSequence ?? position.afterChangeSequence;
        const cursorAt = (afterChangeSequence: number) =>
          changesCursor.encode({ conversationId: conversation.conversationId, afterChangeSequence });
        return ok(
          ConversationChangesPageSchema.parse({
            ...envelope,
            status: 'ready',
            conversation: refOf(entered),
            limit: query.limit,
            requestCursor: query.cursor,
            ...(conversation.closed ? { ended: true } : {}),
            fromChangeSequence: position.afterChangeSequence,
            throughChangeSequence: through,
            changes,
            continuation:
              rows.length === query.limit && last < through
                ? { kind: 'more', cursor: cursorAt(last) }
                : { kind: 'caught_up', cursor: cursorAt(through) },
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * After an unknown send: has the caller's own message with this command been stored? Gates
     * apply as for any read. `unavailable` is not proof the message was not sent.
     */
    async readOwnSend(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof OwnConversationSendSchema>>> {
      const parsed = ReadOwnConversationSendSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...conversationEnvelope(scope), readId: query.readId, selector: query.selector };
        const unavailable = () => ok(OwnConversationSendSchema.parse({ ...envelope, status: 'unavailable' }));
        const entered = await enterConversation(p, scope, query.conversation);
        if (!entered) return unavailable();
        const message = await p.conversations.messageOfCommand(
          entered.lock,
          entered.conversation.conversationId,
          entered.owner.accountId,
          query.selector.commandId,
        );
        if (!message) return unavailable();
        return ok(
          OwnConversationSendSchema.parse({
            ...envelope,
            status: 'accepted',
            conversation: refOf(entered),
            messageId: message.messageId,
            messageSequence: message.sequence,
            recordedAt: message.recordedAt.toISOString(),
            sent: message.content ? { kind: 'content', target: message.content } : { kind: 'text' },
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}

function summary(row: InboxRow, messages: readonly ConversationMessage[]) {
  const last = row.lastMessage && messages.find((message) => message.messageId === row.lastMessage?.messageId);
  return {
    conversation: refOf(row),
    peer: row.peerPerson,
    latestMessageSequence: row.conversation.lastSequence,
    own: own(row.own),
    ...(row.conversation.closed ? { ended: true as const } : {}),
    ...(last ? { lastMessage: last } : {}),
  };
}

/** The older-history continuation after a page that starts at `rows[0]`. */
function olderThan(rows: readonly MessageRow[], conversationId: string) {
  const oldest = rows[0];
  return oldest && oldest.sequence > 1
    ? { kind: 'more' as const, cursor: historyCursor.encode({ conversationId, beforeSequence: oldest.sequence }) }
    : { kind: 'end' as const };
}

async function peerOf(p: ConversationPorts, scope: PersonalScopeTx, accountId: string) {
  const profile = await p.store.profile(scope, { accountId });
  if (!profile) throw new Error('SOCIAL_PROFILE_MISSING');
  return profile.person;
}
