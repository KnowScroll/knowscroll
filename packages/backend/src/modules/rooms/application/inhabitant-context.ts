import { AI_INHABITANT_LABELS } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { pointedKind } from '../domain/asks.js';
import { CONTEXT_MESSAGES } from '../domain/contribution.js';
import { KEPT_OUT_MESSAGE, KEPT_OUT_TOPIC } from '../domain/membership.js';
import type { ContextMessage, ContributionMaterial } from './inhabitant-role.js';
import type {
  AiTurnRow,
  ContentCard,
  ContentRef,
  DiscussionRow,
  MessageRow,
  RoomLock,
  RoomPorts,
  RoomRow,
} from './ports.js';

const keyOf = (ref: ContentRef) => `${ref.assetId}:${String(ref.assetRevision)}`;

const titleOf = (card: ContentCard | undefined): { title: string; summary: string | undefined } | undefined => {
  const metadata =
    card?.status === 'available' ? card.metadata : card?.status === 'corrected' ? card.current.metadata : undefined;
  return metadata === undefined ? undefined : { title: metadata.title, summary: metadata.summary || undefined };
};

const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
};

/** One shown message reduced to words and a speaker, and whether its author keeps their messages out of what AI reads. */
export interface ReducedMessage {
  readonly row: MessageRow;
  readonly message: ContextMessage;
  /** The words are `KEPT_OUT_MESSAGE`: the author's own were never read into the material. */
  readonly keptOut: boolean;
}

/** The reduced messages, with who keeps out and the cards read for them. */
export interface ReducedWindow {
  readonly messages: readonly ReducedMessage[];
  /** Of the authors and `also` accounts looked at, those who keep their messages out of what AI reads. */
  readonly keptOut: ReadonlySet<string>;
  readonly cardOf: ReadonlyMap<string, ContentCard>;
}

/**
 * Reduces stored messages to what a model may read, the one way every context path does it (D-161): a hidden
 * message and anything without words (a deleted account's, a topic card) is left out; a member who keeps their
 * messages out has each message replaced by `KEPT_OUT_MESSAGE` before any item is built, so their words, their
 * note and the title of what they shared are never read into the material. A message keeps its place and its
 * speaker number ("Member 1", in order of first appearance); an AI message is its label. No name, handle, ID,
 * reading position or hidden message reaches the model. `also` names accounts whose keep-out choice the caller
 * needs too (the starter of a discussion, whose own typing the title is), and `refs` content cards it needs read.
 */
export async function reduceMessages(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  rows: readonly MessageRow[],
  extra: { readonly also: readonly string[]; readonly refs: readonly ContentRef[] },
): Promise<ReducedWindow> {
  const shown = rows.filter((row) => !row.hidden && (row.text !== null || row.content !== null));
  const keptOut = await p.rooms.keepOutAmong(lock, [
    ...shown.flatMap((row) => (row.authorAccountId === null ? [] : [row.authorAccountId])),
    ...extra.also,
  ]);
  const isKeptOut = (row: MessageRow): boolean => row.authorAccountId !== null && keptOut.has(row.authorAccountId);
  const readable = shown.filter((row) => !isKeptOut(row));
  const snippets = await p.discussions.snippetsOf(
    lock,
    readable.filter((row) => row.content !== null).map((row) => row.messageId),
  );
  const refs = new Map<string, ContentRef>();
  for (const ref of extra.refs) refs.set(keyOf(ref), ref);
  for (const row of readable) if (row.content !== null) refs.set(keyOf(row.content), row.content);
  const cards = refs.size === 0 ? [] : await p.readContent(scope, [...refs.values()]);
  const cardOf = new Map(cards.map((card) => [keyOf(card.target), card]));

  const members = new Map<string, number>();
  const speakerOf = (accountId: string | null, inhabitantLabel: string | undefined): string => {
    if (inhabitantLabel !== undefined) return inhabitantLabel;
    if (accountId === null) return 'Member';
    if (!members.has(accountId)) members.set(accountId, members.size + 1);
    return `Member ${String(members.get(accountId))}`;
  };
  const messages = shown.map((row): ReducedMessage => {
    const speaker = speakerOf(
      row.authorAccountId,
      row.inhabitant === null ? undefined : AI_INHABITANT_LABELS[row.inhabitant],
    );
    if (isKeptOut(row)) return { row, message: { speaker, text: KEPT_OUT_MESSAGE }, keptOut: true };
    if (row.text !== null) return { row, message: { speaker, text: row.text }, keptOut: false };
    const about = titleOf(cardOf.get(keyOf(row.content!)))?.title ?? 'content that is no longer available';
    const anchor = snippets.get(row.messageId);
    const shared =
      anchor?.kind === 'reel_range'
        ? `shared the moment ${clock(anchor.startMs)}–${clock(anchor.endMs)} of "${about}"`
        : anchor?.kind === 'scroll_passage'
          ? `shared a passage of "${about}": "${anchor.quote.slice(0, 200)}"`
          : anchor?.kind === 'scroll_block'
            ? `shared a part of "${about}"`
            : `shared "${about}"`;
    return { row, message: { speaker, text: row.note === null ? shared : `${shared}. ${row.note}` }, keptOut: false };
  });
  return { messages, keptOut, cardOf };
}

/**
 * Whether a discussion's title is not to be read: it is the starter's own typing, and a topic that began from a message
 * is titled with that message's first words unless the starter changed them. So the title is held back when the
 * starter or the author of that message keeps their messages out, or when that message has been removed (D-161, D-167).
 */
export function titleWithheld(
  keptOut: ReadonlySet<string>,
  facts: {
    readonly startedBy: string | null;
    readonly originAuthor: string | null;
    readonly originHidden: boolean;
  },
): boolean {
  return (
    facts.originHidden ||
    (facts.startedBy !== null && keptOut.has(facts.startedBy)) ||
    (facts.originAuthor !== null && keptOut.has(facts.originAuthor))
  );
}

/**
 * What an inhabitant may read to answer one turn, asked or unprompted: the room's name, topic and guidelines, the
 * discussion's title, the content it is about (title and summary) and its newest messages, reduced to words
 * (`reduceMessages`). A topic that began from a message reads that message first, as its first item. The material
 * comes from this room's own rows only: a friend conversation or thread, however related the topic, is never read here.
 *
 * The title of a discussion is the starter's own typing, so it is replaced by `KEPT_OUT_TOPIC` when the starter keeps
 * out. Nothing else a member types reaches a context item: the room's name, topic and guidelines are the operator's,
 * the content's title and summary are the library's, and polls, pins and reports are never read.
 *
 * Every context path goes through here, so keep-out holds for them all (D-161). `focus` is the message a turn is
 * about (the one an unprompted turn answers, or a pointed ask names); `material.focus` is its number in the material (it is
 * read by id when it is older than the newest messages), or none when it is gone or its author keeps their messages
 * out, in which case there is nothing to answer.
 */
export async function assembleMaterial(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  parts: {
    readonly turn: AiTurnRow;
    readonly room: RoomRow;
    readonly discussion: DiscussionRow;
    readonly focus?: string;
  },
): Promise<ContributionMaterial> {
  const { turn, room, discussion } = parts;
  const rows = await p.discussions.messages(lock, discussion.discussionId, {
    limit: CONTEXT_MESSAGES,
    ...(discussion.lastSequence > 0 ? { before: discussion.lastSequence + 1 } : {}),
  });
  const originRow =
    discussion.originMessageId === null || discussion.root !== null
      ? undefined
      : await p.discussions.messageInRoom(lock, discussion.originMessageId);
  const origin = originRow?.message;
  // A question begins with its own first message, which the newest messages already hold: it is read once, and its title, which is
  // those same words, is not read as a second copy of them.
  const originIsOwn = originRow?.discussionId === discussion.discussionId;
  const originInRows = origin !== undefined && originIsOwn && rows.some((row) => row.messageId === origin.messageId);
  // The message a turn is about may have scrolled out of the newest window (a pointed ask at an old message, or more
  // than a window of talk before the job ran). It is read by id and goes through the same reducer, so keep-out and
  // removal apply to it as to every other message.
  const focusRow =
    parts.focus === undefined || origin?.messageId === parts.focus || rows.some((row) => row.messageId === parts.focus)
      ? undefined
      : await p.discussions.messageById(lock, discussion.discussionId, parts.focus);
  const before = [originInRows ? undefined : origin, focusRow].filter((row) => row !== undefined);
  const reduced = await reduceMessages(p, scope, lock, [...before, ...rows], {
    also: [discussion.startedByAccountId, origin?.authorAccountId ?? null].filter((id) => id !== null),
    refs: discussion.root === null ? [] : [discussion.root],
  });
  const root = discussion.root === null ? undefined : titleOf(reduced.cardOf.get(keyOf(discussion.root)));
  const topic = CONCEPTS.find((concept) => concept.id === room.topic.id);
  const focusAt =
    parts.focus === undefined ? -1 : reduced.messages.findIndex((entry) => entry.row.messageId === parts.focus);
  const focusable = focusAt >= 0 && !reduced.messages[focusAt]!.keptOut;
  return {
    turnId: turn.turnId,
    ...(focusable ? { focus: focusAt + 1 } : {}),
    ...(pointedKind(turn.askKind) === undefined ? {} : { asked: pointedKind(turn.askKind) }),
    roomName: room.name,
    topicMeaning: topic?.meaning,
    guidelines: room.guidelines ?? undefined,
    discussionTitle: titleWithheld(reduced.keptOut, {
      startedBy: discussion.startedByAccountId,
      originAuthor: origin?.authorAccountId ?? null,
      originHidden: origin?.hidden ?? false,
    })
      ? KEPT_OUT_TOPIC
      : originInRows && discussion.titleDerived
        ? undefined
        : discussion.title,
    content: root,
    messages: reduced.messages.map((entry) => entry.message),
  };
}
