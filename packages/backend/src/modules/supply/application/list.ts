import { ContentRequestListSchema, type CreateContentRequest } from '@knowscroll/contracts';
import { conceptLabel } from '../../content/public.js';
import { snapshot } from './inventory.js';
import type { Demand, ListRequests, SupplyPorts } from './ports.js';

/** At most this many of the newest asks: a person's recent asks, not a history. */
export const LIST_LIMIT = 20;

function formatOf(command: CreateContentRequest): 'reel' | 'scroll' | 'either' {
  return command.intent.kind === 'topic' ? command.intent.format : command.intent.to;
}

/** The most a list title may hold (the contract's bound); a longer title is cut, never refused. */
const TITLE_LIMIT = 160;

/** The person's own words, the catalogue topic they chose, or the Scroll that is ready: never an internal brief. */
function titleOf(d: Demand): string {
  const { intent } = d.command;
  const title = d.content
    ? d.content.metadata.title
    : intent.kind === 'variant'
      ? `The same explanation as a ${intent.to === 'reel' ? 'Reel' : 'Scroll'}`
      : intent.subject.kind === 'text'
        ? intent.subject.text.trim()
        : conceptLabel(intent.subject.topicId, intent.subject.facetId);
  return title.slice(0, TITLE_LIMIT);
}

/**
 * The person's own asks, newest first, each with the same current status a single read gives (E07's
 * requests sheet). A request the Planner made is not listed. Read only: it creates no work, advances
 * no revision and sends no hint.
 */
export function makeListRequests(p: SupplyPorts): ListRequests {
  return async (authority) => {
    const result = await p.withScope(authority, async (scope) => {
      const requests = [];
      for (const d of await p.store.listPersonDemands(scope, LIST_LIMIT))
        requests.push({ title: titleOf(d), format: formatOf(d.command), status: await snapshot(p, scope, d) });
      return ContentRequestListSchema.parse({ version: 'content-request-list.v1', requests });
    });
    return result.kind === 'entered'
      ? { kind: 'ok', value: result.value }
      : { kind: 'refused', reason: 'scope_refused' };
  };
}
