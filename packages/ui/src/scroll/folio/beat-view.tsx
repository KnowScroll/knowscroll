import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
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
  readonly onToggleSimpler: (beatId: string) => void;
  readonly openNotes: ReadonlySet<string>;
  readonly onToggleNote: (noteId: string) => void;
  /** In a hold that is showing another beat's picture: drawn quieter, so the eye finds the one the figure is about. */
  readonly quiet?: boolean;
  /** For a screen reader, which does not scroll a hold: what the held figure shows while this beat is read. */
  readonly figureWords?: string | undefined;
  /** What the screen draws under the beat (a Quick answer card). */
  readonly footer?: ReactNode;
}

/**
 * One beat of the essay: an optional subhead, its paragraphs and lines, the guide's line and its play block when it has
 * them, its side notes, and "Say it simpler", which swaps the words for the plainer ones the writer gave (no model is
 * asked, D-244). A question is a call drawn as text: the prompt as a line, then the explanation.
 */
export function BeatView({
  beat,
  textVersion,
  simpler,
  onToggleSimpler,
  openNotes,
  onToggleNote,
  quiet = false,
  figureWords,
  footer,
}: BeatViewProps) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  const ink = quiet ? page.ink2 : page.ink;
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
      {simpler && beat.simple !== undefined ? (
        <View style={[styles.simpler, { backgroundColor: page.raised }]} testID="simpler-text">
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
      {beat.simple === undefined ? null : (
        <Pressable
          {...focus.props}
          accessibilityRole="button"
          accessibilityLabel={simpler ? 'Undo simpler version' : 'Say it simpler'}
          onPress={() => onToggleSimpler(beat.id)}
          style={[styles.simplerLink, focus.style]}
          testID="simpler-toggle"
        >
          <Text variant="meta" color={page.link}>
            {simpler ? 'Undo simpler' : 'Say it simpler'}
          </Text>
        </Pressable>
      )}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  beat: { gap: spacing[3] },
  simpler: { padding: spacing[3], borderRadius: radius.card },
  simplerLink: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
});
