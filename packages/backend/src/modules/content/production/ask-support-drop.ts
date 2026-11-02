import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { MIN_SERVED_SENTENCES, type SentenceVerdict } from '../domain/ask-support.js';
import { placedSentencesOfAnswer, type PlacedSentence, type StatementPlace } from './ask-support.js';

/**
 * Why an answer with sentences that still fail the support check cannot be served without them (D-310). Each is a code, never a
 * sentence. `title_or_dek_flagged`: the title and the dek cannot be taken out. `no_direct_answer`: no sentence of the opening
 * paragraph is supported. `too_few_supported`: fewer than {@link MIN_SERVED_SENTENCES} sentences of reading text are supported.
 * `no_limit_callout`: the limits callout did not survive. `rebuilt_invalid`: what is left is not a valid answer that reads back as
 * the sentences that were kept.
 */
export type DropRefusal =
  | 'verdicts_incomplete'
  | 'title_or_dek_flagged'
  | 'no_direct_answer'
  | 'too_few_supported'
  | 'no_limit_callout'
  | 'rebuilt_invalid';

export type DropOutcome =
  /** The answer without the sentences the check found unsupported; `dropped` counts them (a number, never their words). */
  | { readonly kind: 'kept'; readonly authored: AuthoredScroll; readonly dropped: number }
  | { readonly kind: 'refused'; readonly code: DropRefusal };

type Block = AuthoredScroll['blocks'][number];

const refused = (code: DropRefusal): DropOutcome => ({ kind: 'refused', code });

const keyOf = (place: StatementPlace): string =>
  'block' in place ? `${place.field}:${String(place.block)}:${'item' in place ? String(place.item) : ''}` : place.field;

/**
 * The answer without the sentences that failed its support check (D-310). Pure: no model, no clock.
 *
 * Every sentence whose verdict is `unsupported` is taken out of its text and the blocks are rebuilt: a block left with no sentence is
 * removed (a list left with one item becomes a paragraph), and so is a heading with nothing left in its section. The closing limits
 * callout belongs to no section. The answer is served only if
 * - the title and the dek were not flagged (they cannot be taken out),
 * - the first paragraph, the direct answer, keeps at least one supported sentence,
 * - at least {@link MIN_SERVED_SENTENCES} sentences of reading text (not a title, a heading or a callout's title) are supported,
 * - the limits callout is still the last block, and
 * - what is left is a valid answer whose sentences read back as exactly the ones that were kept, so every sentence served has the
 *   verdict it was checked with.
 *
 * @param answer the authored answer the verdicts were given for
 * @param verdicts one for each sentence of `answer` (`placedSentencesOfAnswer`)
 */
export function dropFlagged(answer: AuthoredScroll, verdicts: readonly SentenceVerdict[]): DropOutcome {
  const sentences = placedSentencesOfAnswer(answer);
  const verdictOf = new Map(verdicts.map((verdict) => [verdict.number, verdict.verdict]));
  if (sentences.some((sentence) => !verdictOf.has(sentence.number))) return refused('verdicts_incomplete');
  const flagged = new Set(
    sentences.filter((sentence) => verdictOf.get(sentence.number) === 'unsupported').map((sentence) => sentence.number),
  );
  const isFlagged = (sentence: PlacedSentence): boolean => flagged.has(sentence.number);
  if (
    sentences.some(
      (sentence) => isFlagged(sentence) && (sentence.place.field === 'title' || sentence.place.field === 'dek'),
    )
  )
    return refused('title_or_dek_flagged');

  const directAnswer = answer.blocks.findIndex((block) => block.type === 'paragraph');
  const isSupported = (sentence: PlacedSentence) => verdictOf.get(sentence.number) === 'supported';
  if (
    !sentences.some(
      (sentence) =>
        sentence.place.field === 'paragraph' && sentence.place.block === directAnswer && isSupported(sentence),
    )
  )
    return refused('no_direct_answer');
  if (sentences.filter((sentence) => sentence.label !== true && isSupported(sentence)).length < MIN_SERVED_SENTENCES)
    return refused('too_few_supported');

  const byPlace = new Map<string, PlacedSentence[]>();
  for (const sentence of sentences)
    byPlace.set(keyOf(sentence.place), [...(byPlace.get(keyOf(sentence.place)) ?? []), sentence]);
  /** The text at a place without its flagged sentences; the original string when none was flagged there. */
  const keptAt = (place: StatementPlace, original: string): string => {
    const own = byPlace.get(keyOf(place)) ?? [];
    const kept = own.filter((sentence) => !isFlagged(sentence));
    return kept.length === own.length ? original : kept.map((sentence) => sentence.text).join(' ');
  };

  const rebuilt = answer.blocks.flatMap((block, index) => {
    const next = rebuildBlock(block, index, keptAt);
    return next === undefined ? [] : [{ block: next, from: index }];
  });
  const emptied = emptiedHeadings(answer.blocks, new Set(rebuilt.map((entry) => entry.from)));
  const survivors = rebuilt.filter((entry) => !emptied.has(entry.from));
  const blocks = survivors.map((entry) => entry.block);
  const closing = blocks.at(-1);
  if (closing?.type !== 'callout' || closing.kind !== 'limit') return refused('no_limit_callout');

  const candidate = AuthoredScroll.safeParse({ title: answer.title, dek: answer.dek, blocks });
  if (!candidate.success) return refused('rebuilt_invalid');
  // A sentence not flagged is served unless the block it stood in was removed whole (a callout's title goes with its text).
  const keptBlocks = new Set(survivors.map((entry) => entry.from));
  const expected = sentences
    .filter(
      (sentence) => !isFlagged(sentence) && (!('block' in sentence.place) || keptBlocks.has(sentence.place.block)),
    )
    .map((sentence) => sentence.text);
  const actual = placedSentencesOfAnswer(candidate.data).map((sentence) => sentence.text);
  if (expected.length !== actual.length || expected.some((text, index) => text !== actual[index]))
    return refused('rebuilt_invalid');
  return { kind: 'kept', authored: candidate.data, dropped: flagged.size };
}

/** One block without its flagged sentences, or `undefined` when nothing of it is left. */
function rebuildBlock(
  block: Block,
  index: number,
  keptAt: (place: StatementPlace, original: string) => string,
): Block | undefined {
  switch (block.type) {
    case 'heading': {
      const text = keptAt({ field: 'heading', block: index }, block.text);
      return text === '' ? undefined : { ...block, text };
    }
    case 'paragraph': {
      const text = keptAt({ field: 'paragraph', block: index }, block.text);
      return text === '' ? undefined : { ...block, text };
    }
    case 'list': {
      const items = block.items
        .map((item, position) => keptAt({ field: 'item', block: index, item: position }, item))
        .filter((item) => item !== '');
      if (items.length === 0) return undefined;
      // A list needs two items; one that is left is a paragraph of the same passages.
      return items.length === 1 ? { type: 'paragraph', cites: block.cites, text: items[0]! } : { ...block, items };
    }
    case 'callout': {
      const text = keptAt({ field: 'callout-text', block: index }, block.text);
      if (text === '') return undefined;
      const title = block.title === undefined ? '' : keptAt({ field: 'callout-title', block: index }, block.title);
      return { type: 'callout', cites: block.cites, kind: block.kind, text, ...(title === '' ? {} : { title }) };
    }
    // The other blocks have no sentences of their own to take out; an answer to a question has none of them.
    case 'bar-chart':
    case 'comparison':
    case 'diagram':
    case 'line-chart':
    case 'sequence':
    case 'simulation':
    case 'timeline':
      return block;
  }
}

/**
 * The headings left with nothing in their section: the blocks between a heading and the next heading, the closing limits callout
 * excluded, were all removed. A heading that had no blocks to begin with is left as it was written.
 */
function emptiedHeadings(blocks: readonly Block[], survivors: ReadonlySet<number>): ReadonlySet<number> {
  const last = blocks.at(-1);
  const closing = last?.type === 'callout' && last.kind === 'limit' ? blocks.length - 1 : -1;
  const emptied = new Set<number>();
  blocks.forEach((block, heading) => {
    if (block.type !== 'heading' || !survivors.has(heading)) return;
    const section: number[] = [];
    for (let index = heading + 1; index < blocks.length && blocks[index]!.type !== 'heading'; index += 1)
      if (index !== closing) section.push(index);
    if (section.length > 0 && section.every((index) => !survivors.has(index))) emptied.add(heading);
  });
  return emptied;
}
