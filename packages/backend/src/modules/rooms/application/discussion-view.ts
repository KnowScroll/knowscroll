import {
  AI_INHABITANT_LABELS,
  type PublicPersonRef,
  type RoomMessage,
  type ThreadEpisode,
} from '@knowscroll/contracts';
import type { SequenceUnit, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { snippetCard } from '../../social/public.js';
import { nameOf, type CastMember } from '../domain/cast.js';
import type { AiLevel } from '../domain/membership.js';
import type { AskedFor, ContentCard, ContentRef, MessageRow, RoomLock, RoomPorts, TopicTag } from './ports.js';

const keyOf = (ref: ContentRef) => `${ref.assetId}:${String(ref.assetRevision)}`;

/** A message nobody can read any more: a deleted account's, kept so the numbering stays whole. */
const isTombstone = (row: MessageRow): boolean =>
  row.authorAccountId === null &&
  row.inhabitant === null &&
  row.text === null &&
  row.content === null &&
  row.topicDiscussionId === null;

/** Who is reading, as far as the shape of a message depends on it. */
export interface Reader {
  /** A moderator can still review a blocked author's words. */
  readonly moderator: boolean;
  /** Their AI level: Off receives no words of a resident that spoke on its own. */
  readonly aiLevel: AiLevel;
  /** The room's cast, for the names residents go by. */
  readonly cast: readonly CastMember[];
}

/** What a page of messages needs besides the rows, read once for the whole page. */
export interface ViewLookups {
  readonly authors: ReadonlyMap<string, PublicPersonRef>;
  readonly snippets: ReadonlyMap<string, StoredSnippetAnchor>;
  readonly cards: ReadonlyMap<string, ContentCard>;
  /** Accounts the reader blocked. */
  readonly blocked: ReadonlySet<string>;
  /** For a resident's message that answered an ask: what was asked. */
  readonly asks: ReadonlyMap<string, AskedFor>;
  /** The topics that cards of the page name. */
  readonly topics: ReadonlyMap<string, { readonly title: string; readonly tag: TopicTag | null }>;
  /** The messages of the page the reader marked Useful. */
  readonly useful: ReadonlySet<string>;
}

/**
 * The wire form of one stored message. A hidden message is a marker with its place and number; a
 * tombstone is a different marker; an AI contribution carries its fixed label and kind and never
 * a person's identity. A person's message whose author cannot be named (no profile) reads as a
 * tombstone, never as an invented author. A card message without its anchor row reads as a plain card.
 * A message by someone the reader has blocked is a marker for the reader: D-051 keeps a room open to the
 * blocked person, but the blocker never has to read them. A moderator who blocked the author still gets the
 * words, flagged `blockedByYou`, because moderating needs them: the client keeps them collapsed until asked.
 * A resident's message carries its name and, when it spoke on its own, why; for a reader whose AI level is Off
 * it is a `muted` marker with no words, and for Quieter it is `folded` (an asked contribution always shows in full).
 */
export function viewRoomMessage(row: MessageRow, lookups: ViewLookups, reader: Reader): RoomMessage {
  const { authors, snippets, cards, blocked } = lookups;
  const identity = { messageId: row.messageId, sequence: row.sequence };
  if (row.hidden) return { ...identity, status: 'removed' };
  if (isTombstone(row)) return { ...identity, status: 'unavailable' };
  // A person the reader has blocked: their words are collapsed for this reader and for no one else. A
  // moderator still has to be able to moderate them, so they get the words, flagged for the client to keep collapsed.
  const blockedAuthor = row.authorAccountId !== null && blocked.has(row.authorAccountId);
  if (blockedAuthor && !reader.moderator) return { ...identity, status: 'blocked' };
  const base = {
    ...identity,
    status: 'available' as const,
    recordedAt: row.recordedAt.toISOString(),
    ...(blockedAuthor ? { blockedByYou: true as const } : {}),
    ...(lookups.useful.has(row.messageId) ? { usefulByYou: true as const } : {}),
  };
  if (row.inhabitant !== null && row.aiKind !== null && row.text !== null) {
    if (row.trigger !== null && reader.aiLevel === 'off') return { ...identity, status: 'muted' };
    const asked = lookups.asks.get(row.messageId);
    const askerId = asked?.byAccountId ?? undefined;
    // A person the reader blocked is left out of "asked by", as everywhere in a room (D-051).
    const asker = askerId === undefined || blocked.has(askerId) ? undefined : authors.get(askerId);
    return {
      ...base,
      author: {
        kind: 'ai',
        inhabitant: row.inhabitant,
        name: nameOf(reader.cast, row.inhabitant),
        label: AI_INHABITANT_LABELS[row.inhabitant],
      },
      body: { kind: 'text', text: row.text },
      suggestion: row.aiKind,
      ...(row.trigger === null ? {} : { trigger: row.trigger }),
      ...(asked === undefined
        ? {}
        : {
            ask: {
              kind: asked.kind,
              ...(asker === undefined ? {} : { by: asker }),
              ...(asked.aboutMessageId === null ? {} : { about: asked.aboutMessageId }),
            },
          }),
      ...(row.trigger !== null && reader.aiLevel === 'quieter' ? { folded: true as const } : {}),
    };
  }
  const author = row.authorAccountId === null ? undefined : authors.get(row.authorAccountId);
  if (author === undefined) return { ...identity, status: 'unavailable' };
  if (row.text !== null) return { ...base, author, body: { kind: 'text', text: row.text } };
  if (row.topicDiscussionId !== null) {
    const topic = lookups.topics.get(row.topicDiscussionId);
    return topic === undefined
      ? { ...identity, status: 'unavailable' }
      : {
          ...base,
          author,
          body: {
            kind: 'topic',
            topic: {
              discussionId: row.topicDiscussionId,
              title: topic.title,
              ...(topic.tag === null ? {} : { tag: topic.tag }),
            },
          },
        };
  }
  if (row.content === null) return { ...identity, status: 'unavailable' };
  const content = cards.get(keyOf(row.content)) ?? { status: 'unavailable' as const, target: row.content };
  const note = row.note === null ? {} : { note: row.note };
  const anchor = snippets.get(row.messageId);
  return anchor === undefined
    ? { ...base, author, body: { kind: 'content', content, ...note } }
    : { ...base, author, body: { kind: 'snippet', snippet: snippetCard(anchor, content), ...note } };
}

/** Views a page of messages, reading every distinct author, card, snippet anchor, ask and topic once. */
export async function viewRoomMessages(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  rows: readonly MessageRow[],
  viewer: Reader & { readonly accountId: string },
): Promise<RoomMessage[]> {
  const shown = rows.filter((row) => !row.hidden);
  const withContent = shown.filter((row) => row.content !== null);
  const snippets = await p.discussions.snippetsOf(
    lock,
    withContent.map((row) => row.messageId),
  );
  const refs = new Map(withContent.map((row) => [keyOf(row.content!), row.content!]));
  const cards = refs.size === 0 ? [] : await p.readContent(scope, [...refs.values()]);
  const asks = await p.ai.askedFor(
    lock,
    shown.filter((row) => row.inhabitant !== null && row.trigger === null).map((row) => row.messageId),
  );
  const authorIds = [
    ...new Set([
      ...shown.flatMap((row) => (row.authorAccountId === null ? [] : [row.authorAccountId])),
      ...[...asks.values()].flatMap((asked) => (asked.byAccountId === null ? [] : [asked.byAccountId])),
    ]),
  ];
  const authors =
    authorIds.length === 0 ? new Map<string, PublicPersonRef>() : await p.people.byAccounts(scope, authorIds);
  const blocked = authorIds.length === 0 ? new Set<string>() : await p.blocked(scope, viewer.accountId, authorIds);
  const topics = new Map<string, { title: string; tag: TopicTag | null }>();
  for (const id of new Set(shown.flatMap((row) => (row.topicDiscussionId === null ? [] : [row.topicDiscussionId])))) {
    const discussion = await p.discussions.load(lock, id);
    if (discussion !== undefined) topics.set(id, { title: discussion.title, tag: discussion.tag });
  }
  const useful = await p.discussions.usefulAmong(
    lock,
    viewer.accountId,
    shown.map((row) => row.messageId),
  );
  const lookups: ViewLookups = {
    authors,
    snippets,
    cards: new Map(cards.map((card) => [keyOf(card.target), card])),
    blocked,
    asks,
    topics,
    useful,
  };
  return rows.map((row) => viewRoomMessage(row, lookups, viewer));
}

function episodeOf(
  unit: SequenceUnit,
  card: ContentCard | undefined,
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
 * The discussion's episodes: the declared series its root belongs to, by part, or the root alone.
 * `visited` is the caller's own history only (they activated that content); it says nothing of what
 * another member has seen and is never a grade. A unit that is corrected or withdrawn says so;
 * nothing is substituted for it.
 */
export async function discussionEpisodes(
  p: RoomPorts,
  scope: PersonalScopeTx,
  root: ContentRef,
): Promise<
  { sequence: { kind: 'single' } | { kind: 'series'; total: number }; episodes: ThreadEpisode[] } | undefined
> {
  const sequence = await p.readSequence(scope, root);
  if (sequence === undefined) return undefined;
  const units = sequence.kind === 'single' ? [sequence.unit] : sequence.units;
  const cards = await p.readContent(scope, units);
  const byKey = new Map(cards.map((card) => [keyOf(card.target), card]));
  const visited = await p.readVisited(scope, [...new Set(units.map((unit) => unit.assetId))]);
  const inSeries = sequence.kind === 'series';
  return {
    sequence: inSeries ? { kind: 'series', total: units.length } : { kind: 'single' },
    episodes: units.map((unit) => episodeOf(unit, byKey.get(keyOf(unit)), visited, inSeries)),
  };
}
