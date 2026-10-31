import { ASK_QUESTION_MAX } from '@knowscroll/contracts';

/** The counter appears only near the limit (D1): a form's "0/280" is what the design took away. */
export const COUNTER_FROM = ASK_QUESTION_MAX - 40;

/**
 * "usually about 2 min": the time ask orders measured, in the words a person would say, or nothing. The server sends a
 * time only from five finished orders, so there is nothing to invent here: no time, no phrase.
 */
export function usuallyPhrase(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 90) return 'usually about a minute';
  return `usually about ${String(Math.round(seconds / 60))} min`;
}

/**
 * What the Scroll is called in "A short Scroll · about …": the title up to its first colon, cut at a word. The design
 * names a topic ("about Seasons"); the reader knows only the title, so the line names that.
 */
export function aboutTitle(title: string): string {
  const head = (title.split(':')[0] ?? title).trim();
  if (head.length <= 32) return head;
  return `${head.slice(0, 31).replace(/\s+\S*$/u, '')}…`;
}

/** Why an ask from here is off while recording is paused (D-083), in the person's words. */
export const PAUSED_COPY =
  "Asking from a Scroll is off while recording is paused, because it uses what you've read. Turn recording back on in Settings to ask.";
