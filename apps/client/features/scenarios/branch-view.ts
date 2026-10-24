import type { ContentThreadState, ScenarioBoardState } from '@knowscroll/client-core';
import type { ScenarioCard } from '@knowscroll/contracts';

/**
 * What a branch's own address shows, from what was read, and nothing the member could not know:
 * - `loading`: the thread or its branches are still being read.
 * - `thread_unavailable`: the thread is not theirs to open (not a member, ended, an invitation not yet joined).
 * - `failed`: a read did not arrive; it says so and offers to try again, and says nothing of the branch.
 * - `missing`: the branches were read and this one is not among them. It is unknown, or not theirs; the screen
 *   cannot tell which, and does not say.
 * - `removed`: the branch is there and was removed. Only this says "removed".
 * - `preparing`, `branch_failed`, `ready`: the branch, by its card.
 */
export type BranchView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'thread_unavailable' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'removed' }
  | { readonly kind: 'preparing'; readonly card: ScenarioCard }
  | { readonly kind: 'branch_failed'; readonly card: ScenarioCard }
  | {
      readonly kind: 'ready';
      readonly card: ScenarioCard & { readonly content: NonNullable<ScenarioCard['content']> };
    };

export function branchViewOf(
  thread: ContentThreadState['phase'],
  board: ScenarioBoardState['phase'],
  card: ScenarioCard | undefined,
): BranchView {
  if (thread === 'unavailable' || thread === 'invitation' || board === 'unavailable')
    return { kind: 'thread_unavailable' };
  if (thread === 'failed' || board === 'failed') return { kind: 'failed' };
  if (thread === 'loading' || board === 'loading') return { kind: 'loading' };
  if (card === undefined) return { kind: 'missing' };
  switch (card.status) {
    case 'removed':
      return { kind: 'removed' };
    case 'preparing':
      return { kind: 'preparing', card };
    case 'failed':
      return { kind: 'branch_failed', card };
    case 'ready':
      return card.content === undefined
        ? { kind: 'preparing', card }
        : { kind: 'ready', card: { ...card, content: card.content } };
  }
}
