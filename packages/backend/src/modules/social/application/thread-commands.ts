import {
  ContentThreadCreationSchema,
  CreateContentThreadSchema,
  LeaveThreadSchema,
  MarkThreadReadSchema,
  ReactToThreadMessageSchema,
  RespondToThreadInvitationSchema,
  SendThreadMessageSchema,
  ThreadInvitationResponseAcceptanceSchema,
  ThreadLeaveAcceptanceSchema,
  ThreadMessageAcceptanceSchema,
  ThreadReactionAcceptanceSchema,
  ThreadReadAcceptanceSchema,
  type ContentThreadRef,
  type SendThreadBody,
  type SnippetAnchor,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { SnippetAnchorInput, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { acceptedReadThrough } from '../domain/conversations.js';
import { canTakePart, invitable, isParticipant } from '../domain/threads.js';
import type { InboxChange } from './conversation-ports.js';
import { refuse, threadEnvelope, type Result } from './ports.js';
import { planReaction, resolveReplyTarget } from './reactions.js';
import { enterThread, threadRefOf, type EnteredThread, type Entry } from './thread-gate.js';
import type { ThreadMember, ThreadPorts, ThreadRow } from './thread-ports.js';

const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

/** What a command decided: the writes to make (they return the acceptance) and whose inbox changes. */
interface Decision<A> {
  readonly write: () => Promise<A>;
  readonly announce: readonly InboxChange[];
}

interface CommandContext {
  readonly scope: PersonalScopeTx;
  readonly entered: EnteredThread;
  readonly now: Date;
}

/** The content port's anchor input from the wire anchor: personal values travel only when the sender confirmed them. */
function anchorInput(anchor: SnippetAnchor): SnippetAnchorInput {
  if (anchor.kind !== 'scroll_block' || anchor.settings === undefined) {
    return anchor.kind === 'scroll_block'
      ? { kind: anchor.kind, blockId: anchor.blockId, blockType: anchor.blockType, blockVersion: anchor.blockVersion }
      : anchor;
  }
  return {
    kind: 'scroll_block',
    blockId: anchor.blockId,
    blockType: anchor.blockType,
    blockVersion: anchor.blockVersion,
    settings: { snapshot: anchor.settings.snapshot, confirmPersonal: anchor.settings.confirmPersonal === true },
  };
}

const inboxOf = (member: ThreadMember): InboxChange => ({ accountId: member.accountId, universeId: member.universeId });
const takingPart = (entered: EnteredThread): readonly InboxChange[] => entered.members.filter(canTakePart).map(inboxOf);
const participants = (entered: EnteredThread): readonly InboxChange[] =>
  entered.members.filter(isParticipant).map(inboxOf);

/**
 * The commands of content threads: create, send, answer an invitation, mark read and leave. Each
 * runs in the caller's personal scope in the lock order of the blueprint: personal root, own
 * account gate, the thread's own root. The receipt, the effects and the inbox hints commit
 * together; hints go out only after that commit and carry no content. A retry with the same
 * command and body returns the first acceptance after current authority is checked again; the
 * same command with another body is refused. A refusal writes no receipt.
 */
export function makeThreadCommands(p: ThreadPorts) {
  const receiptKey = (scope: PersonalScopeTx, operation: string, commandId: string, request: object) => ({
    commandId,
    operation,
    outcomeVersion: 1,
    requestHash: p.hash(operation, { ...request, actorPrivacyEpoch: scope.authority.privacyEpoch }),
  });

  const receiptBase = (scope: PersonalScopeTx, now: Date, commandId: string) => ({
    ...threadEnvelope(scope),
    commandId,
    recordedAt: now.toISOString(),
    replayed: false,
    outcome: 'accepted' as const,
  });

  /** Shared skeleton of every command that acts inside one existing thread. */
  async function inThread<A extends object>(
    authority: PersonalAuthority,
    spec: {
      readonly operation: string;
      readonly command: { readonly commandId: string; readonly thread: ContentThreadRef };
      readonly request: object;
      readonly acceptance: z.ZodType<A>;
      readonly entry?: Entry;
      decide(context: CommandContext): Promise<Result<Decision<A>>>;
    },
  ): Promise<Result<A>> {
    const result = await p.withScope(authority, async (scope): Promise<Result<A>> => {
      const entered = await enterThread(p, scope, spec.command.thread, 'write', spec.entry);
      if (!entered) return refuse('unavailable');
      const key = receiptKey(scope, spec.operation, spec.command.commandId, spec.request);
      const receipt = await p.store.findReceipt(entered.lock, key);
      if (receipt.kind === 'refused') return receipt;
      if (receipt.kind === 'replay') return ok({ ...spec.acceptance.parse(receipt.outcome), replayed: true });
      const decision = await spec.decide({ scope, entered, now: p.now() });
      if (decision.kind === 'refused') return decision;
      await p.store.beginReceipt(entered.lock, key);
      const acceptance = await decision.value.write();
      await p.conversations.announce(entered.lock, decision.value.announce, () => p.newId());
      await p.store.receipt(entered.lock, key, acceptance);
      return ok(acceptance);
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  }

  /** The thread a retried create already made: current authority first, then the stored acceptance. */
  async function replayCreate(
    scope: PersonalScopeTx,
    ownAccountId: string,
    threadId: string,
    key: ReturnType<typeof receiptKey>,
  ): Promise<Result<z.infer<typeof ContentThreadCreationSchema>>> {
    const lock = await p.threads.lock(scope, threadId, 'write');
    if (!lock) return refuse('unavailable');
    const receipt = await p.store.findReceipt(lock, key);
    if (receipt.kind === 'refused') return receipt;
    if (receipt.kind === 'new') return refuse('unavailable');
    const loaded = await p.threads.load(lock, ownAccountId);
    if (!loaded || !canTakePart(loaded.own)) return refuse('unavailable');
    return ok({ ...ContentThreadCreationSchema.parse(receipt.outcome), replayed: true });
  }

  /**
   * The checked anchor of a snippet send, or the refusal. A snippet points into the thread's own
   * sequence (its root, or the units of the declared series it belongs to), so a thread cannot be made
   * a place to post other content; an anchor that does not fit is invalid input, and a source that is
   * not the current admitted revision is unavailable.
   */
  async function checkSnippet(
    scope: PersonalScopeTx,
    thread: ThreadRow,
    body: Extract<SendThreadBody, { kind: 'snippet' }>,
  ): Promise<Result<StoredSnippetAnchor>> {
    const sequence = await p.readSequence(scope, thread.root);
    const episodes = sequence === undefined ? [] : sequence.kind === 'single' ? [sequence.unit] : sequence.units;
    if (!episodes.some((unit) => unit.assetId === body.target.assetId.toLowerCase())) return refuse('invalid_input');
    const checked = await p.validateSnippet(scope, body.target, anchorInput(body.anchor));
    if (checked.status === 'invalid') return refuse('invalid_input');
    if (checked.status === 'unavailable') return refuse('unavailable');
    return ok(checked.anchor);
  }

  return {
    /**
     * Starts a thread on a current Reel or Scroll with current friends. The starter is a member; each
     * friend is invited and joins only by answering. Every friend must be a current friend, the root
     * must be the current admitted revision, and one failure makes the whole command unavailable
     * without saying which. A retry with the same command returns the same thread.
     */
    async create(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ContentThreadCreationSchema>>> {
      const parsed = CreateContentThreadSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const command = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const owner = gate.owner;
        const operation = 'social.thread-create';
        const key = receiptKey(scope, operation, command.commandId, command);
        const threadId = p.threadIdFor(owner.accountId, command.commandId);
        if (await p.threads.exists(scope, threadId)) return replayCreate(scope, owner.accountId, threadId, key);

        const starter = await p.store.profile(scope, { accountId: owner.accountId });
        const friends = await p.threads.friends(scope, owner.accountId, command.friendPersonIds);
        const [rootCard] = await p.conversations.cards(scope, [command.root]);
        const everyoneInvitable =
          friends.length === command.friendPersonIds.length && friends.every((friend) => invitable(friend));
        if (!starter || !everyoneInvitable || rootCard?.status !== 'available') return refuse('unavailable');

        const now = p.now();
        const lock = await p.threads.lock(scope, threadId, { create: now });
        if (!lock) return refuse('unavailable');
        const receipt = await p.store.findReceipt(lock, key);
        if (receipt.kind !== 'new') return refuse('unavailable');
        await p.store.beginReceipt(lock, key);
        const membershipId = p.newId();
        await p.threads.create(lock, {
          threadId,
          name: command.name,
          root: command.root,
          starter: { accountId: owner.accountId, membershipId },
          invited: friends.map((friend) => ({
            accountId: friend.accountId,
            membershipId: p.newId(),
            lineage: friend.lineage!,
          })),
          now,
        });
        await p.conversations.announce(
          lock,
          [
            { accountId: owner.accountId, universeId: owner.universeId },
            ...friends.map((friend) => ({ accountId: friend.accountId, universeId: friend.universeId })),
          ],
          () => p.newId(),
        );
        const acceptance = ContentThreadCreationSchema.parse({
          ...receiptBase(scope, now, command.commandId),
          operation: 'thread.create',
          thread: { threadId, membershipId, membershipRevision: 1 },
        });
        await p.store.receipt(lock, key, acceptance);
        return ok(acceptance);
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Sends a text message or a snippet. A snippet is checked against the exact current revision
     * (Reel range inside the duration, passage on a stable block with its quote, block settings from
     * the block's own declarations, personal values only with confirmation); the message and its anchor
     * commit together. A reply names a message of this same thread; anything else is refused. Sending is
     * not consumption evidence for anyone.
     */
    send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadMessageAcceptanceSchema>>> {
      const parsed = SendThreadMessageSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-send',
        command,
        request: command,
        acceptance: ThreadMessageAcceptanceSchema,
        async decide(context) {
          const { scope, entered, now } = context;
          const body = command.body;
          const snippet = body.kind === 'snippet' ? await checkSnippet(scope, entered.thread, body) : undefined;
          if (snippet?.kind === 'refused') return snippet;
          const reply = await resolveReplyTarget(
            p.conversations,
            entered.lock,
            entered.thread.threadId,
            command.replyTo,
          );
          if (reply.kind === 'refused') return reply;
          return ok({
            write: async () => {
              const messageId = p.newId();
              const stored = await p.conversations.append(entered.lock, entered.thread.threadId, {
                messageId,
                commandId: command.commandId,
                authorAccountId: entered.owner.accountId,
                recordedAt: now,
                ...(reply.value === undefined ? {} : { replyToSequence: reply.value }),
                ...(body.kind === 'text'
                  ? { text: body.text }
                  : { content: body.target, ...(body.note === undefined ? {} : { note: body.note }) }),
              });
              if (snippet?.kind === 'ok') await p.threads.saveSnippet(entered.lock, messageId, snippet.value);
              return ThreadMessageAcceptanceSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'thread.send',
                thread: threadRefOf(entered),
                messageId,
                messageSequence: stored.sequence,
                sent: body.kind === 'text' ? { kind: 'text' } : { kind: 'snippet', anchor: body.anchor.kind },
              });
            },
            announce: takingPart(entered),
          });
        },
      });
    },

    /**
     * Puts one of the five reactions on a message of this thread, or takes it off. The wanted state is the
     * command, so a repeat is accepted without a change; a change gives the message a fresh change number
     * and every participant's inbox hears of it. Not consumption evidence for anyone.
     */
    react(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadReactionAcceptanceSchema>>> {
      const parsed = ReactToThreadMessageSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-react',
        command,
        request: command,
        acceptance: ThreadReactionAcceptanceSchema,
        async decide(context) {
          const { scope, entered, now } = context;
          const plan = await planReaction(p.conversations, entered.lock, {
            conversationId: entered.thread.threadId,
            messageId: command.messageId,
            accountId: entered.owner.accountId,
            kind: command.kind,
            present: command.present,
            now,
          });
          if (plan.kind === 'refused') return plan;
          return ok({
            write: async () => {
              if (plan.value.changed) await plan.value.apply();
              return ThreadReactionAcceptanceSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'thread.react',
                thread: threadRefOf(entered),
                messageId: command.messageId,
                kind: command.kind,
                present: command.present,
                changed: plan.value.changed,
              });
            },
            announce: plan.value.changed ? takingPart(entered) : [],
          });
        },
      });
    },

    /**
     * Joins or declines. Joining makes the history readable and tells the other participants' inboxes
     * (their list of people changed); declining ends the invitation and tells only the caller's own.
     */
    respond(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadInvitationResponseAcceptanceSchema>>> {
      const parsed = RespondToThreadInvitationSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-respond',
        command,
        request: command,
        acceptance: ThreadInvitationResponseAcceptanceSchema,
        entry: 'participant_or_invitee',
        decide(context) {
          const { scope, entered, now } = context;
          if (!entered.own.pending) return Promise.resolve(refuse('unavailable'));
          return Promise.resolve(
            ok({
              write: async () => {
                await p.threads.respond(entered.lock, entered.owner.accountId, command.response, now);
                return ThreadInvitationResponseAcceptanceSchema.parse({
                  ...receiptBase(scope, now, command.commandId),
                  operation: 'thread.respond',
                  response: command.response,
                  thread: threadRefOf(entered),
                });
              },
              announce: command.response === 'join' ? participants(entered) : [inboxOf(entered.own)],
            }),
          );
        },
      });
    },

    /** Moves the caller's private read position forward; it never moves back or past the newest message. */
    markRead(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadReadAcceptanceSchema>>> {
      const parsed = MarkThreadReadSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-read',
        command,
        request: command,
        acceptance: ThreadReadAcceptanceSchema,
        decide(context) {
          const { scope, entered, now } = context;
          const accepted = acceptedReadThrough(
            entered.own.readThroughSequence,
            command.throughSequence,
            entered.thread.lastSequence,
          );
          if (accepted === undefined) return Promise.resolve(refuse('invalid_input'));
          const moved = accepted !== entered.own.readThroughSequence;
          return Promise.resolve(
            ok({
              write: async () => {
                if (moved)
                  await p.conversations.setReadThrough(
                    entered.lock,
                    entered.thread.threadId,
                    entered.owner.accountId,
                    accepted,
                  );
                return ThreadReadAcceptanceSchema.parse({
                  ...receiptBase(scope, now, command.commandId),
                  operation: 'thread.read',
                  thread: threadRefOf(entered),
                  requestedThroughSequence: command.throughSequence,
                  acceptedThroughSequence: accepted,
                });
              },
              announce: moved ? [inboxOf(entered.own)] : [],
            }),
          );
        },
      });
    },

    /**
     * Ends the caller's place. The thread goes on for the others; whoever the caller invited now stands
     * on their own membership. The caller's messages stay.
     */
    leave(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadLeaveAcceptanceSchema>>> {
      const parsed = LeaveThreadSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-leave',
        command,
        request: command,
        acceptance: ThreadLeaveAcceptanceSchema,
        decide(context) {
          const { scope, entered, now } = context;
          return Promise.resolve(
            ok({
              write: async () => {
                await p.threads.leave(entered.lock, entered.owner.accountId, now);
                return ThreadLeaveAcceptanceSchema.parse({
                  ...receiptBase(scope, now, command.commandId),
                  operation: 'thread.leave',
                  thread: threadRefOf(entered),
                });
              },
              announce: participants(entered),
            }),
          );
        },
      });
    },
  };
}
