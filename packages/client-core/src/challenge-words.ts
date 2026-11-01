import type { ChallengeCard } from '@knowscroll/contracts';
import { optionLetter } from './call-words';

type Revealed = Extract<ChallengeCard, { stage: 'revealed' }>;

/** The line under a challenge's question: where it stands for this person, in words, never a score (D-064, D-245). */
export function challengeStatusWords(card: ChallengeCard, friend: string): string {
  switch (card.stage) {
    case 'open':
      return `Call it before you see ${friend}’s. Both answers show once you have both called.`;
    case 'locked':
      return `You called ${optionLetter(card.option)}. ${friend}’s call shows once they have called too.`;
    case 'revealed':
      return `You called ${optionLetter(card.option)}. ${friend} called ${optionLetter(card.theirs)}.`;
  }
}

/**
 * What the reveal says of the person's own call: "Called it!" with a spark for a right one, "Plot twist!" for any other.
 * A wrong call is a twist, never a loss: no minus and no count of misses. The spark is shown and not stored.
 */
export function challengeRevealWords(card: Revealed): { readonly title: string; readonly spark: string | undefined } {
  return card.right ? { title: 'Called it!', spark: '+1 spark' } : { title: 'Plot twist!', spark: undefined };
}

/** The notice under a card that could not keep the person's pick, in the person's words. */
export function challengeNoticeWords(reason: 'paused' | 'failed'): { readonly lead: string; readonly message: string } {
  return reason === 'paused'
    ? {
        lead: 'Recording is paused.',
        message:
          'A call here is saved to this conversation, so it needs recording on. Turn it on in Privacy to lock it in.',
      }
    : { lead: 'Couldn’t lock it in.', message: 'Nothing was saved. Try again.' };
}
