import type {
  ConversationContentProjectionSchema,
  SnippetCard,
  ThreadEpisode,
  ThreadMessage,
  ThreadParticipant,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { SequenceUnit, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { isParticipant } from '../domain/threads.js';
import type { ContentRef, MessageRow } from './conversation-ports.js';
import { extrasOf, readExtras, type ExtrasContext, type MessageExtras } from './message-extras.js';
import type { SharedLock } from './ports.js';
import type { LoadedThread, ThreadMember, ThreadPorts, ThreadLock } from './thread-ports.js';

type Card = z.infer<typeof ConversationContentProjectionSchema>;

const keyOf = (ref: ContentRef) => `${ref.assetId}:${String(ref.assetRevision)}`;

/**
 * A snippet as a card: the stored anchor and the content's current state. A quote, a block's label
 * and its settings description are copied from the exact revision, so they are shown only while the
 * content is not withdrawn: a card inherits its source's availability.
 */
export function snippetCard(anchor: StoredSnippetAnchor, content: Card): SnippetCard {
  const shown = content.status !== 'unavailable';
  switch (anchor.kind) {
    case 'reel_range':
      return { kind: 'reel_range', startMs: anchor.startMs, endMs: anchor.endMs, content };
    case 'scroll_passage':
      return {
        kind: 'scroll_passage',
        blockId: anchor.blockId,
        ...(shown ? { quote: anchor.quote } : {}),
        content,
      };
    case 'scroll_block':
      return {
        kind: 'scroll_block',
        blockId: anchor.blockId,
        blockType: anchor.blockType,
        ...(shown && anchor.label !== '' ? { label: anchor.label } : {}),
        settings:
          anchor.settings === undefined
            ? { included: false }
            : {
                included: true,
                ...(shown && anchor.settings.description !== '' ? { description: anchor.settings.description } : {}),
                personalIncluded: anchor.settings.snapshot.personalIncluded,
              },
        content,
      };
  }
}

/**
 * The wire form of one stored thread message. A row without an author or body is a tombstone: it
 * keeps its place and number and shows nothing else. A content message without its snippet row can
 * only mean a broken invariant and reads as a tombstone, never as a card with an invented anchor.
 */
export function viewThreadMessage(
  row: MessageRow,
  snippets: ReadonlyMap<string, StoredSnippetAnchor>,
  cards: ReadonlyMap<string, Card>,
  extras?: MessageExtras,
): ThreadMessage {
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
  const anchor = snippets.get(row.messageId);
  if (row.content === null || anchor === undefined) return { ...identity, status: 'unavailable' };
  const content = cards.get(keyOf(row.content)) ?? { status: 'unavailable' as const, target: row.content };
  return {
    ...base,
    body: { kind: 'snippet', snippet: snippetCard(anchor, content), ...(row.note === null ? {} : { note: row.note }) },
  };
}

/**
 * Views a page of thread messages, reading every distinct card and snippet anchor once. With a
 * `context` (the thread, and who reads it) the page also carries reactions and reply quotes; the thread
 * list's last messages are viewed without it.
 */
export async function viewThreadMessages(
  p: ThreadPorts,
  reader: ThreadLock | PersonalScopeTx,
  rows: readonly MessageRow[],
  context?: ExtrasContext,
): Promise<ThreadMessage[]> {
  const withContent = rows.filter((row) => row.content !== null);
  const snippets = await p.threads.snippetsOf(
    reader,
    withContent.map((row) => row.messageId),
  );
  const refs = new Map(withContent.map((row) => [keyOf(row.content!), row.content!]));
  const cards = refs.size === 0 ? [] : await p.conversations.cards(reader, [...refs.values()]);
  const byKey = new Map(cards.map((card) => [keyOf(card.target), card]));
  const extras = context === undefined ? undefined : await readExtras(p.conversations, reader, context, rows);
  return rows.map((row) => viewThreadMessage(row, snippets, byKey, extras));
}

/** Who shows as a participant: members whose place stands, the starter marked, the caller flagged. */
export function participantsOf(loaded: LoadedThread): ThreadParticipant[] {
  return loaded.members.filter(isParticipant).map((member: ThreadMember) => ({
    person: member.person,
    role: member.accountId === loaded.thread.starterAccountId ? 'starter' : 'member',
    joined: !member.pending,
    you: member.accountId === loaded.own.accountId,
  }));
}

function episodeOf(
  unit: SequenceUnit,
  card: Card | undefined,
  visited: ReadonlySet<string>,
  inSeries: boolean,
): ThreadEpisode {
  const metadata =
    card?.status === 'available' ? card.metadata : card?.status === 'corrected' ? card.current.metadata : undefined;
  return {
    assetId: unit.assetId,
    assetRevision: unit.assetRevision,
    kind: unit.kind,
    ...(inSeries && unit.part !== undefined ? { part: unit.part } : {}),
    title: metadata?.title ?? 'No longer available',
    state: card?.status === 'available' ? 'ready' : card?.status === 'corrected' ? 'corrected' : 'unavailable',
    visited: visited.has(unit.assetId),
  };
}

/**
 * The thread's episodes: the declared series the root belongs to, by part, or the root alone. `visited`
 * is the caller's own history only (they activated that content); it says nothing of what another
 * member has seen and is never a grade. A unit that is corrected or withdrawn says so; nothing is
 * substituted for it.
 */
export async function threadEpisodes(
  p: ThreadPorts,
  scope: PersonalScopeTx | SharedLock,
  root: ContentRef,
): Promise<
  { sequence: { kind: 'single' } | { kind: 'series'; total: number }; episodes: ThreadEpisode[] } | undefined
> {
  const personal = 'shared' in scope ? scope.shared.personal : scope;
  const sequence = await p.readSequence(personal, root);
  if (sequence === undefined) return undefined;
  const units = sequence.kind === 'single' ? [sequence.unit] : sequence.units;
  const cards = await p.conversations.cards(scope, units);
  const byKey = new Map(cards.map((card) => [keyOf(card.target), card]));
  const visited = await p.readVisited(personal, [...new Set(units.map((unit) => unit.assetId))]);
  const inSeries = sequence.kind === 'series';
  return {
    sequence: inSeries ? { kind: 'series', total: units.length } : { kind: 'single' },
    episodes: units.map((unit) => episodeOf(unit, byKey.get(keyOf(unit)), visited, inSeries)),
  };
}
