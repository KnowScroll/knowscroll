import { RemoveScenarioSchema, ScenarioRemovalAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { envelope, ok, refuse, type Result, type ScenarioPorts } from './ports.js';

type Acceptance = z.infer<typeof ScenarioRemovalAcceptanceSchema>;

/**
 * Takes a branch off the thread's cards. Only the member who started it can, at the revision they
 * saw; the Scroll is not deleted and production, if it is running, is not recalled. A removed branch
 * can be asked for again. The same command returns the same answer.
 */
export function makeRemoveScenario(p: ScenarioPorts) {
  return async function removeScenario(authority: PersonalAuthority, input: unknown): Promise<Result<Acceptance>> {
    const parsed = RemoveScenarioSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const entered = await p.withScope(authority, async (scope): Promise<Result<Acceptance>> => {
      const visit = await p.guest.enter(scope, command.thread, 'write');
      if (!visit) return refuse('unavailable');
      const key = {
        commandId: command.commandId,
        operation: 'scenarios.remove',
        outcomeVersion: 1,
        requestHash: p.hash('scenarios.remove', { ...command, actorPrivacyEpoch: scope.authority.privacyEpoch }),
      };
      const receipt = await p.guest.receipts.find(visit, key);
      if (receipt.kind === 'refused') return refuse('command_key_reused');
      if (receipt.kind === 'replay')
        return ok({ ...ScenarioRemovalAcceptanceSchema.parse(receipt.outcome), replayed: true });
      const node = await p.store.lockNode(scope, command.nodeId);
      if (
        node?.threadId !== visit.threadId ||
        node.startedByAccountId !== visit.self.accountId ||
        node.status === 'removed'
      )
        return refuse('unavailable');
      if (node.revision !== command.revision) return refuse('stale_revision');
      await p.guest.receipts.begin(visit, key);
      const removed = await p.store.removeNode(scope, node.nodeId);
      await p.guest.announce(visit);
      const acceptance = ScenarioRemovalAcceptanceSchema.parse({
        ...envelope(scope),
        commandId: command.commandId,
        recordedAt: p.now().toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'scenario.remove',
        nodeId: removed.nodeId,
        revision: removed.revision,
      });
      await p.guest.receipts.complete(visit, key, acceptance);
      return ok(acceptance);
    });
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}
