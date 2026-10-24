import {
  ListScenariosSchema,
  MAX_SCENARIO_CARDS,
  MAX_SCENARIO_SUGGESTIONS,
  ScenarioListSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { cardOf } from './cards.js';
import { envelope, ok, refuse, type DraftRow, type NodeRow, type Result, type ScenarioPorts } from './ports.js';

type List = z.infer<typeof ScenarioListSchema>;

/**
 * What this member was offered and has not made: each option of their open drafts, under the branch it
 * would continue. One that would continue a branch that is gone or not ready is left out, since choosing
 * it would be refused. Never anyone else's.
 */
function suggestionsOf(drafts: readonly DraftRow[], nodes: readonly NodeRow[]) {
  const ready = new Set(nodes.filter((node) => node.status === 'ready').map((node) => node.nodeId));
  return drafts
    .filter((draft) => draft.parentNodeId === undefined || ready.has(draft.parentNodeId))
    .flatMap((draft) =>
      (draft.options ?? []).map((option) => ({
        draftId: draft.draftId,
        optionId: option.optionId,
        kind: draft.kind,
        ...(draft.parentNodeId === undefined ? {} : { parentNodeId: draft.parentNodeId }),
        title: option.title,
        speculative: option.speculative,
      })),
    )
    .slice(0, MAX_SCENARIO_SUGGESTIONS);
}

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
      const drafts = await p.store.listOpenDrafts(scope, visit.self.accountId, visit.threadId, p.now());
      return ok(
        ScenarioListSchema.parse({
          ...base,
          status: 'ready',
          cards: nodes.slice(-MAX_SCENARIO_CARDS).map((node) => cardOf(node, people)),
          suggestions: suggestionsOf(drafts, nodes),
        }),
      );
    });
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}
