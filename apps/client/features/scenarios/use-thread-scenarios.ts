import { useState } from 'react';
import type { ScenarioBoardController } from '@knowscroll/client-core';
import type { ScenarioCard, ScenarioKind, ScenarioSuggestion } from '@knowscroll/contracts';
import { quoteOf, type AvailableMessage } from './message-step';
import type { ScenarioStart } from './scenario-start';

/**
 * Where What if… and Another perspective start in one open thread: the whole thread, a message (or
 * a snippet card), or a branch that is ready. It holds only what the sheet needs to open; the branches
 * themselves are the board's, and nothing here asks the server anything.
 */
export function useThreadScenarios(options: {
  readonly board: ScenarioBoardController;
  /** The thread's branches as last read: an offer continues one of them, and carries its premises into the form. */
  readonly cards: readonly ScenarioCard[];
  /** The exact revision of the thread's root: what a request from the thread or a message continues. */
  readonly rootRevision: number | undefined;
  /** A branch was started and the cards are read again: show it. */
  readonly onBranchStarted: () => void;
}) {
  const { board, cards, rootRevision, onBranchStarted } = options;
  const [start, setStart] = useState<ScenarioStart>();
  const fromRoot = (rootAt: number) => ({ kind: 'root' as const, assetRevision: rootAt });
  return {
    start,
    close: () => setStart(undefined),
    askFromRoot: (kind: ScenarioKind) => {
      if (rootRevision === undefined) return;
      setStart({
        kind,
        origin: { kind: 'root' },
        fromLabel: 'the whole thread',
        parent: fromRoot(rootRevision),
        premises: [],
      });
    },
    /** From a message's menu (no kind yet: the sheet asks) or straight from a snippet card's What if…. */
    askFromMessage: (message: AvailableMessage, kind?: ScenarioKind) => {
      if (rootRevision === undefined) return;
      setStart({
        ...(kind === undefined ? { quote: quoteOf(message) } : { kind }),
        origin: { kind: 'message', messageId: message.messageId },
        fromLabel:
          message.body.kind === 'snippet' ? 'a shared moment or passage' : `${message.author.displayName}’s message`,
        parent: fromRoot(rootRevision),
        premises: [],
      });
    },
    /**
     * A what-if on top of a ready branch: it inherits that branch's premises, which the form lists. With
     * `words` (the prompt at the end of a branch) the member's idea is already written and the sheet goes
     * straight to asking for directions.
     */
    continueBranch: (card: ScenarioCard, words?: string) =>
      setStart({
        kind: 'what_if',
        origin: { kind: 'root' },
        fromLabel: 'this branch',
        parent: { kind: 'node', nodeId: card.nodeId, revision: card.revision },
        premises: card.assumptions,
        ...(words === undefined ? {} : { words }),
      }),
    /** A direction the member was offered and has not made: the sheet picks its draft up and shows its options. */
    openOffer: (offer: ScenarioSuggestion) =>
      setStart({
        offer: { draftId: offer.draftId, kind: offer.kind },
        premises: cards.find((card) => card.nodeId === offer.parentNodeId)?.assumptions ?? [],
      }),
    removeBranch: (card: ScenarioCard) => void board.remove(card),
    branchStarted: () => void board.load().then(onBranchStarted),
  };
}
