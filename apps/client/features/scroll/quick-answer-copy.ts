import type { QuickAnswerCard, QuickAnswerUnavailable } from '@knowscroll/client-core';
import type { QuickAnswerView } from '@knowscroll/ui';

/**
 * What a Quick answer card says when there is no answer (V3 D2, D-253). Plain sentences that name nothing of how the
 * answer is made: no prompt, no model, no count of how many are left. A full Scroll is offered wherever it can help; it
 * is not while recording is paused, because a full Scroll is made from what was read (D-231), and not for a wait that is
 * a moment's.
 */
const UNAVAILABLE: Readonly<
  Record<QuickAnswerUnavailable, { readonly message: string; readonly canMakeScroll: boolean }>
> = {
  paused: {
    message:
      'Quick answers are off while recording is paused, because they are made from what you are reading. Turn recording back on to use them.',
    canMakeScroll: false,
  },
  not_available: { message: 'Quick answers are not available right now.', canMakeScroll: true },
  person_limit: { message: 'You have used today’s Quick answers. They come back tomorrow.', canMakeScroll: true },
  too_many_open: {
    message: 'A few Quick answers are still on their way. Try again in a moment.',
    canMakeScroll: false,
  },
  could_not_answer: { message: 'We couldn’t answer that one.', canMakeScroll: true },
  offline: { message: 'KnowScroll couldn’t be reached. Check your connection and ask again.', canMakeScroll: false },
};

/** The card as the screen draws it. `askAvailable` is whether this screen can open Ask from here at all. */
export function quickAnswerViewOf(card: QuickAnswerCard, askAvailable: boolean): QuickAnswerView {
  switch (card.phase) {
    case 'sending':
    case 'waiting':
      return { phase: 'working', canMakeScroll: false };
    case 'answered':
      return {
        phase: 'answered',
        question: card.question,
        answer: card.answer,
        covered: card.covered,
        canMakeScroll: askAvailable,
      };
    case 'unavailable':
      return {
        phase: 'unavailable',
        message: UNAVAILABLE[card.reason].message,
        canMakeScroll: askAvailable && UNAVAILABLE[card.reason].canMakeScroll,
      };
  }
}
