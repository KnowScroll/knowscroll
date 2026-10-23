import type { AnyBlock } from './blocks/catalog.js';
import { SCROLL_MEASURES_VERSION, walkBlocks, type Measures, type ScrollDocument, type Section } from './document.js';
import { visibleTexts } from './registry.js';
import { countWords } from './text.js';

/**
 * `scroll-measures.v1`: block weights in word-equivalents and the reading estimate, computed by
 * code from content size (blueprint §8: coverage weighted by meaningful content, so passing
 * several headings does not count). Bench values; a change is a new measures version.
 */
export const WORDS_PER_MINUTE = 200;

function words(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + countWords(text), 0);
}

/** Weight of one block in word-equivalents. A disclosure counts 30% of its children (optional depth). */
export function blockWeight(block: AnyBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'list':
    case 'quote':
    case 'callout':
      return Math.max(5, words(visibleTexts(block)));
    case 'subheading':
      return 2;
    case 'disclosure':
      return 5 + Math.round(0.3 * block.data.blocks.reduce((total, child) => total + blockWeight(child), 0));
    case 'code':
      return 10 + 3 * block.data.code.split('\n').length;
    case 'table':
      return 10 + 2 * block.data.rows.reduce((total, row) => total + row.length, 0);
    case 'figure':
      return 20;
    case 'media':
      return 20 + Math.round(block.data.durationMs / 400);
    case 'comparison':
    case 'timeline':
      return Math.max(10, words(visibleTexts(block)));
    case 'sequence':
      return 10 + words(visibleTexts(block));
    case 'diagram':
      return 40 + 10 * block.data.frames.length;
    case 'chart':
      return 45;
    case 'simulation':
      return 60 + 15 * block.data.params.length;
    case 'fallback':
      return Math.max(5, countWords(block.fallbackText));
  }
}

/** Measures of a document's sections: one weight per top-level block, total and reading minutes. */
export function computeMeasures(sections: readonly Section[]): Measures {
  const blocks = sections.flatMap((section) =>
    section.blocks.map((block) => ({ blockId: block.id, weight: blockWeight(block) })),
  );
  const totalWeight = blocks.reduce((total, entry) => total + entry.weight, 0);
  return {
    version: SCROLL_MEASURES_VERSION,
    readingMinutes: Math.max(1, Math.round(totalWeight / WORDS_PER_MINUTE)),
    totalWeight,
    blocks,
  };
}

export interface SectionCoverage {
  readonly sectionId: string;
  readonly weight: number;
  readonly seenWeight: number;
}

export interface CoverageResult {
  /** Seen weight over total weight, in [0, 1]; 0 for an empty document. */
  readonly fraction: number;
  readonly sections: readonly SectionCoverage[];
}

/**
 * Weighted coverage from the block ids a reader actually saw (the client reports visible ids; the
 * server owns this computation). A disclosure child counts as its disclosure; unknown ids are
 * ignored. Uses the stored measures, so the result is fixed per revision.
 */
export function coverageOf(document: ScrollDocument, seenBlockIds: Iterable<string>): CoverageResult {
  const topLevel = new Map<string, string>();
  for (const visit of walkBlocks(document.sections)) topLevel.set(visit.block.id, (visit.parent ?? visit.block).id);
  const seen = new Set<string>();
  for (const id of seenBlockIds) {
    const owner = topLevel.get(id);
    if (owner !== undefined) seen.add(owner);
  }
  const weights = new Map(document.measures.blocks.map((entry) => [entry.blockId, entry.weight]));
  let total = 0;
  let seenTotal = 0;
  const sections = document.sections.map((section) => {
    let weight = 0;
    let seenWeight = 0;
    for (const block of section.blocks) {
      const blockWeightValue = weights.get(block.id) ?? 0;
      weight += blockWeightValue;
      if (seen.has(block.id)) seenWeight += blockWeightValue;
    }
    total += weight;
    seenTotal += seenWeight;
    return { sectionId: section.id, weight, seenWeight };
  });
  return { fraction: total === 0 ? 0 : seenTotal / total, sections };
}
