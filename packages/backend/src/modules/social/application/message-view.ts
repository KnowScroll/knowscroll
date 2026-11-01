import type { ChallengeCard, ConversationMessage } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ContentCard, ContentRef, ConversationPorts, MessageRow } from './conversation-ports.js';
import { readChallengeCards } from './challenge-cards.js';
import { extrasOf, readExtras, type ExtrasContext, type MessageExtras } from './message-extras.js';
import type { SharedLock } from './ports.js';

const keyOf = (ref: ContentRef) => `${ref.assetId}:${String(ref.assetRevision)}`;

/**
 * The wire form of one stored message. A row without an author or body is a tombstone: it keeps
 * its place and number and shows nothing else. A card whose content could not be read is shown as
 * unavailable, never as an empty card. Reactions and the quote of a reply come with `extras`, and the card of a
 * challenge with `challenges` (D-245): only a card whose content is available carries one.
 */
export function viewMessage(
  row: MessageRow,
  cards: ReadonlyMap<string, ContentCard>,
  extras?: MessageExtras,
  challenges?: ReadonlyMap<number, ChallengeCard>,
): ConversationMessage {
  const identity = { messageId: row.messageId, sequence: row.sequence };
  if (row.author === null || (row.text === null && row.content === null)) return { ...identity, status: 'unavailable' };
  const base = {
    ...identity,
    status: 'available' as const,
    author: row.author,
    recordedAt: row.recordedAt.toISOString(),
    ...extrasOf(row, extras),
  };
  if (row.text !== null) return { ...base, body: { kind: 'text', text: row.text } };
  const content = row.content!;
  const card = cards.get(keyOf(content)) ?? { status: 'unavailable' as const, target: content };
  const challenge = card.status === 'unavailable' ? undefined : challenges?.get(row.sequence);
  return {
    ...base,
    body: {
      kind: 'content',
      content: card,
      ...(row.note === null ? {} : { note: row.note }),
      ...(challenge === undefined ? {} : { challenge }),
    },
  };
}

/**
 * Views a page of messages, reading the cards of every distinct shared content once. With a `context`
 * (one conversation, and who reads it) the page also carries reactions and reply quotes; the inbox's
 * last messages are viewed without it.
 */
export async function viewMessages(
  p: ConversationPorts,
  scope: PersonalScopeTx | SharedLock,
  rows: readonly MessageRow[],
  context?: ExtrasContext,
): Promise<ConversationMessage[]> {
  const refs = new Map<string, ContentRef>();
  for (const row of rows) if (row.content !== null) refs.set(keyOf(row.content), row.content);
  const cards = refs.size === 0 ? [] : await p.conversations.cards(scope, [...refs.values()]);
  const byKey = new Map(cards.map((card) => [keyOf(card.target), card]));
  const extras = context === undefined ? undefined : await readExtras(p.conversations, scope, context, rows);
  const challenges =
    context === undefined
      ? undefined
      : await readChallengeCards(p, scope, context.conversationId, context.viewerAccountId, rows);
  return rows.map((row) => viewMessage(row, byKey, extras, challenges));
}
