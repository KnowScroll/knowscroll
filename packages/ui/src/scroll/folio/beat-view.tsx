import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, spacing } from '@knowscroll/design-tokens';
import { ScreenReaderOnly } from '../../display/screen-reader-only';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { GuideView, PlayBlockView } from '../play-blocks';
import { AsideView } from '../reader/aside-view';
import type { Beat } from './reading-model';

export interface BeatViewProps {
  readonly beat: Beat;
  readonly textVersion: boolean;
  readonly simpler: boolean;
  readonly openNotes: ReadonlySet<string>;
  readonly onToggleNote: (noteId: string) => void;
  /** In a hold that is showing another beat's picture: drawn quieter, so the eye finds the one the figure is about. */
  readonly quiet?: boolean;
  /** For a screen reader, which does not scroll a hold: what the held figure shows while this beat is read. */
  readonly figureWords?: string | undefined;
  /** What the screen draws under the beat (a Quick answer card). */
  readonly footer?: ReactNode;
  /** The footer was laid out: how far its bottom is below the beat's top. */
  readonly onFooterLayout?: ((bottom: number) => void) | undefined;
}

/**
 * One beat of the essay: an optional subhead, its paragraphs and lines, the guide's line and its play block when it has
 * them and its side notes. When the person has switched the beat to its plainer words (the ••• row Simpler, Shift + S or
 * the selection menu), the paragraphs give way to the ones the writer gave (no model is asked, D-244); the beat draws no
 * link of its own for that (D-429); it says so instead, with a small "Plainer words" label above the text and a polite
 * announcement of the change (and of the change back). A question is a call drawn as text: the prompt as a line, then the explanation.
 */
export function BeatView({
  beat,
  textVersion,
  simpler,
  openNotes,
  onToggleNote,
  quiet = false,
  figureWords,
  footer,
  onFooterLayout,
}: BeatViewProps) {
  const page = usePagePalette();
  const ink = quiet ? page.ink2 : page.ink;
  const showSimpler = simpler && beat.simple !== undefined;
  const said = useSimplerAnnouncement(beat.simple !== undefined, showSimpler);
  return (
    <View style={styles.beat} testID={`beat-${beat.id}`}>
      {figureWords === undefined ? null : (
        <ScreenReaderOnly>
          <Text variant="body">{`The picture now shows: ${figureWords}`}</Text>
        </ScreenReaderOnly>
      )}
      {beat.heading === undefined ? null : (
        <Text variant="title" heading={3} color={ink}>
          {beat.heading}
        </Text>
      )}
      {beat.simple === undefined ? null : (
        // Always there for a beat that has plainer words, so that the change is announced rather than a new region found.
        <ScreenReaderOnly>
          <View role="status" accessibilityLiveRegion="polite" testID="simpler-status">
            <Text variant="body">{said}</Text>
          </View>
        </ScreenReaderOnly>
      )}
      {showSimpler ? (
        <View style={[styles.simpler, { backgroundColor: page.raised }]} testID="simpler-text">
          <Text variant="label" color={page.ink2} testID="simpler-label">
            Plainer words
          </Text>
          <Text variant="body" color={ink}>
            {beat.simple}
          </Text>
        </View>
      ) : (
        beat.text.map((part, index) =>
          part.kind === 'line' ? (
            <Text key={index} variant="title" color={ink}>
              {part.text}
            </Text>
          ) : (
            <Text key={index} variant="body" color={ink}>
              {part.text}
            </Text>
          ),
        )
      )}
      {beat.guide === undefined ? null : <GuideView guide={beat.guide} asText={textVersion} />}
      {beat.play === undefined ? null : <PlayBlockView interactive={beat.play} readerAsText={textVersion} />}
      {beat.notes.map((note) => (
        <AsideView
          key={note.id}
          aside={note}
          expanded={openNotes.has(note.id)}
          onToggle={() => onToggleNote(note.id)}
        />
      ))}
      {footer === undefined || footer === null ? null : (
        <View onLayout={(event) => onFooterLayout?.(event.nativeEvent.layout.y + event.nativeEvent.layout.height)}>
          {footer}
        </View>
      )}
    </View>
  );
}

/**
 * What a screen reader is told when a beat's words change to the plainer ones or back: nothing until they have changed,
 * unless the beat arrives already in plainer words.
 */
function useSimplerAnnouncement(hasSimpler: boolean, showing: boolean): string {
  const [said, setSaid] = useState('');
  const first = useRef(true);
  useEffect(() => {
    const arrived = first.current;
    first.current = false;
    if (!hasSimpler || (arrived && !showing)) return;
    setSaid(showing ? 'Showing this part in plainer words.' : 'Showing the writer’s own words again.');
  }, [hasSimpler, showing]);
  return said;
}

const styles = StyleSheet.create({
  beat: { gap: spacing[3] },
  simpler: { padding: spacing[3], borderRadius: radius.card, gap: spacing[1] },
});
