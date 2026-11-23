import type { IssueV3 } from '../../v3/issues.js';
import type {
  WrittenItemV3,
  WrittenProseItemV3,
  WrittenProseV3,
  WrittenScrollV3,
  WrittenStagingV3,
} from './written-schema.js';

type StageEntry = WrittenStagingV3['stage'][number];

/** The paragraphs and quotations of a prose reply in reading order: what `P1…Pn` count. */
function beatsOf(items: readonly WrittenProseItemV3[]): number[] {
  return items.flatMap((item, index) => (item.type === 'para' || item.type === 'quote' ? [index] : []));
}

/**
 * The prose as the staging model reads it: every paragraph and quotation on a line of its own, numbered `P1…Pn` in
 * reading order. Section titles and asides are shown, unnumbered, only so the model can find its place. No handle
 * appears, because staging has nothing to cite.
 */
export function numberedProseText(prose: WrittenProseV3): string {
  let number = 0;
  const lines = prose.items.map((item) => {
    switch (item.type) {
      case 'section':
        return `SECTION: ${item.title}`;
      case 'para':
        number += 1;
        return `P${number} ${item.text}`;
      case 'quote':
        number += 1;
        return `P${number} (quotation, ${item.who}) ${item.text}`;
      case 'aside':
        return `ASIDE (${item.kind}) ${item.title}: ${item.text}`;
    }
  });
  return [`TITLE: ${prose.title}`, `DEK: ${prose.dek}`, ...lines].join('\n');
}

export interface MergedStagingV3 {
  /** The whole-Scroll reply the prose and the staging make together. Built even when there are findings. */
  readonly reply: WrittenScrollV3;
  /** Findings at `stage.K`, K counted in the staging reply's `stage` list. */
  readonly issues: readonly IssueV3[];
  /** For each item of the merged reply that a stage entry applied to, the index of that entry. */
  readonly stageOfItem: ReadonlyMap<number, number>;
}

/**
 * What a stage entry adds to a paragraph or quotation, as the keys it may carry. A control belongs to a paragraph;
 * a quotation takes a show and links only.
 */
function staged(
  item: WrittenProseItemV3 & { type: 'para' | 'quote' },
  entry: StageEntry,
  at: string,
  issues: IssueV3[],
) {
  const show = entry.show === undefined ? {} : { show: entry.show };
  const links = entry.links === undefined ? {} : { links: entry.links };
  if (item.type === 'quote') {
    if (entry.control !== undefined) issues.push({ code: 'control_unfit', path: `${at}.control` });
    if (entry.emphasis !== undefined) issues.push({ code: 'schema_unrecognized_keys', path: `${at}.emphasis` });
    return { ...item, ...show, ...links } satisfies WrittenItemV3;
  }
  return {
    ...item,
    ...show,
    ...links,
    ...(entry.control === undefined ? {} : { control: entry.control }),
    ...(entry.emphasis === undefined ? {} : { emphasis: entry.emphasis }),
  } satisfies WrittenItemV3;
}

/**
 * Arm (b): puts the staging on the prose, one stage entry on each paragraph it names, and returns the whole-Scroll
 * reply that `compileWrittenV3` reads. The prose is never changed. An entry is refused when its `para` is not a
 * paragraph (`stage_para_unknown`), when the paragraph already had an entry (`stage_para_repeated`; the first wins),
 * or when it puts a control on a quotation (`control_unfit`); a refused entry is left out of the reply.
 */
export function mergeStagingV3(prose: WrittenProseV3, staging: WrittenStagingV3): MergedStagingV3 {
  const issues: IssueV3[] = [];
  const beatItems = beatsOf(prose.items);
  const entryOfItem = new Map<number, number>();
  staging.stage.forEach((entry, index) => {
    const itemIndex = beatItems[entry.para - 1];
    if (itemIndex === undefined) issues.push({ code: 'stage_para_unknown', path: `stage.${index}.para` });
    else if (entryOfItem.has(itemIndex)) issues.push({ code: 'stage_para_repeated', path: `stage.${index}.para` });
    else entryOfItem.set(itemIndex, index);
  });
  const items = prose.items.map((item, index): WrittenItemV3 => {
    const entryIndex = entryOfItem.get(index);
    const entry = entryIndex === undefined ? undefined : staging.stage[entryIndex];
    if (entryIndex === undefined || entry === undefined || (item.type !== 'para' && item.type !== 'quote')) return item;
    return staged(item, entry, `stage.${entryIndex}`, issues);
  });
  return {
    reply: { ...prose, pictures: staging.pictures, items },
    issues,
    stageOfItem: entryOfItem,
  };
}

/** The keys of a paragraph that the staging reply, not the prose, wrote. */
const STAGED_KEYS: ReadonlySet<string> = new Set(['show', 'links', 'control', 'emphasis']);

/**
 * Puts the findings of a compile of the merged reply where the staging model wrote them: what a paragraph shows,
 * links, controls or stresses is reported at its `stage.K` entry, and a finding about the whole list (`items`, such as
 * the reading time that the pictures changed) at `stage`. Findings about the prose and the pictures keep their paths.
 */
export function stagingPathsV3(issues: readonly IssueV3[], stageOfItem: ReadonlyMap<number, number>): IssueV3[] {
  return issues.map((issue) => {
    if (issue.path === 'items') return { ...issue, path: 'stage' };
    const [root, index, key, ...rest] = issue.path.split('.');
    if (root !== 'items' || index === undefined || key === undefined || !STAGED_KEYS.has(key)) return issue;
    const entry = stageOfItem.get(Number(index));
    return entry === undefined ? issue : { ...issue, path: ['stage', entry, key, ...rest].join('.') };
  });
}
