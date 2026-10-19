import type { AnyBlock } from '../blocks/catalog.js';
import { INLINE_MARKS, type InlineMark, type Span } from '../text.js';

/**
 * `normalise.v1`: deterministic clean-up of a model reply before it is parsed. It never refuses
 * anything and never changes meaning:
 * - every string is NFC-normalised, except source code (`code` members), which is kept byte-exact;
 * - a bare string where inline text is expected becomes one unmarked span.
 * Unknown shapes pass through untouched for the schema to judge.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies with NFC strings. Objects are rebuilt with a null prototype, so an own `__proto__` key in
 * the model's JSON stays an ordinary (unknown, refused) member and never becomes a prototype.
 */
function nfc(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') return key === 'code' ? value : value.normalize('NFC');
  if (Array.isArray(value)) return value.map((item: unknown) => nfc(item, null));
  if (isRecord(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [member, item] of Object.entries(value)) out[member] = nfc(item, member);
    return out;
  }
  return value;
}

const asSpans = (value: unknown): unknown => (typeof value === 'string' ? [{ text: value }] : value);

function spansIn(data: Record<string, unknown>, member: string): void {
  if (member in data) data[member] = asSpans(data[member]);
}

function normaliseBlock(block: unknown): void {
  if (!isRecord(block) || !isRecord(block['data'])) return;
  const data = block['data'];
  const each = (member: string, apply: (item: Record<string, unknown>) => void) => {
    const list = data[member];
    if (Array.isArray(list)) for (const item of list) if (isRecord(item)) apply(item);
  };
  switch (block['type']) {
    case 'paragraph':
    case 'quote':
    case 'callout':
      spansIn(data, 'spans');
      break;
    case 'list':
      if (Array.isArray(data['items'])) data['items'] = (data['items'] as unknown[]).map(asSpans);
      break;
    case 'comparison':
      each('columns', (column) => {
        if (Array.isArray(column['points'])) column['points'] = (column['points'] as unknown[]).map(asSpans);
      });
      break;
    case 'timeline':
      each('events', (event) => spansIn(event, 'detail'));
      break;
    case 'sequence':
      each('steps', (step) => spansIn(step, 'spans'));
      break;
    case 'disclosure':
      if (Array.isArray(data['blocks'])) for (const child of data['blocks'] as unknown[]) normaliseBlock(child);
      break;
    default:
      break;
  }
}

/** Applies `normalise.v1` to an untrusted draft value; returns a new value. */
export function normaliseDraftInput(raw: unknown): unknown {
  const value = nfc(raw, null);
  if (!isRecord(value) || !Array.isArray(value['sections'])) return value;
  for (const section of value['sections'] as unknown[]) {
    if (isRecord(section) && Array.isArray(section['blocks']))
      for (const block of section['blocks'] as unknown[]) normaliseBlock(block);
  }
  return value;
}

const MARK_ORDER = new Map<InlineMark, number>(INLINE_MARKS.map((mark, index) => [mark, index]));

/** Canonical inline text: marks in a fixed order, adjacent spans with the same marks merged. */
export function canonicalSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const marks =
      span.marks === undefined
        ? undefined
        : [...span.marks].sort((a, b) => (MARK_ORDER.get(a) ?? 0) - (MARK_ORDER.get(b) ?? 0));
    const previous = out[out.length - 1];
    if (previous !== undefined && (previous.marks ?? []).join() === (marks ?? []).join()) {
      out[out.length - 1] = { ...previous, text: previous.text + span.text };
    } else out.push(marks === undefined ? { text: span.text } : { text: span.text, marks });
  }
  return out;
}

/** Applies `canonicalSpans` to every inline text of a block (disclosure children included). */
export function canonicaliseBlockText<B extends AnyBlock>(block: B): B {
  const value: AnyBlock = block;
  switch (value.type) {
    case 'paragraph':
    case 'quote':
    case 'callout':
      return { ...value, data: { ...value.data, spans: canonicalSpans(value.data.spans) } } as B;
    case 'list':
      return { ...value, data: { ...value.data, items: value.data.items.map((item) => canonicalSpans(item)) } } as B;
    case 'comparison':
      return {
        ...value,
        data: {
          ...value.data,
          columns: value.data.columns.map((column) => ({
            ...column,
            points: column.points.map((point) => canonicalSpans(point)),
          })),
        },
      } as B;
    case 'timeline':
      return {
        ...value,
        data: {
          ...value.data,
          events: value.data.events.map((event) =>
            event.detail === undefined ? event : { ...event, detail: canonicalSpans(event.detail) },
          ),
        },
      } as B;
    case 'sequence':
      return {
        ...value,
        data: {
          ...value.data,
          steps: value.data.steps.map((step) => ({ ...step, spans: canonicalSpans(step.spans) })),
        },
      } as B;
    case 'disclosure':
      return {
        ...value,
        data: { ...value.data, blocks: value.data.blocks.map((child) => canonicaliseBlockText(child)) },
      } as B;
    case 'subheading':
    case 'code':
    case 'table':
    case 'figure':
    case 'media':
    case 'diagram':
    case 'chart':
    case 'simulation':
    case 'fallback':
      return block;
  }
}
