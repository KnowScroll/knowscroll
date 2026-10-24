import { AI_INHABITANT_LABELS } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { CONTEXT_MESSAGES } from '../domain/contribution.js';
import type { ContextMessage, ContributionMaterial } from './inhabitant-role.js';
import type { AiRequestRow, ContentCard, ContentRef, DiscussionRow, RoomLock, RoomPorts, Standing } from './ports.js';

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

/**
 * What an inhabitant may read to answer one ask: the room's name, topic and guidelines, the
 * discussion's title, the content it is about (title and summary) and its newest messages, reduced
 * to words. Speakers are numbered in order of first appearance ("Member 1"); no name, handle, ID,
 * reading position or hidden message reaches the model. The material comes from this room's own rows
 * only: a friend conversation or thread, however related the topic, is never read here.
 */
export async function assembleMaterial(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  parts: { readonly request: AiRequestRow; readonly standing: Standing; readonly discussion: DiscussionRow },
): Promise<ContributionMaterial> {
  const { request, standing, discussion } = parts;
  const rows = await p.discussions.messages(lock, discussion.discussionId, {
    limit: CONTEXT_MESSAGES,
    ...(discussion.lastSequence > 0 ? { before: discussion.lastSequence + 1 } : {}),
  });
  const shown = rows.filter((row) => !row.hidden && (row.text !== null || row.content !== null));
  const snippets = await p.discussions.snippetsOf(
    lock,
    shown.filter((row) => row.content !== null).map((row) => row.messageId),
  );
  const refs = new Map<string, ContentRef>();
  if (discussion.root !== null) refs.set(keyOf(discussion.root), discussion.root);
  for (const row of shown) if (row.content !== null) refs.set(keyOf(row.content), row.content);
  const cards = refs.size === 0 ? [] : await p.readContent(scope, [...refs.values()]);
  const cardOf = new Map(cards.map((card) => [keyOf(card.target), card]));

  const members = new Map<string, number>();
  const speakerOf = (accountId: string | null, inhabitantLabel: string | undefined): string => {
    if (inhabitantLabel !== undefined) return inhabitantLabel;
    if (accountId === null) return 'Member';
    if (!members.has(accountId)) members.set(accountId, members.size + 1);
    return `Member ${String(members.get(accountId))}`;
  };
  const messages = shown.map((row): ContextMessage => {
    const speaker = speakerOf(
      row.authorAccountId,
      row.inhabitant === null ? undefined : AI_INHABITANT_LABELS[row.inhabitant],
    );
    if (row.text !== null) return { speaker, text: row.text };
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
    return { speaker, text: row.note === null ? shared : `${shared}. ${row.note}` };
  });
  const root = discussion.root === null ? undefined : titleOf(cardOf.get(keyOf(discussion.root)));
  const topic = CONCEPTS.find((concept) => concept.id === standing.room.topic.id);
  return {
    requestId: request.requestId,
    roomName: standing.room.name,
    topicMeaning: topic?.meaning,
    guidelines: standing.room.guidelines ?? undefined,
    discussionTitle: discussion.title,
    content: root,
    messages,
  };
}
