import type { AbuseCategory, ContentErrorCategory } from '@knowscroll/contracts';
import type { FeedbackTarget, ReportFlowState } from '@knowscroll/client-core';

/** The chips of "What seems wrong?" (P03 card 3), in the order drawn. */
export const CONTENT_ERROR_CHOICES: readonly { readonly value: ContentErrorCategory; readonly label: string }[] = [
  { value: 'wrong', label: 'Something’s wrong' },
  { value: 'out_of_date', label: 'Out of date' },
  { value: 'misleading', label: 'Misleading' },
  { value: 'other', label: 'Other' },
];

/** The reasons an abuse report can name. The person has to pick one. */
export const ABUSE_CHOICES: readonly { readonly value: AbuseCategory; readonly label: string }[] = [
  { value: 'harassment', label: 'Harassment' },
  { value: 'hate', label: 'Hate' },
  { value: 'sexual_content', label: 'Sexual content' },
  { value: 'violence', label: 'Violence or threats' },
  { value: 'spam', label: 'Spam' },
  { value: 'self_harm', label: 'Self-harm' },
  { value: 'other', label: 'Something else' },
];

const reasonLabels: Readonly<Record<string, string>> = Object.fromEntries(
  [...CONTENT_ERROR_CHOICES, ...ABUSE_CHOICES].map((choice) => [choice.value, choice.label]),
);

/** What a report is about, in words that name nobody: a person or message is never named in a receipt. */
export function aboutWords(target: FeedbackTarget): string {
  switch (target.kind) {
    case 'asset':
      return target.format === 'reel' ? 'a Reel' : 'a Scroll';
    case 'message':
      return 'a message';
    case 'room_message':
      return 'a message in a room';
    case 'person':
      return 'a person';
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** "today 22:11", or the date for an older one. */
export function receivedWhen(receivedAt: string, now: Date): string {
  const at = new Date(receivedAt);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === now.toDateString()) return `today ${clock}`;
  return `${at.getDate()} ${at.toLocaleString('en', { month: 'short' })} ${clock}`;
}

/** The line of the receipt (P03 card 4): "Reason: Harassment · a message · today 22:11". */
export function receiptLine(
  state: Pick<ReportFlowState, 'kind' | 'contentCategory' | 'abuseCategory' | 'receipt'>,
  target: FeedbackTarget,
  now: Date,
): string {
  const reason = state.kind === 'content_error' ? state.contentCategory : state.abuseCategory;
  const parts = [
    `Reason: ${reason === undefined ? 'not given' : (reasonLabels[reason] ?? reason)}`,
    aboutWords(target),
  ];
  if (state.receipt !== undefined) parts.push(receivedWhen(state.receipt.receivedAt, now));
  return parts.join(' · ');
}

/** What happens next, said plainly (P03 card 4). A room's moderators can see a report on a room message. */
export function whatHappensNext(kind: ReportFlowState['kind'], target: FeedbackTarget): string {
  if (kind === 'content_error') return 'Thanks — if we correct it you’ll see a Corrected tag.';
  if (target.kind === 'room_message')
    return 'Our safety team will review it. The moderators of the room can see it too. You don’t need to do anything else.';
  return 'Our safety team will review it. You don’t need to do anything else.';
}
