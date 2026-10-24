import { ListScenariosSchema, ScenarioListSchema, MAX_SCENARIO_CARDS } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { cardOf } from './cards.js';
import { envelope, ok, refuse, type Result, type ScenarioPorts } from './ports.js';

type List = z.infer<typeof ScenarioListSchema>;

/**
 * The thread's branches as cards, oldest first. Membership is checked on every read, so a member
 * who left, or was never in the thread, gets `unavailable` and nothing about the branches. A card
 * names who started a branch only while that person still takes part; it never names where anyone is.
 */
export function makeListScenarios(p: ScenarioPorts) {
  return async function listScenarios(authority: PersonalAuthority, input: unknown): Promise<Result<List>> {
    const parsed = ListScenariosSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const query = parsed.data;
    const entered = await p.withScope(authority, async (scope): Promise<Result<List>> => {
      const base = { ...envelope(scope), readId: query.readId };
      const visit = await p.guest.enter(scope, query.thread, 'read');
      if (!visit) return ok(ScenarioListSchema.parse({ ...base, status: 'unavailable' }));
      const people = new Map(visit.participants.map((participant) => [participant.accountId, participant.person]));
      const nodes = await p.store.listNodes(scope, visit.threadId);
      return ok(
        ScenarioListSchema.parse({
          ...base,
          status: 'ready',
          cards: nodes.slice(-MAX_SCENARIO_CARDS).map((node) => cardOf(node, people)),
        }),
      );
    });
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}
