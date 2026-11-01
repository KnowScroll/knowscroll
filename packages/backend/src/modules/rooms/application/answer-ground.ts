import {
  isAbout,
  sharedStems,
  splitSentences,
  type LibraryPassageSource,
  type ReadLibraryPassages,
} from '../../content/public.js';
import {
  GROUND_MAX_PASSAGES,
  GROUND_MAX_PER_ASSET,
  GROUND_PASSAGE_CHARS,
  handleOf,
  type GroundPassage,
} from '../domain/answer-support.js';
import { KEPT_OUT_MESSAGE, KEPT_OUT_TOPIC } from '../domain/membership.js';
import type { ContributionMaterial } from './inhabitant-role.js';
import type { RoomRow } from './ports.js';

/**
 * The library passages a resident may rest an answer on (D-298): read from admitted library Scrolls under the room's topic and
 * chosen by code for the words being answered. Reads shared public content outside every transaction; nothing here names a
 * person, a room or a message to the library.
 */
export type ReadGround = (topic: RoomRow['topic'], about: string) => Promise<readonly GroundPassage[]>;

/** How many Scrolls of the topic one answer looks through. */
const SCROLLS_READ = 100;

/** How many messages before the one being answered are read as its context ("Why?" means what the message before it asked). */
const CONTEXT_BEFORE_FOCUS = 2;
/** How many of the newest messages are read when the ask points at none. */
const NEWEST_WHEN_PLAIN = 3;

const isPlaceholder = (text: string): boolean => text === KEPT_OUT_MESSAGE || text === KEPT_OUT_TOPIC;

/**
 * The words a question is matched against: the discussion's title, the title of the content it is about, the message being
 * answered and the few before it (or the newest few when the ask points at no message). Keep-out has already replaced a kept-out
 * member's words by a placeholder, and a placeholder says nothing about a subject, so it is left out.
 */
export function aboutText(
  material: Pick<ContributionMaterial, 'discussionTitle' | 'content' | 'messages' | 'focus'>,
): string {
  const focusAt = material.focus === undefined ? undefined : material.focus - 1;
  const read =
    focusAt === undefined
      ? material.messages.slice(-NEWEST_WHEN_PLAIN)
      : material.messages.slice(Math.max(0, focusAt - CONTEXT_BEFORE_FOCUS), focusAt + 1);
  return [material.discussionTitle, material.content?.title, ...read.map((message) => message.text)]
    .filter((text): text is string => text !== undefined && text !== '' && !isPlaceholder(text))
    .join('\n');
}

/**
 * The stretch of a stop's own sentences, at most `GROUND_PASSAGE_CHARS` characters, that fits `about` best: the sentence that
 * shares the most key words with it, grown towards its neighbours while there is room. A stop that fits whole is kept whole.
 * The words are the stop's own, in order and unchanged, so a quote of them is in the stop.
 */
export function windowOf(stop: string, about: string): string {
  if (stop.length <= GROUND_PASSAGE_CHARS) return stop;
  const sentences = splitSentences(stop);
  if (sentences.length === 0) return '';
  let best = 0;
  let bestScore = -1;
  sentences.forEach((sentence, index) => {
    const score = sharedStems(sentence, about);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  let from = best;
  let to = best;
  let length = sentences[best]!.length;
  for (let grow = true; grow;) {
    grow = false;
    for (const next of [to + 1, from - 1]) {
      const sentence = sentences[next];
      if (sentence === undefined || length + 1 + sentence.length > GROUND_PASSAGE_CHARS) continue;
      if (next > to) to = next;
      else from = next;
      length += 1 + sentence.length;
      grow = true;
    }
  }
  const window = sentences.slice(from, to + 1).join(' ');
  return window.length <= GROUND_PASSAGE_CHARS ? window : window.slice(0, GROUND_PASSAGE_CHARS).trimEnd();
}

interface Candidate {
  readonly source: LibraryPassageSource;
  readonly blockId: string;
  readonly text: string;
  readonly score: number;
  readonly order: number;
}

/**
 * The passages of these Scrolls that fit `about`, best first, as a resident is offered them: a stop counts when its best stretch
 * shares key words with the question (`isAbout`, and at least one), the best scores come first with the Scrolls' and the stops'
 * own order breaking a tie, no Scroll gives more than `GROUND_MAX_PER_ASSET`, and at most `GROUND_MAX_PASSAGES` in all.
 * Deterministic: the same library and the same words choose the same passages, which a redelivered job relies on.
 */
export function chooseGround(sources: readonly LibraryPassageSource[], about: string): readonly GroundPassage[] {
  const candidates: Candidate[] = [];
  let order = 0;
  for (const source of sources)
    for (const block of source.blocks) {
      const text = windowOf(block.text, about);
      const score = sharedStems(text, about);
      order += 1;
      if (score >= 1 && isAbout(text, about)) candidates.push({ source, blockId: block.blockId, text, score, order });
    }
  candidates.sort((first, second) => second.score - first.score || first.order - second.order);
  const perAsset = new Map<string, number>();
  const chosen: GroundPassage[] = [];
  for (const candidate of candidates) {
    const taken = perAsset.get(candidate.source.assetId) ?? 0;
    if (taken >= GROUND_MAX_PER_ASSET) continue;
    perAsset.set(candidate.source.assetId, taken + 1);
    chosen.push({
      handle: handleOf(chosen.length),
      assetId: candidate.source.assetId,
      assetRevision: candidate.source.assetRevision,
      blockId: candidate.blockId,
      text: candidate.text,
    });
    if (chosen.length === GROUND_MAX_PASSAGES) break;
  }
  return chosen;
}

/** The ground reader over the library's prose read (`ReadLibraryPassages`). The read is shared content and happens outside any transaction. */
export const makeReadGround =
  (readPassages: ReadLibraryPassages): ReadGround =>
  async (topic, about) =>
    about.trim() === '' ? [] : chooseGround(await readPassages(topic, SCROLLS_READ), about);
