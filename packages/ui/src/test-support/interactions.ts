import { blockInteractionPayload, findBlock, type ScrollDocument } from '@knowscroll/scroll-model';

/**
 * What the recorder would reject. The recorder builds each `scroll.block_interaction` with the
 * package's `blockInteractionPayload` (which returns null for a kind the block type does not
 * declare), so every interaction a renderer reports must pass it for the block it names: the
 * block exists, `blockType` is its type, and `kind` is one of its type's `INTERACTION_KINDS`.
 */
export function interactionProblems(
  watcher: { readonly onBlockInteraction: jest.Mock },
  document: ScrollDocument,
): string[] {
  const problems: string[] = [];
  for (const [event] of watcher.onBlockInteraction.mock.calls as [
    { blockId: string; blockType: string; kind: string },
  ][]) {
    const visit = findBlock(document, event.blockId);
    if (visit === null) problems.push(`${event.blockId}: no such block`);
    else if (visit.block.type !== event.blockType)
      problems.push(`${event.blockId}: ${event.blockType} is not its type`);
    else if (blockInteractionPayload(visit.block, event.kind) === null) {
      problems.push(`${event.blockId}: ${event.blockType} does not declare ${event.kind}`);
    }
  }
  return problems;
}
