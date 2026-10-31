import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { isModerator } from '../domain/membership.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type MemberRow, type Result, type RoomPorts } from './ports.js';

/** Who may run a command: anyone signed in, any current member, or only a moderator. */
export type Requires = 'anyone' | 'member' | 'moderator';

export interface CommandContext {
  readonly scope: PersonalScopeTx;
  readonly entered: EnteredRoom;
  /** The caller's open member row; present unless the command is for `anyone`. */
  readonly member: MemberRow | undefined;
  readonly now: Date;
}

/** What a command decided: the writes to make, which return the acceptance. */
export type Decision<A> = () => Promise<A>;

export interface CommandSpec<A extends object> {
  /** `<module>.<operation>` as the shared receipt table requires. */
  readonly operation: string;
  readonly commandId: string;
  readonly roomId: string;
  /** The parsed request; its hash is what the receipt remembers. */
  readonly request: object;
  readonly acceptance: z.ZodType<A>;
  readonly requires: Requires;
  /** `write` locks the room FOR UPDATE: commands that change who is in, the status or roles. */
  readonly mode: 'read' | 'write';
  /**
   * An answer in place of the command when the caller has not passed a gate that they may pass later (recording is paused).
   * It writes nothing, not even a receipt, so the same intent can be sent again. It is asked after a replay is ruled out,
   * so a command that was accepted still replays when the gate has closed since.
   */
  gate?(context: CommandContext): Promise<Result<A> | undefined>;
  /** Decides without writing; a refusal writes nothing, not even a receipt. */
  decide(context: CommandContext): Promise<Result<Decision<A>>>;
}

/** The fields every acceptance shares, from the caller's scope. */
export function receiptBase(scope: PersonalScopeTx, now: Date, commandId: string) {
  return {
    ...roomEnvelope(scope),
    commandId,
    recordedAt: now.toISOString(),
    replayed: false,
    outcome: 'accepted' as const,
  };
}

/**
 * The skeleton of every room command. It runs in the caller's personal scope and the room's lock:
 * personal root, own account gate, the room. Access is checked first, then the receipt: a retry
 * with the same command and body returns the first acceptance, the same command with another body is
 * refused, and a person who is no longer allowed gets `unavailable` before any replay. The writes
 * and the receipt commit together; a refusal writes neither.
 */
export async function runCommand<A extends object>(
  p: RoomPorts,
  authority: PersonalAuthority,
  spec: CommandSpec<A>,
): Promise<Result<A>> {
  const result = await p.withScope(authority, async (scope): Promise<Result<A>> => {
    const entered = await enterRoom(p, scope, spec.roomId, spec.mode);
    if (!entered) return refuse('unavailable');
    const allowed =
      spec.requires === 'anyone' ||
      (entered.member !== undefined && (spec.requires === 'member' || isModerator(entered.member.role)));
    if (!allowed) return refuse('unavailable');
    const key = {
      commandId: spec.commandId,
      operation: spec.operation,
      outcomeVersion: 1,
      requestHash: p.hash(spec.operation, { ...spec.request, actorPrivacyEpoch: scope.authority.privacyEpoch }),
    };
    const receipt = await p.rooms.findReceipt(entered.lock, key);
    if (receipt.kind === 'refused') return receipt;
    if (receipt.kind === 'replay') return ok({ ...spec.acceptance.parse(receipt.outcome), replayed: true });
    const context = { scope, entered, member: entered.member, now: p.now() };
    const gated = await spec.gate?.(context);
    if (gated !== undefined) return gated;
    const decision = await spec.decide(context);
    if (decision.kind === 'refused') return decision;
    await p.rooms.beginReceipt(entered.lock, key);
    const acceptance = await decision.value();
    await p.rooms.completeReceipt(entered.lock, key, acceptance);
    return ok(acceptance);
  });
  return result.kind === 'entered' ? result.value : refuse('unavailable');
}
