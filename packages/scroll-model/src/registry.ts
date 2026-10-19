import type { AnyBlock, BlockType } from './blocks/catalog.js';
import type { Gesture } from './blocks/envelope.js';
import { FIELD_LIMITS } from './limits.js';
import { richTextPlain, truncateText, type RichText } from './text.js';

/**
 * Behaviour the renderer contract derives from a block's data (blueprint §18). These are functions
 * of the content, never fields the model writes.
 */

/** Every client must render these, so a substituted block always has somewhere to land. */
export const BASELINE_TYPES = ['fallback', 'paragraph', 'subheading'] as const satisfies readonly BlockType[];

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

/** One reader-facing text of a block, addressed by a stable field name. */
export interface TextField {
  /** `text` for a text block's passage projection, otherwise a dotted path (`data.caption`, `a11y.label`). */
  readonly field: string;
  readonly text: string;
  /** Shown in the main rendition (counts toward the visible-text limit); false for text that is only spoken or shown on request. */
  readonly visible: boolean;
  /** Source code: shown, never run, and not a factual claim (exempt from the numeric and copy checks). */
  readonly code: boolean;
}

/**
 * Every reader-facing text of a block — shown, spoken (accessibility text) or shown on request
 * (fallback text, alt text, transcripts) — with a stable field name. Disclosure children are
 * separate blocks. A text block's accessibility label is derived by code from its other fields, so
 * it is not listed. This one enumeration feeds the visible-text limit, the numeric honesty check,
 * the copy check and the binding addresses.
 */
export function textFields(block: AnyBlock): TextField[] {
  const fields: TextField[] = [];
  const add = (field: string, text: string | undefined, visible = true, code = false) => {
    if (text !== undefined && text !== '') fields.push({ field, text, visible, code });
  };
  const rich = (spans: RichText) => richTextPlain(spans);
  if (!isTextBlockType(block.type) && block.type !== 'fallback') {
    add('a11y.label', block.a11y.label, false);
    add('a11y.description', block.a11y.description, false);
  }
  switch (block.type) {
    case 'paragraph':
    case 'list':
      add('text', projectText(block) ?? '');
      break;
    case 'subheading':
      add('data.text', block.data.text);
      break;
    case 'quote':
      add('text', rich(block.data.spans));
      add('data.attribution', block.data.attribution);
      break;
    case 'callout':
      add('data.title', block.data.title);
      add('text', rich(block.data.spans));
      break;
    case 'disclosure':
      add('data.summary', block.data.summary);
      break;
    case 'code':
      add('data.title', block.data.title);
      add('data.code', block.data.code, true, true);
      add('data.caption', block.data.caption);
      break;
    case 'table':
      add('data.caption', block.data.caption);
      block.data.columns.forEach((column, index) => {
        add(`data.columns.${index}.label`, column.label);
        add(`data.columns.${index}.unit`, column.unit);
      });
      block.data.rows.forEach((row, rowIndex) =>
        row.forEach((cell, cellIndex) => add(`data.rows.${rowIndex}.${cellIndex}`, String(cell))),
      );
      break;
    case 'figure':
      add('data.caption', block.data.caption);
      add('data.alt', block.data.alt, false);
      break;
    case 'media':
      add('data.alt', block.data.alt, false);
      add('data.transcript', block.data.transcript, false);
      break;
    case 'comparison':
      add('data.title', block.data.title);
      block.data.columns.forEach((column, index) => {
        add(`data.columns.${index}.label`, column.label);
        column.points.forEach((point, pointIndex) => add(`data.columns.${index}.points.${pointIndex}`, rich(point)));
      });
      add('data.caption', block.data.caption);
      break;
    case 'timeline':
      add('data.title', block.data.title);
      block.data.events.forEach((event, index) => {
        add(`data.events.${index}.when`, event.when);
        add(`data.events.${index}.title`, event.title);
        add(`data.events.${index}.detail`, event.detail === undefined ? undefined : rich(event.detail));
      });
      break;
    case 'sequence':
      add('data.title', block.data.title);
      block.data.steps.forEach((step, index) => {
        add(`data.steps.${index}.title`, step.title);
        add(`data.steps.${index}.text`, rich(step.spans));
        add(`data.steps.${index}.figure.alt`, step.figure?.alt, false);
      });
      break;
    case 'diagram':
      add('data.title', block.data.title);
      add('data.instruction', block.data.instruction);
      block.data.nodes.forEach((node, index) => add(`data.nodes.${index}.label`, node.label));
      block.data.edges.forEach((edge, index) => add(`data.edges.${index}.label`, edge.label));
      block.data.groups.forEach((group, index) => add(`data.groups.${index}.label`, group.label));
      block.data.frames.forEach((frame, index) => {
        add(`data.frames.${index}.label`, frame.label);
        add(`data.frames.${index}.description`, frame.description);
      });
      break;
    case 'chart': {
      add('data.title', block.data.title);
      add('data.caption', block.data.caption);
      const spec = block.data.spec;
      const axis = (name: string, value: { label: string; unit?: string | undefined }) => {
        add(`data.spec.${name}.label`, value.label);
        add(`data.spec.${name}.unit`, value.unit);
      };
      if (spec.kind === 'bar') {
        axis('valueAxis', spec.valueAxis);
        spec.categories.forEach((category, index) => add(`data.spec.categories.${index}`, category));
        spec.series.forEach((series, index) => add(`data.spec.series.${index}.label`, series.label));
      } else if (spec.kind === 'heatmap') {
        spec.rows.forEach((row, index) => add(`data.spec.rows.${index}`, row));
        spec.columns.forEach((column, index) => add(`data.spec.columns.${index}`, column));
        add('data.spec.scale.label', spec.scale.label);
      } else {
        axis('x', spec.x);
        axis('y', spec.y);
        spec.series.forEach((series, index) => add(`data.spec.series.${index}.label`, series.label));
      }
      break;
    }
    case 'simulation': {
      const data = block.data;
      add('data.title', data.title);
      add('data.prompt', data.prompt);
      data.params.forEach((param, index) => {
        add(`data.params.${index}.label`, param.label);
        add(`data.params.${index}.unit`, param.unit);
        add(`data.params.${index}.format.suffix`, param.format.suffix);
      });
      data.constants.forEach((constant, index) => {
        add(`data.constants.${index}.label`, constant.label);
        add(`data.constants.${index}.unit`, constant.unit);
      });
      data.outputs.forEach((output, index) => {
        add(`data.outputs.${index}.label`, output.label);
        add(`data.outputs.${index}.unit`, output.unit);
        add(`data.outputs.${index}.format.suffix`, output.format.suffix);
      });
      const view = data.view;
      if (view.kind === 'cards') {
        view.items.forEach((item, index) => {
          add(`data.view.items.${index}.label`, item.label);
          add(`data.view.items.${index}.note`, item.note);
        });
      } else if (view.kind === 'plot') add('data.view.yLabel', view.yLabel);
      else if (view.kind === 'area') {
        add('data.view.lengthLabel', view.lengthLabel);
        add('data.view.areaLabel', view.areaLabel);
      }
      if (data.readout !== undefined) {
        add('data.readout.template', data.readout.template);
        data.readout.bands.forEach((band, index) => add(`data.readout.bands.${index}.text`, band.text));
      }
      add('data.modelNote', data.modelNote);
      break;
    }
    case 'fallback':
      add('fallbackText', block.fallbackText);
      break;
  }
  if ('fallbackText' in block && block.type !== 'fallback') add('fallbackText', block.fallbackText, false);
  return fields;
}

/** The text a reader sees for the block in the main rendition (disclosure children are visited separately). */
export function visibleTexts(block: AnyBlock): string[] {
  return textFields(block)
    .filter((field) => field.visible)
    .map((field) => field.text);
}

const CALLOUT_LABELS = {
  note: 'Note',
  example: 'Example',
  limit: 'Limits',
  'key-idea': 'Key idea',
  'try-it': 'Try it',
} as const;

type TextBlock = Extract<AnyBlock, { type: TextBlockType }>;

/** The accessibility label code gives a text block (`derive-text-envelope.v1`). */
export function deriveTextLabel(block: TextBlock): string {
  switch (block.type) {
    case 'paragraph':
      return 'Paragraph';
    case 'subheading':
      return block.data.text;
    case 'list':
      return block.data.style === 'number' ? 'Numbered list' : 'List';
    case 'quote':
      return block.data.kind === 'pull' ? 'Pull quote' : 'Quotation';
    case 'callout': {
      const kind = CALLOUT_LABELS[block.data.kind];
      return block.data.title === undefined
        ? kind
        : truncateText(`${kind}: ${block.data.title}`, FIELD_LIMITS.a11yLabelChars);
    }
  }
}

/**
 * The readable stand-in for a block: stored for every non-text block, derived from the block's
 * own text for a text block (`derive-text-envelope.v1`; never stored, so prose is not duplicated).
 */
export function fallbackTextOf(block: AnyBlock): string {
  const fit = (text: string) => truncateText(text.replace(/\s+/gu, ' ').trim(), FIELD_LIMITS.fallbackTextChars);
  switch (block.type) {
    case 'paragraph':
      return fit(richTextPlain(block.data.spans));
    case 'subheading':
      return block.data.text;
    case 'list':
      return fit(block.data.items.map((item) => richTextPlain(item)).join('; '));
    case 'quote': {
      const attribution = block.data.attribution === undefined ? '' : ` — ${block.data.attribution}`;
      return fit(`${richTextPlain(block.data.spans)}${attribution}`);
    }
    case 'callout':
      return fit(`${block.data.title === undefined ? '' : `${block.data.title}. `}${richTextPlain(block.data.spans)}`);
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
      return block.fallbackText;
  }
}
