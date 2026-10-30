import {
  ContentThreadViewSchema,
  ReadContentThreadSchema,
  ReadThreadChangesSchema,
  ReadThreadHistorySchema,
  ReadThreadInboxSchema,
  OpenThreadSnippetSchema,
  ThreadChangesPageSchema,
  ThreadHistoryPageSchema,
  ThreadInboxSchema,
  ThreadSnippetOpeningSchema,
  type ContentThreadRef,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { SnippetResolution, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { changesCursor, historyCursor } from '../domain/cursors.js';
import { isParticipant } from '../domain/threads.js';
import type { ContentRef, MessageRow } from './conversation-ports.js';
import { DELETED_PERSON } from './deleted-person.js';
import { refuse, threadEnvelope, type Result } from './ports.js';
import { enterThread, threadRefOf, type EnteredThread } from './thread-gate.js';
import type { ExtrasContext } from './message-extras.js';
import type { ThreadLock, ThreadMember, ThreadPorts } from './thread-ports.js';
import { participantsOf, threadEpisodes, viewThreadMessages } from './thread-view.js';

const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

const own = (member: { readThroughSequence: number; muted: boolean }) => ({
  readThroughSequence: member.readThroughSequence,
  muted: member.muted,
});

/** Reactions and reply quotes are read for this thread, as its caller may see them. */
const extrasContext = (entered: EnteredThread): ExtrasContext => ({
  conversationId: entered.thread.threadId,
  viewerAccountId: entered.owner.accountId,
});

/** The older-history continuation after a page that starts at `rows[0]`. */
function olderThan(rows: readonly MessageRow[], threadId: string) {
  const oldest = rows[0];
  return oldest && oldest.sequence > 1
    ? {
        kind: 'more' as const,
        cursor: historyCursor.encode({ conversationId: threadId, beforeSequence: oldest.sequence }),
      }
    : { kind: 'end' as const };
}

/** Whoever invited a member, or the starter once the inviter is gone, or the neutral deleted person. */
function inviterOf(
  members: readonly ThreadMember[],
  member: ThreadMember,
  starterAccountId: string | null,
): PublicPersonRef {
  const inviter = members.find((candidate) => candidate.accountId === (member.inviterAccountId ?? starterAccountId));
  return inviter?.person ?? DELETED_PERSON;
}

/** The title of the content's current revision, or nothing when it cannot be shown (withdrawn meanwhile). */
async function currentTitle(p: ThreadPorts, lock: ThreadLock, location: ContentRef): Promise<string | undefined> {
  const [card] = await p.conversations.cards(lock, [location]);
  return card?.status === 'available' ? card.metadata.title : undefined;
}

/**
 * The anchor to open, with the words the banner shows. They come from the stored snippet, which copied
 * them from the exact revision the sender saw; a correction only moved where they are found.
 */
function openedAnchor(
  resolved: Extract<SnippetResolution, { status: 'ready' }>['anchor'],
  stored: StoredSnippetAnchor,
) {
  if (resolved.kind === 'scroll_passage' && stored.kind === 'scroll_passage')
    return { ...resolved, quote: stored.quote };
  if (resolved.kind === 'scroll_block' && stored.kind === 'scroll_block') {
    const settings = resolved.snapshot === undefined ? undefined : stored.settings;
    return {
      ...resolved,
      ...(stored.label === '' ? {} : { label: stored.label }),
      ...(settings === undefined || settings.description === '' ? {} : { description: settings.description }),
    };
  }
  return resolved;
}

/**
 * The reads of content threads: the thread's view (or its invitation), older history, catch-up after
 * a hint, the caller's thread list and the opening of a snippet. Every read checks current authority
 * (account gate, thread root, membership and the friendship it rests on) and answers `unavailable`
 * identically for a stranger, a removed member and a missing thread. Reading creates no evidence,
 * receipt or notice, and no answer carries another member's position, current episode or seen marker.
 */
export function makeThreadReads(p: ThreadPorts) {
  return {
    /**
     * The newest messages of a thread, its participants and episodes (with the caller's own visited
     * markers) and the cursor to catch up from, read under one lock. A member whose invitation is open
     * gets the invitation instead: the content, who invited, and nothing of the conversation.
     */
    async read(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ContentThreadViewSchema>>> {
      const parsed = ReadContentThreadSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const entered = await enterThread(p, scope, query.thread, 'read', 'participant_or_invitee');
        if (!entered) return ok(ContentThreadViewSchema.parse({ ...envelope, status: 'unavailable' }));
        const { thread } = entered;
        const [rootCard] = await p.conversations.cards(entered.lock, [thread.root]);
        const root = rootCard ?? { status: 'unavailable' as const, target: thread.root };
        const name = thread.name === null ? {} : { name: thread.name };
        if (entered.own.pending)
          return ok(
            ContentThreadViewSchema.parse({
              ...envelope,
              status: 'invitation',
              thread: threadRefOf(entered),
              ...name,
              root,
              invitedBy: inviterOf(entered.members, entered.own, thread.starterAccountId),
              participantCount: entered.members.filter(isParticipant).length,
            }),
          );
        const sequence = await threadEpisodes(p, entered.lock, thread.root);
        if (sequence === undefined) throw new Error('SOCIAL_THREAD_ROOT_MISSING');
        const rows = (
          await p.conversations.messages(entered.lock, thread.threadId, { limit: query.limit })
        ).toReversed();
        return ok(
          ContentThreadViewSchema.parse({
            ...envelope,
            status: 'ready',
            thread: threadRefOf(entered),
            ...name,
            root,
            participants: participantsOf(entered),
            sequence: sequence.sequence,
            episodes: sequence.episodes,
            own: own(entered.own),
            latestMessageSequence: thread.lastSequence,
            messages: await viewThreadMessages(p, entered.lock, rows, extrasContext(entered)),
            limit: query.limit,
            history: olderThan(rows, thread.threadId),
            catchUpCursor: changesCursor.encode({
              conversationId: thread.threadId,
              afterChangeSequence: thread.lastChangeSequence,
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
    ): Promise<Result<z.infer<typeof ThreadHistoryPageSchema>>> {
      const parsed = ReadThreadHistorySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const entered = await enterThread(p, scope, query.thread, 'read');
        if (!entered) return ok(ThreadHistoryPageSchema.parse({ ...envelope, status: 'unavailable' }));
        const position = historyCursor.decode(query.cursor);
        if (position?.conversationId !== entered.thread.threadId)
          return ok(
            ThreadHistoryPageSchema.parse({ ...envelope, status: 'refresh_required', requestCursor: query.cursor }),
          );
        const rows = (
          await p.conversations.messages(entered.lock, position.conversationId, {
            before: position.beforeSequence,
            limit: query.limit,
          })
        ).toReversed();
        return ok(
          ThreadHistoryPageSchema.parse({
            ...envelope,
            status: 'ready',
            thread: threadRefOf(entered),
            limit: query.limit,
            requestCursor: query.cursor,
            messages: await viewThreadMessages(p, entered.lock, rows, extrasContext(entered)),
            continuation: olderThan(rows, position.conversationId),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Changes after the caller's last confirmed change: new messages and tombstones in change order, up
     * to the number the thread had when this read took its lock. A position from the future or from
     * another thread is stale.
     */
    async changes(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadChangesPageSchema>>> {
      const parsed = ReadThreadChangesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const entered = await enterThread(p, scope, query.thread, 'read');
        if (!entered) return ok(ThreadChangesPageSchema.parse({ ...envelope, status: 'unavailable' }));
        const { thread } = entered;
        const position = changesCursor.decode(query.cursor);
        if (position?.conversationId !== thread.threadId || position.afterChangeSequence > thread.lastChangeSequence)
          return ok(
            ThreadChangesPageSchema.parse({ ...envelope, status: 'refresh_required', requestCursor: query.cursor }),
          );
        const rows = await p.conversations.messages(entered.lock, thread.threadId, {
          after: position.afterChangeSequence,
          limit: query.limit,
        });
        const views = await viewThreadMessages(p, entered.lock, rows, extrasContext(entered));
        const changes = rows.map((row, index) => ({ changeSequence: row.changeSequence, message: views[index]! }));
        const through = thread.lastChangeSequence;
        const last = changes.at(-1)?.changeSequence ?? position.afterChangeSequence;
        const cursorAt = (afterChangeSequence: number) =>
          changesCursor.encode({ conversationId: thread.threadId, afterChangeSequence });
        return ok(
          ThreadChangesPageSchema.parse({
            ...envelope,
            status: 'ready',
            thread: threadRefOf(entered),
            limit: query.limit,
            requestCursor: query.cursor,
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
     * The caller's open threads, joined and invited, newest activity first. An invitation names who invited
     * and shows no message and no counts: the conversation is not readable until the person joins.
     */
    async inbox(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadInboxSchema>>> {
      const parsed = ReadThreadInboxSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const rows = await p.threads.inbox(scope, gate.owner.accountId, query.limit);
        const roots = new Map(
          rows.map((row) => [`${row.thread.root.assetId}:${String(row.thread.root.assetRevision)}`, row.thread.root]),
        );
        const cards =
          roots.size === 0 ? [] : await p.conversations.cards(scope, [...roots.values()] satisfies ContentRef[]);
        const cardOf = (root: ContentRef) =>
          cards.find(
            (card) => card.target.assetId === root.assetId && card.target.assetRevision === root.assetRevision,
          ) ?? {
            status: 'unavailable' as const,
            target: root,
          };
        const lastMessages = await viewThreadMessages(
          p,
          scope,
          rows.flatMap((row) => (row.lastMessage ? [row.lastMessage] : [])),
        );
        const items = rows.map((row) => {
          const pending = row.own.pending;
          const last =
            row.lastMessage && lastMessages.find((message) => message.messageId === row.lastMessage?.messageId);
          return {
            thread: {
              threadId: row.thread.threadId,
              membershipId: row.own.membershipId,
              membershipRevision: row.own.membershipRevision,
            } satisfies ContentThreadRef,
            ...(row.thread.name === null ? {} : { name: row.thread.name }),
            root: cardOf(row.thread.root),
            state: pending ? ('invited' as const) : ('joined' as const),
            ownPersonId: row.own.person.personId,
            people: pending ? [row.inviter ?? DELETED_PERSON] : row.people,
            latestMessageSequence: pending ? 0 : row.thread.lastSequence,
            own: pending ? { readThroughSequence: 0, muted: row.own.muted } : own(row.own),
            // Until the person joins, when the others last talked is not theirs to see.
            lastActivityAt: (pending ? row.thread.createdAt : row.thread.lastActivityAt).toISOString(),
            ...(last ? { lastMessage: last } : {}),
          };
        });
        return ok(
          ThreadInboxSchema.parse({
            ...threadEnvelope(scope),
            readId: query.readId,
            status: 'ready',
            limit: query.limit,
            viewRevision: await p.conversations.inboxRevision(scope, gate.owner.accountId),
            items,
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Where a snippet message leads now: the content and anchor to open, the same moved through an
     * explicit mapping after a correction, or "changed" when the moment is no longer there. Opening
     * writes nothing and is not an encounter; the content's own page records the encounter.
     */
    async openSnippet(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadSnippetOpeningSchema>>> {
      const parsed = OpenThreadSnippetSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const unavailable = () => ok(ThreadSnippetOpeningSchema.parse({ ...envelope, status: 'unavailable' }));
        const entered = await enterThread(p, scope, query.thread, 'read');
        if (!entered) return unavailable();
        const snippet = await p.threads.snippetOfMessage(entered.lock, query.messageId);
        if (!snippet) return unavailable();
        const resolution = await p.resolveSnippet(scope, snippet.target, snippet.anchor);
        if (resolution.status === 'unavailable') return unavailable();
        const location = resolution.status === 'changed' ? resolution.current : resolution.content;
        const title = await currentTitle(p, entered.lock, location);
        if (title === undefined) return unavailable();
        const content = { ...location, title };
        if (resolution.status === 'changed')
          return ok(ThreadSnippetOpeningSchema.parse({ ...envelope, status: 'changed', current: content }));
        return ok(
          ThreadSnippetOpeningSchema.parse({
            ...envelope,
            status: 'ready',
            content,
            anchor: openedAnchor(resolution.anchor, snippet.anchor),
            mapped: resolution.mapped,
            settingsReset: resolution.settingsReset,
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
