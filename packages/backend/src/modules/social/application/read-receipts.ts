import { OwnReadReceiptsSchema, ReadReceiptsAcceptanceSchema, SetReadReceiptsSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { increment } from '../domain/friends.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';

type ReadAnswer = z.infer<typeof OwnReadReceiptsSchema>;
type Acceptance = z.infer<typeof ReadReceiptsAcceptanceSchema>;

/**
 * The caller's own SEEN switch (D-066, D-150). It is on until the caller turns it off. Reading writes
 * nothing and creates no evidence. Own authority only, so nobody else can read it.
 */
export function makeReadOwnReadReceipts(p: SocialPorts) {
  return async (authority: PersonalAuthority): Promise<Result<ReadAnswer>> => {
    const result = await p.withScope(authority, async (scope): Promise<Result<ReadAnswer>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const stored = await p.visibility.settings(scope, gate.owner.accountId);
      return {
        kind: 'ok',
        value: OwnReadReceiptsSchema.parse({
          ...ownEnvelope(scope),
          readReceiptsRevision: stored.readStateRevision,
          shared: stored.shareReadState,
        }),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}

/**
 * Turns SEEN on or off for the caller. The wanted state is the command, so a repeat is accepted with no
 * change and no new revision.
 *
 * Authority: the caller's own account, under their personal root. Effects: the settings row and the command
 * receipt. The read position itself is not touched (it keeps moving for the caller's own unread dot), and
 * nobody is told: the other person's screen follows at its next read, because a conversation read decides
 * each time whether both people share. No model call, no queue work, no evidence.
 * Retry: the same command ID with the same body replays the first answer; a stale expected revision is
 * `stale_revision` and the client rereads.
 */
export function makeSetReadReceipts(p: SocialPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<Result<Acceptance>> => {
    const parsed = SetReadReceiptsSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const result = await p.withScope(authority, async (scope): Promise<Result<Acceptance>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const accountId = gate.owner.accountId;
      const operation = 'social.read-receipts-set';
      const key = {
        commandId: command.commandId,
        operation,
        outcomeVersion: 1,
        requestHash: p.hash(operation, command),
      };
      const receipt = await p.store.findReceipt(scope, key);
      if (receipt.kind === 'refused') return receipt;
      if (receipt.kind === 'replay')
        return {
          kind: 'ok',
          value: ReadReceiptsAcceptanceSchema.parse({
            ...ReadReceiptsAcceptanceSchema.parse(receipt.outcome),
            replayed: true,
          }),
        };
      const stored = await p.visibility.settings(scope, accountId);
      if (stored.readStateRevision !== command.expectedReadReceiptsRevision) return refuse('stale_revision');
      const changed = stored.shareReadState !== command.shared;
      const readStateRevision = changed ? increment(stored.readStateRevision) : stored.readStateRevision;
      await p.store.beginReceipt(scope, key);
      if (changed)
        await p.visibility.saveSettings(scope, accountId, {
          ...stored,
          shareReadState: command.shared,
          readStateRevision,
        });
      const value = ReadReceiptsAcceptanceSchema.parse({
        ...ownEnvelope(scope),
        commandId: command.commandId,
        recordedAt: p.now().toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'read-receipts.set',
        baseReadReceiptsRevision: stored.readStateRevision,
        acceptedReadReceiptsRevision: readStateRevision,
      });
      await p.store.receipt(scope, key, value);
      return { kind: 'ok', value };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
