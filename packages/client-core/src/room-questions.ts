import {
  type QuestionAsked,
  type QuestionReply,
  type RoomQuestions,
  type RoomReplayStrip,
} from '@knowscroll/contracts';
import { launchDayWords } from './room-launch';
import { QUIET_AFTER_MS } from './room-presence';

/** How long a room must have had no person's message before it offers a replay (R3 F: "quiet 30+ min"). */
export const QUIET_OFFER_AFTER_MS = 30 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long a question waited for its answer, in the few words a notice has room for ("2 days later"). Both times are the server's,
 * so a device's clock changes nothing.
 */
export function laterWords(askedAt: string, answeredAt: string): string {
  const gap = Math.max(0, new Date(answeredAt).getTime() - new Date(askedAt).getTime());
  if (gap < HOUR) return 'a few minutes later';
  if (gap < DAY) return `${String(Math.floor(gap / HOUR))} h later`;
  const days = Math.floor(gap / DAY);
  return `${String(days)} ${days === 1 ? 'day' : 'days'} later`;
}

/** "Lena answered your question · 2 days later": a person's name from the server and nothing the device made up. */
export const questionReplyLine = (reply: Pick<QuestionReply, 'by' | 'askedAt' | 'at'>): string =>
  `${reply.by.displayName} answered your question · ${laterWords(reply.askedAt, reply.at)}`;

/** The Now strip's chip for questions that wait for a person: a real count, or nothing. */
export function questionsChip(
  questions: RoomQuestions | undefined,
): { readonly label: string; readonly detail: string } | undefined {
  if (questions === undefined || questions.waiting === 0) return undefined;
  return {
    label: 'Open',
    detail: `${String(questions.waiting)} ${questions.waiting === 1 ? 'question' : 'questions'} waiting`,
  };
}

/** What the sheet says after a question was left: whether a resident is writing, was full, could not read it, or was not asked. */
export const QUESTION_LEFT_WORDS: Record<QuestionAsked, string> = {
  queued: 'Your question is open for people. A resident is writing an answer now; it will say it is AI.',
  resting: 'Your question is open for people. The residents are resting, so no one answered it yet.',
  kept_out:
    'Your question is open for people. You keep your messages out of what AI reads, so no resident answered it.',
  not_asked: 'Your question is open for people. No resident was asked.',
};

/**
 * What the quiet room offers a person who is there alone (R3 F frame 1), in template words from the host and only when it is real: a
 * finished Launch they did not play can be replayed, and no person has written in the room for half an hour. It speaks once for a
 * night's Launch and never says anything of people who are not there. Absent when the offer was dismissed or there is nothing to
 * replay.
 */
export function quietOffer(input: {
  readonly replay: RoomReplayStrip | undefined;
  readonly lastMessageAt: string | undefined;
  readonly now: Date;
  readonly dismissed: ReadonlySet<string>;
}): { readonly key: string; readonly line: string } | undefined {
  if (input.replay === undefined || input.dismissed.has(input.replay.day)) return undefined;
  if (input.lastMessageAt !== undefined) {
    const age = input.now.getTime() - new Date(input.lastMessageAt).getTime();
    if (age < Math.max(QUIET_OFFER_AFTER_MS, QUIET_AFTER_MS)) return undefined;
  }
  return {
    key: input.replay.day,
    line: `It’s quiet here. Want a two-minute warm-up? The Launch of ${launchDayWords(input.replay.day)} can be played again against the answers the people who played it gave.`,
  };
}
