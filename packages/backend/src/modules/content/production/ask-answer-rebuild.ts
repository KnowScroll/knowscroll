import type { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { leansOnPrevious } from './ask-answer-shape.js';
import type { PlacedSentence, StatementPlace } from './ask-support.js';

/**
 * Taking sentences out of the answer to a question (D-310, D-348). Two steps share these pure functions: the trim of the
 * writer's draft before it is checked, and the drop of the sentences a check still found unsupported. Both name the sentences to
 * take out by their number in `placedSentencesOfAnswer`; this file removes them from the text and rebuilds the blocks.
 */

export type AnswerBlock = AuthoredScroll['blocks'][number];

/** Where a sentence's text stands, so the sentences of one place can be put back together. */
export const keyOf = (place: StatementPlace): string =>
  'block' in place ? `${place.field}:${String(place.block)}:${'item' in place ? String(place.item) : ''}` : place.field;

/**
 * The sentences to take out and every kept sentence that leans on one of them: it begins with a pointer and the sentence just before
 * it in its block was taken out. Taking that one out can leave the next in the same state, so this runs until nothing changes.
 */
export function withLeaningSentencesRemoved(
  sentences: readonly PlacedSentence[],
  removing: ReadonlySet<number>,
): ReadonlySet<number> {
  const removed = new Set(removing);
  for (let changed = true; changed;) {
    changed = false;
    sentences.forEach((sentence, index) => {
      const before = sentences[index - 1];
      if (before === undefined || removed.has(sentence.number) || !removed.has(before.number)) return;
      const inOneBlock =
        'block' in sentence.place && 'block' in before.place && sentence.place.block === before.place.block;
      if (!inOneBlock || sentence.label === true || before.label === true || !leansOnPrevious(sentence.text)) return;
      removed.add(sentence.number);
      changed = true;
    });
  }
  return removed;
}

/** The blocks of the answer without the removed sentences, and for each block that is left the index it had in the answer. */
export function rebuildWithout(
  answer: AuthoredScroll,
  sentences: readonly PlacedSentence[],
  removed: ReadonlySet<number>,
): { readonly blocks: readonly AnswerBlock[]; readonly origin: readonly number[] } {
  const byPlace = new Map<string, PlacedSentence[]>();
  for (const sentence of sentences)
    byPlace.set(keyOf(sentence.place), [...(byPlace.get(keyOf(sentence.place)) ?? []), sentence]);
  /** The text at a place without its removed sentences; the original string when none was removed there. */
  const keptAt = (place: StatementPlace, original: string): string => {
    const own = byPlace.get(keyOf(place)) ?? [];
    const kept = own.filter((sentence) => !removed.has(sentence.number));
    return kept.length === own.length ? original : kept.map((sentence) => sentence.text).join(' ');
  };
  const rebuilt = answer.blocks.flatMap((block, index) => {
    const next = rebuildBlock(block, index, keptAt);
    return next === undefined ? [] : [{ block: next, from: index }];
  });
  const emptied = emptiedHeadings(answer.blocks, new Set(rebuilt.map((entry) => entry.from)));
  const survivors = rebuilt.filter((entry) => !emptied.has(entry.from));
  return { blocks: survivors.map((entry) => entry.block), origin: survivors.map((entry) => entry.from) };
}

/** One block without its removed sentences, or `undefined` when nothing of it is left. */
function rebuildBlock(
  block: AnswerBlock,
  index: number,
  keptAt: (place: StatementPlace, original: string) => string,
): AnswerBlock | undefined {
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
function emptiedHeadings(blocks: readonly AnswerBlock[], survivors: ReadonlySet<number>): ReadonlySet<number> {
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
