import type { ContentThreadRef } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { InboxChange } from './conversation-ports.js';
import { refuse, threadEnvelope, type Result } from './ports.js';
import { canTakePart, isParticipant } from '../domain/threads.js';
import { enterThread, type EnteredThread, type Entry } from './thread-gate.js';
import type { ThreadMember, ThreadPorts } from './thread-ports.js';

export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

export const inboxOf = (member: ThreadMember): InboxChange => ({
  accountId: member.accountId,
  universeId: member.universeId,
});
/** Every member who takes part now: whose inbox hears of a change that all of them can see. */
export const takingPart = (entered: EnteredThread): readonly InboxChange[] =>
  entered.members.filter(canTakePart).map(inboxOf);
/** Every member whose place stands, invited or joined. */
export const participants = (entered: EnteredThread): readonly InboxChange[] =>
  entered.members.filter(isParticipant).map(inboxOf);

/** What a command decided: the writes to make (they return the acceptance) and whose inbox changes. */
export interface Decision<A> {
  readonly write: () => Promise<A>;
  readonly announce: readonly InboxChange[];
}

export interface CommandContext {
  readonly scope: PersonalScopeTx;
  readonly entered: EnteredThread;
  readonly now: Date;
}

/**
 * The skeleton every command that acts inside one existing thread shares: the caller's personal scope,
 * the thread's lock order, the receipt, the writes and the inbox hints, committed together. A retry with
 * the same command and body returns the first acceptance after current authority is checked again; the
 * same command with another body is refused. A refusal writes no receipt.
 */
export function makeThreadCommandFrame(p: ThreadPorts) {
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

  return { receiptKey, receiptBase, inThread };
}
