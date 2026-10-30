import {
  MESSAGE_REACTION_KINDS,
  type MessageQuote,
  type MessageReactionKind,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import type { ConversationReader, ConversationStore, MessageRow, QuoteRow } from './conversation-ports.js';

/** The longest quote shown above a reply: the first words of the original. */
const QUOTE_PREVIEW_LENGTH = 120;

type Reactions = { kind: MessageReactionKind; mine: boolean; people: PublicPersonRef[] }[];

/** What a page of messages carries beyond the messages themselves: reactions and the quote of each reply. */
export interface MessageExtras {
  readonly reactions: ReadonlyMap<number, Reactions>;
  readonly quotes: ReadonlyMap<number, QuoteRow>;
}

/** Whose conversation the rows are from and who reads them: reactions are masked for the reader. */
export interface ExtrasContext {
  readonly conversationId: string;
  readonly viewerAccountId: string;
}

/**
 * The reactions on, and the originals quoted by, one page of messages of one conversation, in two
 * reads however many messages there are. Reactions of people the reader blocked are left out here, so
 * no view can show them; reading changes nothing.
 */
export async function readExtras(
  store: ConversationStore,
  reader: ConversationReader,
  context: ExtrasContext,
  rows: readonly MessageRow[],
): Promise<MessageExtras> {
  const available = rows.filter((row) => row.author !== null);
  const [reactionRows, quoteRows] = await Promise.all([
    store.reactionsOf(
      reader,
      context.conversationId,
      available.map((row) => row.sequence),
      context.viewerAccountId,
    ),
    store.quotesOf(
      reader,
      context.conversationId,
      available.flatMap((row) => (row.replyToSequence === null ? [] : [row.replyToSequence])),
    ),
  ]);
  const reactions = new Map<number, Reactions>();
  for (const kind of MESSAGE_REACTION_KINDS) {
    for (const row of reactionRows.filter((candidate) => candidate.kind === kind)) {
      const forMessage = reactions.get(row.sequence) ?? [];
      const group = forMessage.find((entry) => entry.kind === kind);
      if (group === undefined)
        forMessage.push({ kind, mine: row.accountId === context.viewerAccountId, people: [row.person] });
      else {
        group.people.push(row.person);
        group.mine ||= row.accountId === context.viewerAccountId;
      }
      reactions.set(row.sequence, forMessage);
    }
  }
  return { reactions, quotes: new Map(quoteRows.map((row) => [row.sequence, row])) };
}

const previewOf = (row: QuoteRow): string => {
  const words = (row.text ?? row.note ?? '').replace(/\s+/gu, ' ').trim();
  const letters = [...words];
  return letters.length <= QUOTE_PREVIEW_LENGTH ? words : `${letters.slice(0, QUOTE_PREVIEW_LENGTH - 1).join('')}…`;
};

function quoteOf(replyToSequence: number, extras: MessageExtras): MessageQuote | undefined {
  const row = extras.quotes.get(replyToSequence);
  if (row === undefined) return undefined;
  const original =
    row.author === null
      ? ({ status: 'unavailable' } as const)
      : ({ status: 'available', author: row.author, preview: previewOf(row) } as const);
  return { messageId: row.messageId, sequence: row.sequence, original };
}

/** The `reactions` and `replyTo` fields of one available message; none for a plain message or a page read without extras. */
export function extrasOf(
  row: MessageRow,
  extras: MessageExtras | undefined,
): { reactions?: Reactions; replyTo?: MessageQuote } {
  if (extras === undefined) return {};
  const reactions = extras.reactions.get(row.sequence);
  const replyTo = row.replyToSequence === null ? undefined : quoteOf(row.replyToSequence, extras);
  return { ...(reactions === undefined ? {} : { reactions }), ...(replyTo === undefined ? {} : { replyTo }) };
}
