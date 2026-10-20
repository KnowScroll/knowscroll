import {
  INTEGRITY_METHOD,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_LIMITS_VERSION,
  computeIntegrity,
  computeMeasures,
  type Block,
  type BlockOfType,
  type ScrollDocument,
  type Section,
  type Span,
} from '../model';

/**
 * Fixture documents for tests and the developer gallery: labelled, original, never product
 * content. They are built the way code builds a stored revision (measures from `computeMeasures`,
 * the integrity hash from `computeIntegrity`, text blocks' accessibility label derived), so a
 * fixture parses on the client path and verifies with `{verify: true}`.
 */

/** Inline text from a plain string, or from runs with marks. */
export function spans(...parts: ReadonlyArray<string | Span>): Span[] {
  return parts.map((part) => (typeof part === 'string' ? { text: part } : part));
}
export const em = (text: string): Span => ({ text, marks: ['em'] });
export const strong = (text: string): Span => ({ text, marks: ['strong'] });
export const code = (text: string): Span => ({ text, marks: ['code'] });

export function paragraph(id: string, runs: Span[], essential = true): BlockOfType<'paragraph'> {
  return {
    id,
    type: 'paragraph',
    version: 1,
    a11y: { label: 'Paragraph' },
    essential,
    gesture: 'none',
    data: { spans: runs },
  };
}

export function subheading(id: string, text: string): BlockOfType<'subheading'> {
  return {
    id,
    type: 'subheading',
    version: 1,
    a11y: { label: text },
    essential: false,
    gesture: 'none',
    data: { text },
  };
}

export function list(id: string, style: 'bullet' | 'number', items: Span[][]): BlockOfType<'list'> {
  return {
    id,
    type: 'list',
    version: 1,
    a11y: { label: style === 'number' ? 'Numbered list' : 'List' },
    essential: true,
    gesture: 'none',
    data: { style, items },
  };
}

export function quote(
  id: string,
  kind: 'pull' | 'quotation',
  runs: Span[],
  attribution?: string,
): BlockOfType<'quote'> {
  return {
    id,
    type: 'quote',
    version: 1,
    a11y: { label: kind === 'pull' ? 'Pull quote' : 'Quotation' },
    essential: false,
    gesture: 'none',
    data: { kind, spans: runs, ...(attribution === undefined ? {} : { attribution }) },
  };
}

const CALLOUT_LABELS = {
  note: 'Note',
  example: 'Example',
  limit: 'Limits',
  'key-idea': 'Key idea',
  'try-it': 'Try it',
} as const;

export function callout(
  id: string,
  kind: keyof typeof CALLOUT_LABELS,
  runs: Span[],
  title?: string,
): BlockOfType<'callout'> {
  return {
    id,
    type: 'callout',
    version: 1,
    a11y: { label: title === undefined ? CALLOUT_LABELS[kind] : `${CALLOUT_LABELS[kind]}: ${title}` },
    essential: false,
    gesture: 'none',
    data: { kind, spans: runs, ...(title === undefined ? {} : { title }) },
  };
}

export function section(id: string, heading: string | null, blocks: Block[]): Section {
  return { id, heading, blocks };
}

export interface FixtureInput {
  readonly assetId: string;
  readonly revision?: number;
  readonly template: ScrollDocument['template'];
  readonly family: ScrollDocument['theme']['family'];
  readonly kicker: string;
  readonly title: string;
  readonly dek: string;
  readonly framing?: ScrollDocument['framing'];
  readonly corrections?: ScrollDocument['corrections'];
  readonly sections: Section[];
}

/** A stored consumer revision, as code would build it. */
export function scrollFixture(input: FixtureInput): ScrollDocument {
  const unsigned = {
    schemaVersion: SCROLL_DOCUMENT_SCHEMA_VERSION,
    assetId: input.assetId,
    revision: input.revision ?? 1,
    language: 'en',
    explanationUnitId: `${input.assetId}-unit`,
    template: input.template,
    theme: { family: input.family },
    kicker: input.kicker,
    title: input.title,
    dek: input.dek,
    framing: input.framing ?? { kind: 'factual' },
    sections: input.sections,
    corrections: input.corrections ?? [],
    limitsVersion: SCROLL_LIMITS_VERSION,
    measures: computeMeasures(input.sections),
  } as const;
  const integrity = { method: INTEGRITY_METHOD, sha256: computeIntegrity(unsigned) } as const;
  return { ...unsigned, integrity };
}
