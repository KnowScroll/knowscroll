import { Fragment } from 'react';
import { Text as NativeText, type TextStyle } from 'react-native';
import { content, fontFamily } from '@knowscroll/design-tokens';
import { useTypeStyle } from '../text/text';
import { passageAttributes } from './data-attributes';
import type { RenderSpan } from './drop-cap';

/** Where each span starts in the block's plain text (`text-projection.v1`, UTF-16 code units). */
export function spanOffsets(spans: readonly Pick<RenderSpan, 'text'>[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const span of spans) {
    offsets.push(at);
    at += span.text.length;
  }
  return offsets;
}

export interface RichSpansProps {
  readonly spans: readonly RenderSpan[];
  /** The block the text belongs to; its offsets are exposed on the web for selection mapping. */
  readonly blockId: string;
  /** Offset of the first span inside the block's projection (list items start after the previous ones). */
  readonly baseOffset?: number;
}

/**
 * Inline text as nested runs inside a `Text`: emphasis italic, strong bold, code in the mono face
 * on the sunken ground. The runs are concatenated with nothing between them, so the rendered text
 * is exactly the block's passage projection, and every run carries its start offset on the web.
 */
export function RichSpans({ spans, blockId, baseOffset = 0 }: RichSpansProps) {
  const body = useTypeStyle('body');
  const code: TextStyle = {
    fontFamily: fontFamily.mono,
    fontWeight: '500',
    fontSize: Math.round(body.fontSize * 0.84),
    backgroundColor: content.paper2,
  };
  const initialCap: TextStyle = {
    fontFamily: fontFamily.display,
    fontWeight: '800',
    fontSize: Math.round(body.fontSize * 1.9),
    color: content.accent,
  };
  const offsets = spanOffsets(spans);
  return (
    <>
      {spans.map((span, index) => {
        const marks = span.marks ?? [];
        const style: TextStyle[] = [];
        if (marks.includes('code')) style.push(code);
        if (marks.includes('em')) style.push({ fontStyle: 'italic' });
        if (marks.includes('strong')) style.push({ fontWeight: '700' });
        if (span.cap === true) style.push(initialCap);
        return (
          <Fragment key={index}>
            <NativeText style={style} {...passageAttributes(blockId, baseOffset + (offsets[index] ?? 0))}>
              {span.text}
            </NativeText>
          </Fragment>
        );
      })}
    </>
  );
}
