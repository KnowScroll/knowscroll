import { Text as NativeText } from 'react-native';
import { useFocusRing } from '../../display/focus-ring';
import { usePagePalette } from '../page/page-palette';
import { COOL, WARM } from '../picture/palette';
import type { BeatLink } from './reading-model';

/** A stretch of a paragraph: plain words, or the words of one linked phrase. */
export interface TextSegment {
  readonly text: string;
  readonly link?: BeatLink | undefined;
}

/**
 * A paragraph cut at its linked phrases. Each phrase is found where it first stands; two phrases that would overlap
 * keep the one that starts first, and a phrase that is not in the paragraph is left out (the document's checks keep it
 * from happening, but the reader must not fail on it).
 */
export function segmentsOf(text: string, links: readonly BeatLink[]): readonly TextSegment[] {
  const found = links
    .map((link) => ({ link, start: text.indexOf(link.phrase) }))
    .filter((entry) => entry.start >= 0)
    .sort((first, second) => first.start - second.start);
  const segments: TextSegment[] = [];
  let at = 0;
  for (const { link, start } of found) {
    if (start < at) continue;
    if (start > at) segments.push({ text: text.slice(at, start) });
    segments.push({ text: link.phrase, link });
    at = start + link.phrase.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

/** The colour a linked phrase is underlined in: the colour its part is drawn in, else the page's link colour. */
function underlineOf(link: BeatLink, pageLink: string): string {
  if (link.tone === 'warm') return WARM;
  if (link.tone === 'cool') return COOL;
  return pageLink;
}

interface KeyEvent {
  readonly nativeEvent: unknown;
  preventDefault(): void;
}

/**
 * What makes a phrase reachable and pressable from a keyboard. Web only in effect: a span with the button role is
 * neither focusable nor pressed by Enter or Space in a browser, and the reader's own keys act only while the reader
 * itself has focus, so Space here does not scroll. The props are not in React Native's types for a Text.
 */
function keyboardProps(press: () => void): object {
  return {
    focusable: true,
    tabIndex: 0,
    onKeyDown: (event: KeyEvent) => {
      const key = event.nativeEvent as { key?: string; repeat?: boolean };
      if (key.key !== 'Enter' && key.key !== ' ') return;
      event.preventDefault();
      if (key.repeat !== true) press();
    },
  };
}

/** One linked phrase: an inline button, underlined, in the text's own colour. */
function LinkedPhrase({ link, onPress }: { readonly link: BeatLink; readonly onPress: (part: string) => void }) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  const press = () => onPress(link.part);
  return (
    <NativeText
      {...focus.props}
      {...keyboardProps(press)}
      role="button"
      accessibilityRole="button"
      accessibilityLabel={`Show ${link.phrase} in the picture`}
      onPress={press}
      // The ring is drawn by the web's :focus-visible stylesheet (`focus.props`); Folio is web only for now (#740), and
      // a native inline text could not draw a view's outline anyway.
      style={{ textDecorationLine: 'underline', textDecorationColor: underlineOf(link, page.link) }}
    >
      {link.phrase}
    </NativeText>
  );
}

/**
 * The words of a paragraph with its linked phrases as inline buttons. The phrases are underlined and the words keep
 * the ink they were given. With no one to hear a press, or no links, they are plain words.
 */
export function linkedWords(
  text: string,
  links: readonly BeatLink[] | undefined,
  onLinkPress: ((part: string) => void) | undefined,
) {
  if (links === undefined || links.length === 0 || onLinkPress === undefined) return text;
  return segmentsOf(text, links).map((segment, index) =>
    segment.link === undefined ? (
      <NativeText key={index}>{segment.text}</NativeText>
    ) : (
      <LinkedPhrase key={index} link={segment.link} onPress={onLinkPress} />
    ),
  );
}
