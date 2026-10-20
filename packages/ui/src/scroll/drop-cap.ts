import { isGraphemeBoundary, type Span } from './model';

/** A run of inline text; `cap` marks the opening letter of an editorial paragraph. */
export type RenderSpan = Span & { readonly cap?: true };

export interface DropCap {
  readonly spans: readonly RenderSpan[];
  /** Props for the paragraph's `Text` (web: the attribute the `::first-letter` rule matches). */
  readonly textProps: Record<string, unknown>;
}

/** The end of the first letter (a whole grapheme) of `text`, or 0 for none. */
function firstLetterEnd(text: string): number {
  for (let offset = 1; offset <= text.length; offset += 1) if (isGraphemeBoundary(text, offset)) return offset;
  return 0;
}

/**
 * The opening letter of an editorial essay, enlarged. Native has no float, so the first grapheme
 * becomes its own larger run (an initial cap). The web file draws a true drop cap with
 * `::first-letter`. Either way the paragraph's text is unchanged: the same words in the same
 * order, so offsets and screen readers see one paragraph, not a letter and a remainder.
 */
export function dropCapOf(spans: readonly Span[], enabled: boolean): DropCap {
  const first = spans[0];
  if (!enabled || first === undefined) return { spans, textProps: {} };
  const end = firstLetterEnd(first.text);
  if (end === 0) return { spans, textProps: {} };
  const rest = first.text.slice(end);
  const head: RenderSpan = {
    text: first.text.slice(0, end),
    ...(first.marks === undefined ? {} : { marks: first.marks }),
    cap: true,
  };
  const tail: RenderSpan[] =
    rest === '' ? [] : [{ text: rest, ...(first.marks === undefined ? {} : { marks: first.marks }) }];
  return { spans: [head, ...tail, ...spans.slice(1)], textProps: {} };
}
