import type { ChallengeCard } from '@knowscroll/contracts';
import type { ScrollCallFacts } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { viewChallenge, type ChallengeView } from '../domain/challenges.js';
import type { ChallengeCall, ConversationPorts, ConversationReader, MessageRow } from './conversation-ports.js';

/** The personal scope inside a reader, where content's read of a revision runs. */
const personalOf = (reader: ConversationReader): PersonalScopeTx =>
  'shared' in reader ? reader.shared.personal : reader;

/** What a challenge card is about and what it may show of it, read from the immutable revision (never from a pick). */
export function cardOf(call: ScrollCallFacts, view: ChallengeView): ChallengeCard {
  const base = { stopId: call.stopId, prompt: call.prompt, options: [...call.options] };
  switch (view.stage) {
    case 'open':
      return { ...base, stage: 'open' };
    case 'locked':
      return { ...base, stage: 'locked', option: view.option };
    case 'revealed':
      return {
        ...base,
        stage: 'revealed',
        option: view.option,
        theirs: view.theirs,
        answer: call.answer,
        explain: call.explain,
        ...(view.option === call.answer ? {} : { twist: call.twist }),
        right: view.option === call.answer,
        theirsRight: view.theirs === call.answer,
      };
  }
}

/**
 * The challenge card of each challenge message in a page, as the reader may see it, by message sequence. The question and
 * the options come from the exact revision the card names; a revision that is no longer readable, or a stop that is
 * no longer a call, gives no card, and the message shows as a plain card. Two reads however many challenges there are
 * (one per distinct revision, and one for the picks). A read writes nothing.
 */
export async function readChallengeCards(
  p: ConversationPorts,
  reader: ConversationReader,
  conversationId: string,
  viewerAccountId: string,
  rows: readonly MessageRow[],
): Promise<ReadonlyMap<number, ChallengeCard>> {
  const challenged = rows.flatMap((row) =>
    row.author !== null && row.content !== null && row.challengeStop !== null
      ? [{ sequence: row.sequence, call: callOf(row) }]
      : [],
  );
  const cards = new Map<number, ChallengeCard>();
  if (challenged.length === 0) return cards;
  const picks = await p.conversations.picksOf(
    reader,
    conversationId,
    challenged.map((entry) => entry.call),
  );
  const facts = new Map<string, Awaited<ReturnType<ConversationPorts['readCallFacts']>>>();
  for (const { sequence, call } of challenged) {
    const key = `${call.assetId}:${String(call.revision)}`;
    if (!facts.has(key)) facts.set(key, await p.readCallFacts(personalOf(reader), call.assetId, call.revision));
    const found = facts.get(key)?.calls.find((candidate) => candidate.stopId === call.stopId);
    if (found === undefined) continue;
    const mine = picks.filter(
      (pick) => pick.assetId === call.assetId && pick.revision === call.revision && pick.stopId === call.stopId,
    );
    cards.set(sequence, cardOf(found, viewChallenge(viewerAccountId, mine)));
  }
  return cards;
}

function callOf(row: MessageRow): ChallengeCall {
  return { assetId: row.content!.assetId, revision: row.content!.assetRevision, stopId: row.challengeStop! };
}
