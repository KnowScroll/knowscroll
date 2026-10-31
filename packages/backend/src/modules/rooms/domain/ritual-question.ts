import { splitSentences, type PassageSource } from './flaw.js';
import { QuestionPayloadSchema, type QuestionPayload } from './rituals.js';

/**
 * The day's question (R3 A, D-176): a template over a library Scroll's own title and summary, in plain words. It costs no
 * model call and is never generated while someone waits; it only points at what the library already says, so a person
 * answering it is thinking about that Scroll. Pure.
 */

const PROMPT_MAX = 200;
const DETAIL_MAX = 300;

/** A title as the question quotes it: without the full stop it may end in, so the question mark that follows reads once. */
const stripEnd = (text: string): string => text.trim().replace(/[.!\s]+$/u, '');

/**
 * The question for a Scroll: a title that already asks something is the question itself; any other is a claim to explain
 * to a friend. The detail is the first sentence of the Scroll's summary when it is short enough to read at a glance.
 * Nothing is made when the words would not fit the shown bounds.
 */
export function questionFrom(
  source: Pick<PassageSource, 'assetId' | 'assetRevision' | 'title' | 'summary'>,
): QuestionPayload | undefined {
  const title = stripEnd(source.title);
  if (title.length === 0) return undefined;
  const prompt = title.endsWith('?') ? title : `How would you explain this to a friend: “${title}”?`;
  if (prompt.length > PROMPT_MAX) return undefined;
  const first = splitSentences(source.summary.trim())[0]?.text;
  const detail = first !== undefined && first.length <= DETAIL_MAX ? first : undefined;
  return QuestionPayloadSchema.parse({
    prompt,
    ...(detail === undefined ? {} : { detail }),
    source: { assetId: source.assetId, assetRevision: source.assetRevision },
  });
}

/** The Scrolls a room may be asked about today: those the room has not used lately, unless all of them were. */
export function chooseQuestionSource<T extends Pick<PassageSource, 'assetId'>>(
  sources: readonly T[],
  seed: number,
  avoid: ReadonlySet<string>,
): T | undefined {
  const fresh = sources.filter((source) => !avoid.has(source.assetId));
  const pool = fresh.length > 0 ? fresh : sources;
  return pool.length === 0 ? undefined : pool[seed % pool.length];
}
