import type { ScenarioParent } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ThreadVisit } from '../../social/public.js';
import { ROOT_PARENT, type ParentFacts } from '../domain/exploration.js';
import type { ScenarioPorts } from './ports.js';

export type ParentLookup =
  | {
      readonly kind: 'found';
      readonly facts: ParentFacts & { readonly title?: string; readonly lens?: string };
      readonly nodeId?: string;
    }
  /** The member saw another revision of the parent. */
  | { readonly kind: 'stale' }
  /** No such parent in this thread, or one that cannot be continued. */
  | { readonly kind: 'missing' };

/**
 * What a request continues: the thread root at the revision the member saw, or a ready node of this
 * thread at the revision they saw. A branch is continued from a Scroll that exists, so a node that is
 * preparing, failed or removed is `missing`; a parent that moved since is `stale` (blueprint §14
 * "parent revision checks").
 */
export async function parentFactsOf(
  p: ScenarioPorts,
  scope: PersonalScopeTx,
  visit: ThreadVisit,
  parent: ScenarioParent,
): Promise<ParentLookup> {
  if (parent.kind === 'root')
    return parent.assetRevision === visit.root.assetRevision
      ? { kind: 'found', facts: ROOT_PARENT }
      : { kind: 'stale' };
  const node = await p.store.readNode(scope, parent.nodeId);
  if (node?.threadId !== visit.threadId || node.status === 'removed') return { kind: 'missing' };
  // A branch is continued from a Scroll that exists.
  if (node.status !== 'ready') return { kind: 'missing' };
  if (node.revision !== parent.revision) return { kind: 'stale' };
  return {
    kind: 'found',
    nodeId: node.nodeId,
    facts: {
      hypothetical: node.hypothetical,
      speculative: node.speculative,
      assumptions: node.assumptions,
      title: node.title,
    },
  };
}
