import type { AnyBlock, BlockType } from './blocks/catalog.js';
import type { Gesture } from './blocks/envelope.js';
import { richTextPlain } from './text.js';

/**
 * Behaviour the renderer contract derives from a block's data (blueprint §18). These are functions
 * of the content, never fields the model writes.
 */

/** Reading blocks whose accessibility label and fallback text code derives from their own text. */
export const TEXT_BLOCK_TYPES = ['paragraph', 'subheading', 'list', 'quote', 'callout'] as const;
export type TextBlockType = (typeof TEXT_BLOCK_TYPES)[number];
const TEXT_TYPES: ReadonlySet<string> = new Set(TEXT_BLOCK_TYPES);
export function isTextBlockType(type: string): type is TextBlockType {
  return TEXT_TYPES.has(type);
}

/** Gesture capture derived from the block's data. */
export function deriveGesture(block: AnyBlock): Gesture {
  switch (block.type) {
    case 'simulation':
      return block.data.params.some((param) => param.control === 'slider') ? 'horizontal' : 'none';
    case 'diagram':
      return block.data.interaction.kind === 'drag-to-target' ? 'two-axis' : 'none';
    case 'code':
      // Lines can overflow at any text size, so code always owns a locked horizontal drag.
      return 'horizontal';
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'quote':
    case 'callout':
    case 'disclosure':
    case 'table':
    case 'figure':
    case 'media':
    case 'comparison':
    case 'timeline':
    case 'sequence':
    case 'chart':
    case 'fallback':
      return 'none';
  }
}

/**
 * Blocks that hold reader state or play media; at most `LIMITS.interactiveBlocks` per document.
 * A disclosure holds state too but is a reading structure, so it does not count.
 */
export function isInteractiveBlock(block: AnyBlock): boolean {
  switch (block.type) {
    case 'simulation':
    case 'sequence':
    case 'media':
      return true;
    case 'diagram':
      return block.data.interaction.kind !== 'static';
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'quote':
    case 'callout':
    case 'disclosure':
    case 'code':
    case 'table':
    case 'figure':
    case 'comparison':
    case 'timeline':
    case 'chart':
    case 'fallback':
      return false;
  }
}

/** What each moving block does when the reader asks for reduced motion. */
export const REDUCED_MOTION = {
  diagram: 'switch-frame-without-transition',
  simulation: 'update-without-morphing',
  sequence: 'change-step-without-sliding',
  disclosure: 'expand-without-animation',
  media: 'show-poster-without-autoplay',
  figure: 'show-poster-instead-of-loop',
} as const satisfies Partial<Record<BlockType, string>>;

/** Interaction kinds a renderer may report for a block type (`scroll.block_interaction`). */
export const INTERACTION_KINDS = {
  simulation: ['param-changed', 'reset', 'text-version-opened'],
  diagram: ['frame-changed', 'token-dropped', 'reset', 'described'],
  sequence: ['step-changed'],
  disclosure: ['expanded', 'collapsed'],
  code: ['copied', 'scrolled-horizontally'],
  media: ['played', 'paused', 'captions-toggled'],
  chart: ['text-version-opened'],
  figure: ['zoomed'],
} as const satisfies Partial<Record<BlockType, readonly string[]>>;

/**
 * `text-projection.v1`: the plain text passage offsets index, in UTF-16 code units. Only these
 * blocks project; other blocks are shared as whole blocks (`scroll_block`).
 * - paragraph, quote, callout: the concatenation of the spans;
 * - list: the items' plain text joined with "\n".
 */
export function projectText(block: AnyBlock): string | null {
  switch (block.type) {
    case 'paragraph':
    case 'quote':
    case 'callout':
      return richTextPlain(block.data.spans);
    case 'list':
      return block.data.items.map((item) => richTextPlain(item)).join('\n');
    case 'subheading':
    case 'disclosure':
    case 'code':
    case 'table':
    case 'figure':
    case 'media':
    case 'comparison':
    case 'timeline':
    case 'sequence':
    case 'diagram':
    case 'chart':
    case 'simulation':
    case 'fallback':
      return null;
  }
}

/**
 * The text a reader sees for the block in the main rendition (disclosure children are visited
 * separately). Used for the visible-text limit, the numeric honesty check and the copy check.
 */
export function visibleTexts(block: AnyBlock): string[] {
  const present = (...values: Array<string | undefined>) =>
    values.filter((value): value is string => value !== undefined);
  switch (block.type) {
    case 'paragraph':
    case 'list':
      return [projectText(block) ?? ''];
    case 'subheading':
      return [block.data.text];
    case 'quote':
      return present(richTextPlain(block.data.spans), block.data.attribution);
    case 'callout':
      return present(block.data.title, richTextPlain(block.data.spans));
    case 'disclosure':
      return [block.data.summary];
    case 'code':
      return present(block.data.title, block.data.code, block.data.caption);
    case 'table':
      return [
        block.data.caption,
        ...block.data.columns.flatMap((column) => present(column.label, column.unit)),
        ...block.data.rows.flatMap((row) => row.map((cell) => String(cell))),
      ];
    case 'figure':
      return present(block.data.caption);
    case 'media':
      return [];
    case 'comparison':
      return [
        block.data.title,
        ...block.data.columns.flatMap((column) => [
          column.label,
          ...column.points.map((point) => richTextPlain(point)),
        ]),
        ...present(block.data.caption),
      ];
    case 'timeline':
      return [
        block.data.title,
        ...block.data.events.flatMap((event) =>
          present(event.when, event.title, event.detail === undefined ? undefined : richTextPlain(event.detail)),
        ),
      ];
    case 'sequence':
      return [block.data.title, ...block.data.steps.flatMap((step) => [step.title, richTextPlain(step.spans)])];
    case 'diagram':
      return [
        block.data.title,
        ...present(block.data.instruction),
        ...block.data.nodes.map((node) => node.label),
        ...block.data.edges.flatMap((edge) => present(edge.label)),
        ...block.data.groups.map((group) => group.label),
        ...block.data.frames.flatMap((frame) => [frame.label, frame.description]),
      ];
    case 'chart': {
      const spec = block.data.spec;
      const axes = spec.kind === 'bar' ? [spec.valueAxis] : spec.kind === 'heatmap' ? [] : [spec.x, spec.y];
      const labels =
        spec.kind === 'bar'
          ? [...spec.categories, ...spec.series.map((series) => series.label)]
          : spec.kind === 'heatmap'
            ? [...spec.rows, ...spec.columns, spec.scale.label]
            : spec.series.map((series) => series.label);
      return [
        block.data.title,
        ...present(block.data.caption),
        ...axes.flatMap((axis) => present(axis.label, axis.unit)),
        ...labels,
      ];
    }
    case 'simulation': {
      const data = block.data;
      const view = data.view;
      return [
        data.title,
        ...present(data.prompt),
        ...data.params.flatMap((param) => present(param.label, param.unit)),
        ...data.constants.flatMap((constant) => present(constant.label, constant.unit)),
        ...data.outputs.flatMap((output) => present(output.label, output.unit)),
        ...(view.kind === 'cards' ? view.items.flatMap((item) => present(item.label, item.note)) : []),
        ...(view.kind === 'plot' ? [view.yLabel] : []),
        ...(view.kind === 'area' ? [view.lengthLabel, view.areaLabel] : []),
        ...(data.readout === undefined ? [] : [data.readout.template, ...data.readout.bands.map((band) => band.text)]),
        data.modelNote,
      ];
    }
    case 'fallback':
      return [block.fallbackText];
  }
}
