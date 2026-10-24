import {
  ConversationLeaveAcceptanceSchema,
  ConversationMessageAcceptanceSchema,
  ConversationMuteAcceptanceSchema,
  ConversationReadAcceptanceSchema,
  DirectConversationAcceptanceSchema,
  LeaveConversationSchema,
  MarkConversationReadSchema,
  MuteConversationSchema,
  SendConversationMessageSchema,
  StartDirectConversationSchema,
  type DirectConversationRef,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { acceptedReadThrough } from '../domain/conversations.js';
import { sideOf } from '../domain/friends.js';
import { enterConversation, refOf, type EnteredConversation } from './conversation-gate.js';
import type { ConversationPorts, InboxChange } from './conversation-ports.js';
import { conversationEnvelope, refuse, type PairLock, type Result } from './ports.js';

const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

/** What a command decided: the writes to make (they return the acceptance) and whose inbox changes. */
interface Decision<A> {
  readonly write: () => Promise<A>;
  readonly announce: readonly InboxChange[];
}

interface CommandContext {
  readonly scope: PersonalScopeTx;
  readonly entered: EnteredConversation;
  readonly now: Date;
}

const ownInbox = (entered: EnteredConversation): readonly InboxChange[] => [
  { accountId: entered.owner.accountId, universeId: entered.owner.universeId },
];
const both = (entered: EnteredConversation): readonly InboxChange[] => [
  ...ownInbox(entered),
  ...(entered.peerAccess === undefined
    ? []
    : [{ accountId: entered.peerAccess.accountId, universeId: entered.peerAccess.universeId }]),
];

/**
 * The commands of direct conversations: start, send, mark read, mute and leave. Each runs in the
 * caller's personal scope with the lock order of the blueprint (personal root, account gates, the
 * friendship's pair root). The receipt, the effects and the inbox hints commit together; hints go
 * out only after that commit and carry no content. A retry with the same command and body returns
 * the first acceptance, after current authority is checked again; the same command with another
 * body is refused. A refusal writes no receipt.
 */
export function makeConversationCommands(p: ConversationPorts) {
  /** Shared skeleton of every command that acts inside one existing conversation. */
  async function inConversation<A extends object>(
    authority: PersonalAuthority,
    spec: {
      readonly operation: string;
      readonly command: { readonly commandId: string; readonly conversation: DirectConversationRef };
      readonly request: object;
      readonly acceptance: z.ZodType<A>;
      decide(context: CommandContext): Promise<Result<Decision<A>>>;
    },
  ): Promise<Result<A>> {
    const result = await p.withScope(authority, async (scope): Promise<Result<A>> => {
      const entered = await enterConversation(p, scope, spec.command.conversation);
      if (!entered) return refuse('unavailable');
      const key = {
        commandId: spec.command.commandId,
        operation: spec.operation,
        outcomeVersion: 1,
        requestHash: p.hash(spec.operation, { ...spec.request, actorPrivacyEpoch: scope.authority.privacyEpoch }),
      };
      const receiptScope = entered.lock ?? scope;
      const receipt = await p.store.findReceipt(receiptScope, key);
      if (receipt.kind === 'refused') return receipt;
      if (receipt.kind === 'replay') return ok({ ...spec.acceptance.parse(receipt.outcome), replayed: true });
      const decision = await spec.decide({ scope, entered, now: p.now() });
      if (decision.kind === 'refused') return decision;
      await p.store.beginReceipt(receiptScope, key);
      const acceptance = await decision.value.write();
      await p.conversations.announce(entered.reader, decision.value.announce, () => p.newId());
      await p.store.receipt(receiptScope, key, acceptance);
      return ok(acceptance);
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  }

  const receiptBase = ({ scope, now }: CommandContext, commandId: string) => ({
    ...conversationEnvelope(scope),
    commandId,
    recordedAt: now.toISOString(),
    replayed: false,
    outcome: 'accepted' as const,
  });

  return {
    /**
     * Starts the conversation with a current friend, or returns the open one: both people get the
     * same conversation, each with their own membership reference. Nothing is announced: a
     * conversation shows in Talk once it has a message.
     */
    async start(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DirectConversationAcceptanceSchema>>> {
      const parsed = StartDirectConversationSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const command = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const candidate = await p.store.profile(scope, { personId: command.peerPersonId });
        if (!candidate || candidate.accountId === scope.authority.actor.accountId) return refuse('unavailable');
        const gate = await p.fencePair(scope, candidate.accountId);
        if (gate.kind !== 'active' || gate.peer.accountId !== candidate.accountId) return refuse('unavailable');
        const lock = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
        const lineage = lock?.pair.lineage;
        if (!lock || !lineage) return refuse('unavailable');
        if (sideOf(lock.pair, gate.owner.accountId).revision !== command.expectedPairRevision)
          return refuse('stale_revision');
        const operation = 'social.conversation-start';
        const key = {
          commandId: command.commandId,
          operation,
          outcomeVersion: 1,
          requestHash: p.hash(operation, { ...command, actorPrivacyEpoch: scope.authority.privacyEpoch }),
        };
        const receipt = await p.store.findReceipt(lock, key);
        if (receipt.kind === 'refused') return receipt;
        if (receipt.kind === 'replay')
          return ok({ ...DirectConversationAcceptanceSchema.parse(receipt.outcome), replayed: true });
        const now = p.now();
        await p.store.beginReceipt(lock, key);
        const existing = await p.conversations.findOpen(lock, lineage, gate.owner.accountId);
        const reference = existing ? refOf(existing) : await createConversation(lock, lineage, gate, now);
        const acceptance = DirectConversationAcceptanceSchema.parse({
          ...conversationEnvelope(scope),
          commandId: command.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'conversation.start',
          conversation: reference,
          peerPersonId: command.peerPersonId,
        });
        await p.store.receipt(lock, key, acceptance);
        return ok(acceptance);
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Sends a text bubble or a card for an exact content revision. A card for withdrawn or
     * missing content is refused and nothing is stored. Sending is not consumption evidence
     * for anyone: the card is metadata, and only opening and using the content is an encounter.
     */
    send(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationMessageAcceptanceSchema>>> {
      const parsed = SendConversationMessageSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inConversation(authority, {
        operation: 'social.message-send',
        command,
        request: command,
        acceptance: ConversationMessageAcceptanceSchema,
        async decide(context) {
          const { entered, now } = context;
          const { lock } = entered;
          if (lock === undefined || entered.conversation.closed) return refuse('unavailable');
          const body = command.body;
          if (body.kind === 'content') {
            const [card] = await p.conversations.cards(lock, [body.target]);
            if (!card || card.status === 'unavailable') return refuse('unavailable');
          }
          return ok({
            write: async () => {
              const messageId = p.newId();
              const stored = await p.conversations.append(lock, entered.conversation.conversationId, {
                messageId,
                commandId: command.commandId,
                authorAccountId: entered.owner.accountId,
                recordedAt: now,
                ...(body.kind === 'text'
                  ? { text: body.text }
                  : { content: body.target, ...(body.note === undefined ? {} : { note: body.note }) }),
              });
              return ConversationMessageAcceptanceSchema.parse({
                ...receiptBase(context, command.commandId),
                operation: 'message.send',
                conversation: refOf(entered),
                messageId,
                messageSequence: stored.sequence,
                sent: body.kind === 'text' ? { kind: 'text' } : { kind: 'content', target: body.target },
              });
            },
            announce: both(entered),
          });
        },
      });
    },

    /** Moves the caller's private read position forward; it never moves back or past the newest message. */
    markRead(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationReadAcceptanceSchema>>> {
      const parsed = MarkConversationReadSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inConversation(authority, {
        operation: 'social.conversation-read',
        command,
        request: command,
        acceptance: ConversationReadAcceptanceSchema,
        decide(context) {
          const { entered } = context;
          const accepted = acceptedReadThrough(
            entered.own.readThroughSequence,
            command.throughSequence,
            entered.conversation.lastSequence,
          );
          if (accepted === undefined) return Promise.resolve(refuse('invalid_input'));
          const moved = accepted !== entered.own.readThroughSequence;
          return Promise.resolve(
            ok({
              write: async () => {
                if (moved)
                  await p.conversations.setReadThrough(
                    entered.reader,
                    entered.conversation.conversationId,
                    entered.owner.accountId,
                    accepted,
                  );
                return ConversationReadAcceptanceSchema.parse({
                  ...receiptBase(context, command.commandId),
                  operation: 'conversation.read',
                  conversation: refOf(entered),
                  requestedThroughSequence: command.throughSequence,
                  acceptedThroughSequence: accepted,
                });
              },
              announce: moved ? ownInbox(entered) : [],
            }),
          );
        },
      });
    },

    /** Mutes or unmutes the conversation for the caller only. */
    mute(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationMuteAcceptanceSchema>>> {
      const parsed = MuteConversationSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inConversation(authority, {
        operation: 'social.conversation-mute',
        command,
        request: command,
        acceptance: ConversationMuteAcceptanceSchema,
        decide(context) {
          const { entered } = context;
          const changed = command.muted !== entered.own.muted;
          return Promise.resolve(
            ok({
              write: async () => {
                if (changed)
                  await p.conversations.setMuted(
                    entered.reader,
                    entered.conversation.conversationId,
                    entered.owner.accountId,
                    command.muted,
                  );
                return ConversationMuteAcceptanceSchema.parse({
                  ...receiptBase(context, command.commandId),
                  operation: 'conversation.mute',
                  conversation: refOf(entered),
                  muted: command.muted,
                });
              },
              announce: changed ? ownInbox(entered) : [],
            }),
          );
        },
      });
    },

    /**
     * Ends the caller's membership. The conversation closes: the other person keeps the history
     * they already have and can send nothing more; starting again later makes a new conversation.
     */
    leave(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationLeaveAcceptanceSchema>>> {
      const parsed = LeaveConversationSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inConversation(authority, {
        operation: 'social.conversation-leave',
        command,
        request: command,
        acceptance: ConversationLeaveAcceptanceSchema,
        decide(context) {
          const { entered, now } = context;
          return Promise.resolve(
            ok({
              write: async () => {
                await p.conversations.leave(
                  entered.reader,
                  entered.conversation.conversationId,
                  entered.owner.accountId,
                  now,
                );
                return ConversationLeaveAcceptanceSchema.parse({
                  ...receiptBase(context, command.commandId),
                  operation: 'conversation.leave',
                  conversation: refOf(entered),
                });
              },
              announce: both(entered),
            }),
          );
        },
      });
    },
  };

  async function createConversation(
    lock: PairLock,
    lineage: string,
    gate: { readonly owner: { readonly accountId: string }; readonly peer: { readonly accountId: string } },
    now: Date,
  ): Promise<DirectConversationRef> {
    const conversationId = p.newId();
    const members = [gate.owner.accountId, gate.peer.accountId].map((accountId) => ({
      accountId,
      membershipId: p.newId(),
    }));
    await p.conversations.create(lock, { conversationId, lineage, now, members });
    return { conversationId, membershipId: members[0]!.membershipId, membershipRevision: 1 };
  }
}
