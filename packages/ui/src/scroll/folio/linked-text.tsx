import { Text as NativeText } from 'react-native';
import { LinkedPhrase } from './linked-phrase';
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
