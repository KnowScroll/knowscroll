import {
  CreateDiscussionSchema,
  DiscussionCreationSchema,
  DiscussionPinAcceptanceSchema,
  HideRoomMessageSchema,
  MarkUsefulSchema,
  PinDiscussionSchema,
  RoomMessageAcceptanceSchema,
  RoomMessageHidingAcceptanceSchema,
  SendRoomMessageSchema,
  UsefulAcceptanceSchema,
  type SendRoomBody,
  type SnippetAnchor,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { SnippetAnchorInput, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { mentionedResident } from '../domain/asks.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { titleFrom } from '../domain/titles.js';
import { usefulRefusal } from '../domain/useful.js';
import { askDecisionFor, queueAsk } from './ask-turn.js';
import { scheduleCastCheck } from './cast-schedule.js';
import { receiptBase, runCommand } from './command.js';
import {
  ok,
  refuse,
  type ContentCard,
  type ContentRef,
  type DiscussionRow,
  type Result,
  type RoomLock,
  type RoomPorts,
  type TopicTag,
} from './ports.js';

/** The content port's anchor input from the wire anchor: personal values travel only when the sender confirmed them. */
function anchorInput(anchor: SnippetAnchor): SnippetAnchorInput {
  if (anchor.kind !== 'scroll_block') return anchor;
  if (anchor.settings === undefined)
    return {
      kind: anchor.kind,
      blockId: anchor.blockId,
      blockType: anchor.blockType,
      blockVersion: anchor.blockVersion,
    };
  return {
    kind: 'scroll_block',
    blockId: anchor.blockId,
    blockType: anchor.blockType,
    blockVersion: anchor.blockVersion,
    settings: { snapshot: anchor.settings.snapshot, confirmPersonal: anchor.settings.confirmPersonal === true },
  };
}

/** The title a card gives a discussion: the content's own title, as the sender saw it. */
function cardTitle(card: ContentCard): string {
  const metadata =
    card.status === 'available' ? card.metadata : card.status === 'corrected' ? card.current.metadata : undefined;
  return titleFrom(metadata?.title ?? '', 'Shared');
}

/** What a new discussion begins with: its title, an optional tag and root, the message it began from and where its card goes. */
interface StartingPoint {
  readonly title: string;
  /** The title is the first words of the message the topic began from (not typed by the starter): see `shownTitle`. */
  readonly titleDerived?: boolean;
  readonly tag?: TopicTag | undefined;
  readonly root?: ContentRef;
  readonly originMessageId?: string;
  /** The discussion a topic card is left in: set only for a topic that began from a message with words. */
  readonly cardIn?: string;
}

/**
 * The commands of discussions: start one, send a message, and the moderator's pin and hide. Each
 * runs in the caller's personal scope and the room's lock (FOR SHARE: who is in does not change
 * here), checks that the caller is a member (a moderator for the last two), and commits its effect
 * and receipt together. Counters are atomic increments on the discussion row. A message is
 * conversation: nothing here is consumption evidence for anyone.
 */
export function makeDiscussionCommands(p: RoomPorts) {
  /** The content a discussion or message may name: the current admitted revision, as an available card. */
  async function availableCard(scope: PersonalScopeTx, ref: ContentRef): Promise<ContentCard | undefined> {
    const [card] = await p.readContent(scope, [ref]);
    return card?.status === 'available' ? card : undefined;
  }

  /**
   * The checked anchor of a snippet send, or the refusal. A snippet points into the discussion's own
   * sequence (its root, or the units of the declared series it belongs to), so a discussion cannot be
   * made a place to post other content; an anchor that does not fit is invalid input, and a source
   * that is not the current admitted revision is unavailable.
   */
  async function checkSnippet(
    scope: PersonalScopeTx,
    discussion: DiscussionRow,
    body: Extract<SendRoomBody, { kind: 'snippet' }>,
  ): Promise<Result<StoredSnippetAnchor>> {
    if (discussion.root === null) return refuse('invalid_input');
    const sequence = await p.readSequence(scope, discussion.root);
    const episodes = sequence === undefined ? [] : sequence.kind === 'single' ? [sequence.unit] : sequence.units;
    if (!episodes.some((unit) => unit.assetId === body.target.assetId.toLowerCase())) return refuse('invalid_input');
    const checked = await p.validateSnippet(scope, body.target, anchorInput(body.anchor));
    if (checked.status === 'invalid') return refuse('invalid_input');
    if (checked.status === 'unavailable') return refuse('unavailable');
    return ok(checked.anchor);
  }

  /**
   * What a new discussion begins with, from how it was asked for: words (a topic), a Reel or Scroll (a content
   * thread) or a message of this room. A card for content starts a content thread about it; a message with words
   * starts a topic that begins with it and leaves a card where it was (D-167); anything else is unavailable.
   */
  async function resolveStart(
    scope: PersonalScopeTx,
    lock: RoomLock,
    accountId: string,
    start: z.infer<typeof CreateDiscussionSchema>['start'],
  ): Promise<Result<StartingPoint>> {
    if (start.kind === 'topic') return ok({ title: start.title, tag: start.tag });
    if (start.kind === 'content') {
      const card = await availableCard(scope, start.root);
      return card === undefined
        ? refuse('unavailable')
        : ok({ root: start.root, title: start.title ?? cardTitle(card) });
    }
    const origin = await p.discussions.messageInRoom(lock, start.messageId);
    if (origin === undefined || origin.discussionId !== start.discussionId) return refuse('unavailable');
    const { message } = origin;
    if (message.hidden) return refuse('unavailable');
    if (message.content !== null) {
      const card = await availableCard(scope, message.content);
      if (card === undefined) return refuse('unavailable');
      return ok({ root: message.content, originMessageId: message.messageId, title: start.title ?? cardTitle(card) });
    }
    if (message.text === null) return refuse('unavailable');
    // Only someone who has not blocked the author can read the words to start a topic from them.
    if (
      message.authorAccountId !== null &&
      (await p.blocked(scope, accountId, [message.authorAccountId])).has(message.authorAccountId)
    )
      return refuse('unavailable');
    // A title left as the message's own first words is that person's words, not the starter's: it is shown to a reader
    // only while the message is (D-168). A title the starter changed is theirs.
    const derivedTitle = titleFrom(message.text, 'Topic');
    return ok({
      originMessageId: message.messageId,
      title: start.title ?? derivedTitle,
      titleDerived: start.title === undefined || start.title === derivedTitle,
      tag: start.tag,
      cardIn: start.discussionId,
    });
  }

  /** The discussion of this room, or the refusal; for the commands that act inside one. */
  async function discussionOf(lock: RoomLock, discussionId: string): Promise<Result<DiscussionRow>> {
    const discussion = await p.discussions.load(lock, discussionId);
    return discussion === undefined ? refuse('unavailable') : ok(discussion);
  }

  return {
    /**
     * Starts a discussion in a room that is open: about a topic in words, about a Reel or Scroll the
     * caller names (a content thread), or from a message of this room. A card for content starts a content thread
     * about it; a message with words starts a topic that begins with that message, leaves a card where it was and
     * may carry a tag from a closed list (D-167). A root must be the current admitted revision. Starting a thread
     * from shared content is how a room hears about it; it is not a recommendation and not evidence.
     */
    create(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionCreationSchema>>> {
      const parsed = CreateDiscussionSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.discussion-create',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: DiscussionCreationSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const found = await resolveStart(scope, lock, owner.accountId, command.start);
          if (found.kind === 'refused') return found;
          const { title, titleDerived, tag, root, originMessageId, cardIn } = found.value;
          return ok(async () => {
            const discussionId = p.newId();
            await p.discussions.create(lock, {
              discussionId,
              title,
              titleDerived: titleDerived ?? false,
              tag,
              root,
              originMessageId,
              startedByAccountId: owner.accountId,
              now,
            });
            if (cardIn !== undefined) {
              // The original message stays where it was; the card says a topic began from it and keeps updating.
              await p.discussions.append(lock, cardIn, {
                kind: 'person',
                messageId: p.newId(),
                commandId: p.newId(),
                authorAccountId: owner.accountId,
                recordedAt: now,
                topicDiscussionId: discussionId,
              });
              await p.rooms.announce(lock, now);
            }
            return DiscussionCreationSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'discussion.create',
              roomId: command.roomId,
              discussionId,
            });
          });
        },
      });
    },

    /**
     * Sends a text message, a card for current content, or a snippet. A snippet is checked against
     * the exact current revision and the discussion's own content; the message and its anchor commit
     * together. A text message that names a resident (@Nova, @Halley) asks it, within the asked-turn bounds (D-167);
     * one that reads as a question or a strong claim queues the check of whether a resident answers it, in the same
     * transaction (D-164). Sending is not consumption evidence for anyone.
     */
    send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomMessageAcceptanceSchema>>> {
      const parsed = SendRoomMessageSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.discussion-send',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomMessageAcceptanceSchema,
        requires: 'member',
        // A message that names a resident may ask it, and the asked-turn bounds are counts: take the room FOR UPDATE.
        mode: command.body.kind === 'text' && command.body.text.includes('@') ? 'write' : 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const found = await discussionOf(lock, command.discussionId);
          if (found.kind === 'refused') return found;
          const body = command.body;
          let snippet: StoredSnippetAnchor | undefined;
          if (body.kind === 'content') {
            if ((await availableCard(scope, body.target)) === undefined) return refuse('unavailable');
          } else if (body.kind === 'snippet') {
            const checked = await checkSnippet(scope, found.value, body);
            if (checked.kind === 'refused') return checked;
            snippet = checked.value;
          }
          return ok(async () => {
            const messageId = p.newId();
            const stored = await p.discussions.append(lock, command.discussionId, {
              kind: 'person',
              messageId,
              commandId: command.commandId,
              authorAccountId: owner.accountId,
              recordedAt: now,
              ...(body.kind === 'text'
                ? { text: body.text }
                : { content: body.target, ...(body.note === undefined ? {} : { note: body.note }) }),
            });
            if (snippet !== undefined) await p.discussions.saveSnippet(lock, messageId, snippet);
            if (body.kind === 'text') {
              const mention = mentionedResident(body.text, standing.room.cast);
              // A message that names a resident is addressed to it: it is an ask (within the asked bounds), and no
              // resident also decides on its own whether to answer the same words.
              if (mention !== undefined) {
                const decision = await askDecisionFor(p, lock, owner.accountId, command.discussionId, now);
                if (decision === 'allowed')
                  await queueAsk(p, scope, lock, {
                    kind: 'mention',
                    inhabitant: mention,
                    roomId: command.roomId,
                    discussionId: command.discussionId,
                    causeMessageId: messageId,
                    accountId: owner.accountId,
                    commandId: command.commandId,
                    now,
                  });
              } else
                await scheduleCastCheck(p, scope, lock, {
                  room: standing.room,
                  discussionId: command.discussionId,
                  messageId,
                  authorAccountId: owner.accountId,
                  text: body.text,
                  now,
                });
            }
            await p.rooms.announce(lock, now);
            return RoomMessageAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'discussion.send',
              roomId: command.roomId,
              discussionId: command.discussionId,
              messageId,
              messageSequence: stored.sequence,
            });
          });
        },
      });
    },

    /**
     * A moderator pins a discussion at the top of the room or lets it go. A pin organises the room's
     * list; it moves nobody's player, changes nobody's universe and starts no production.
     */
    pin(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionPinAcceptanceSchema>>> {
      const parsed = PinDiscussionSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.discussion-pin',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: DiscussionPinAcceptanceSchema,
        requires: 'moderator',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const found = await discussionOf(entered.lock, command.discussionId);
          if (found.kind === 'refused') return found;
          // General is where everyone lands; a pin would only hide it behind itself.
          if (found.value.kind === 'general') return refuse('unavailable');
          return ok(async () => {
            await p.discussions.setPinned(entered.lock, command.discussionId, command.pinned ? now : null);
            return DiscussionPinAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'discussion.pin',
              roomId: command.roomId,
              discussionId: command.discussionId,
              pinned: command.pinned,
            });
          });
        },
      });
    },

    /**
     * Marks a message Useful, or takes the mark back (D-167). One mark per member per message, and the same value
     * again is accepted. A member cannot mark their own message, a message that is not shown to them or one whose
     * author they blocked, and there is no negative mark. The mark is shown to its maker only; an author is never told
     * who marked theirs. It is conversation: it is no evidence for anyone and changes no universe.
     */
    markUseful(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof UsefulAcceptanceSchema>>> {
      const parsed = MarkUsefulSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.message-useful',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: UsefulAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const found = await discussionOf(lock, command.discussionId);
          if (found.kind === 'refused') return found;
          const message = await p.discussions.messageById(lock, command.discussionId, command.messageId);
          if (message === undefined) return refuse('unavailable');
          if (command.useful) {
            const refusal = usefulRefusal({
              shown: !message.hidden && (message.text !== null || message.content !== null),
              ownMessage: message.authorAccountId === owner.accountId,
            });
            if (refusal === 'own_message') return refuse('invalid_input');
            if (refusal !== undefined) return refuse('unavailable');
            if (
              message.authorAccountId !== null &&
              (await p.blocked(scope, owner.accountId, [message.authorAccountId])).has(message.authorAccountId)
            )
              return refuse('unavailable');
          }
          return ok(async () => {
            await p.discussions.setUseful(lock, command.messageId, owner.accountId, command.useful, now);
            return UsefulAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'message.useful',
              roomId: command.roomId,
              discussionId: command.discussionId,
              messageId: command.messageId,
              useful: command.useful,
            });
          });
        },
      });
    },

    /**
     * A moderator removes a message from view, or restores it. The message keeps its place and gets a
     * fresh change number, so everyone's catch-up replaces the bubble with the marker.
     */
    hideMessage(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomMessageHidingAcceptanceSchema>>> {
      const parsed = HideRoomMessageSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.discussion-hide',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomMessageHidingAcceptanceSchema,
        requires: 'moderator',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock } = entered;
          const found = await discussionOf(lock, command.discussionId);
          if (found.kind === 'refused') return found;
          const message = await p.discussions.messageById(lock, command.discussionId, command.messageId);
          if (message === undefined || message.hidden === command.hidden) return refuse('unavailable');
          return ok(async () => {
            await p.discussions.setHidden(lock, command.discussionId, command.messageId, command.hidden ? now : null);
            // A summary that read this message may carry its words: erase it (D-169).
            if (command.hidden) await p.summaries.markStale(lock, { coveringAt: message.recordedAt });
            return RoomMessageHidingAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'discussion.hide',
              roomId: command.roomId,
              discussionId: command.discussionId,
              messageId: command.messageId,
              hidden: command.hidden,
            });
          });
        },
      });
    },
  };
}
