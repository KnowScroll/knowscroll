import {
  AI_INHABITANT_LABELS,
  type PublicPersonRef,
  type RoomMessage,
  type ThreadEpisode,
} from '@knowscroll/contracts';
import type { SequenceUnit, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { snippetCard } from '../../social/public.js';
import type { ContentCard, ContentRef, MessageRow, RoomLock, RoomPorts } from './ports.js';

const keyOf = (ref: ContentRef) => `${ref.assetId}:${String(ref.assetRevision)}`;

/** A message nobody can read any more: a deleted account's, kept so the numbering stays whole. */
const isTombstone = (row: MessageRow): boolean =>
  row.authorAccountId === null && row.inhabitant === null && row.text === null && row.content === null;

/**
 * The wire form of one stored message. A hidden message is a marker with its place and number; a
 * tombstone is a different marker; an AI contribution carries its fixed label and kind and never
 * a person's identity. A person's message whose author cannot be named (no profile) reads as a
 * tombstone, never as an invented author. A card message without its anchor row reads as a plain card.
 * A message by someone the reader has blocked is a marker for the reader: D-051 keeps a room open to the
 * blocked person, but the blocker never has to read them. A moderator who blocked the author still gets the
 * words, flagged `blockedByYou`, because moderating needs them: the client keeps them collapsed until asked.
 */
export function viewRoomMessage(
  row: MessageRow,
  authors: ReadonlyMap<string, PublicPersonRef>,
  snippets: ReadonlyMap<string, StoredSnippetAnchor>,
  cards: ReadonlyMap<string, ContentCard>,
  blocked: ReadonlySet<string> = new Set(),
  moderator = false,
): RoomMessage {
  const identity = { messageId: row.messageId, sequence: row.sequence };
  if (row.hidden) return { ...identity, status: 'removed' };
  if (isTombstone(row)) return { ...identity, status: 'unavailable' };
  // A person the reader has blocked: their words are collapsed for this reader and for no one else. A
  // moderator still has to be able to moderate them, so they get the words, flagged for the client to keep collapsed.
  const blockedAuthor = row.authorAccountId !== null && blocked.has(row.authorAccountId);
  if (blockedAuthor && !moderator) return { ...identity, status: 'blocked' };
  const base = {
    ...identity,
    status: 'available' as const,
    recordedAt: row.recordedAt.toISOString(),
    ...(blockedAuthor ? { blockedByYou: true as const } : {}),
  };
  if (row.inhabitant !== null && row.aiKind !== null && row.text !== null)
    return {
      ...base,
      author: { kind: 'ai', inhabitant: row.inhabitant, label: AI_INHABITANT_LABELS[row.inhabitant] },
      body: { kind: 'text', text: row.text },
      suggestion: row.aiKind,
    };
  const author = row.authorAccountId === null ? undefined : authors.get(row.authorAccountId);
  if (author === undefined) return { ...identity, status: 'unavailable' };
  if (row.text !== null) return { ...base, author, body: { kind: 'text', text: row.text } };
  if (row.content === null) return { ...identity, status: 'unavailable' };
  const content = cards.get(keyOf(row.content)) ?? { status: 'unavailable' as const, target: row.content };
  const note = row.note === null ? {} : { note: row.note };
  const anchor = snippets.get(row.messageId);
  return anchor === undefined
    ? { ...base, author, body: { kind: 'content', content, ...note } }
    : { ...base, author, body: { kind: 'snippet', snippet: snippetCard(anchor, content), ...note } };
}

/** Views a page of messages, reading every distinct author, card and snippet anchor once. */
export async function viewRoomMessages(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  rows: readonly MessageRow[],
  viewer: { readonly accountId: string; readonly moderator: boolean },
): Promise<RoomMessage[]> {
  const shown = rows.filter((row) => !row.hidden);
  const withContent = shown.filter((row) => row.content !== null);
  const snippets = await p.discussions.snippetsOf(
    lock,
    withContent.map((row) => row.messageId),
  );
  const refs = new Map(withContent.map((row) => [keyOf(row.content!), row.content!]));
  const cards = refs.size === 0 ? [] : await p.readContent(scope, [...refs.values()]);
  const authorIds = [...new Set(shown.flatMap((row) => (row.authorAccountId === null ? [] : [row.authorAccountId])))];
  const authors =
    authorIds.length === 0 ? new Map<string, PublicPersonRef>() : await p.people.byAccounts(scope, authorIds);
  const blocked = authorIds.length === 0 ? new Set<string>() : await p.blocked(scope, viewer.accountId, authorIds);
  const byKey = new Map(cards.map((card) => [keyOf(card.target), card]));
  return rows.map((row) => viewRoomMessage(row, authors, snippets, byKey, blocked, viewer.moderator));
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
