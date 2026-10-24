import { Pressable, StyleSheet, View } from 'react-native';
import { formatRange } from '@knowscroll/client-core';
import type { ConversationContentProjection, SnippetCard as SnippetCardData } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Icon, Tag, Text, useFocusRing } from '@knowscroll/ui';

const titleOf = (card: ConversationContentProjection): string | undefined =>
  card.status === 'available'
    ? card.metadata.title
    : card.status === 'corrected'
      ? card.current.metadata.title
      : undefined;

/** The mono label above a card, from what the card points at: "Part 2 · Reel", "Passage · Scroll". */
function kindLabel(snippet: SnippetCardData, partLabel: string | undefined): string {
  const place = partLabel === undefined ? '' : `${partLabel} · `;
  switch (snippet.kind) {
    case 'reel_range':
      return `${place}Moment`;
    case 'scroll_passage':
      return `${place}Passage`;
    case 'scroll_block':
      return `${place}${snippet.blockType}`;
  }
}

/** What the card offers to do, in words. */
export function snippetAction(snippet: SnippetCardData): string {
  if (snippet.content.status === 'unavailable') return '';
  if (snippet.kind === 'reel_range') return 'Play';
  if (snippet.kind === 'scroll_passage') return 'Read in context';
  return snippet.settings.included ? 'Open as set' : 'Open';
}

/** The plain-words description a screen reader gets for the whole card. */
export function snippetDescription(snippet: SnippetCardData, partLabel: string | undefined): string {
  const title = titleOf(snippet.content) ?? 'content that is no longer available';
  const corrected = snippet.content.status === 'corrected' ? ', updated since it was shared' : '';
  switch (snippet.kind) {
    case 'reel_range':
      return `Moment ${formatRange(snippet.startMs, snippet.endMs)} of ${partLabel === undefined ? '' : `${partLabel}, `}${title}${corrected}`;
    case 'scroll_passage':
      return `Passage of ${title}${snippet.quote === undefined ? '' : `: ${snippet.quote}`}${corrected}`;
    case 'scroll_block':
      return `${snippet.label ?? snippet.blockType} of ${title}, ${snippet.settings.included ? 'settings included' : 'settings not included'}${corrected}`;
  }
}

/**
 * An anchored snippet in the thread (H03): a point in the original Reel or Scroll, never a copy. It
 * says what it points at and offers to open it; receiving or looking at it is not reading or
 * watching. A corrected source keeps the card and says so (the viewer then says whether the moment
 * holds); withdrawn content leaves a quiet note and no quote.
 */
export function SnippetCard({
  snippet,
  partLabel,
  onOpen,
}: {
  readonly snippet: SnippetCardData;
  /** "Part 2" when the content is an episode of a declared series. */
  readonly partLabel: string | undefined;
  readonly onOpen: () => void;
}) {
  const focus = useFocusRing('onLight');
  const unavailable = snippet.content.status === 'unavailable';
  if (unavailable)
    return (
      <View style={[styles.card, styles.unavailable]} testID="snippet-unavailable">
        <Tag variant="neutral" label="Unavailable" />
        <Text variant="bodyS">This moment is no longer available.</Text>
        <Text variant="meta" color={content.ink2}>
          The message stays; the content doesn’t.
        </Text>
      </View>
    );
  const action = snippetAction(snippet);
  const corrected = snippet.content.status === 'corrected';
  return (
    <Pressable
      {...focus.props}
      role="button"
      accessibilityLabel={snippetDescription(snippet, partLabel)}
      accessibilityHint={action}
      onPress={onOpen}
      style={[styles.card, corrected ? styles.corrected : null, focus.style]}
      testID="snippet-card"
    >
      <View style={styles.top}>
        <Text variant="monoXs" color={content.ink2}>
          {kindLabel(snippet, partLabel)}
        </Text>
        {corrected ? <Tag variant="corrected" label="Updated" /> : null}
      </View>
      {snippet.kind === 'reel_range' ? (
        <View style={styles.reel}>
          <View style={styles.thumb}>
            <Icon name="play" size={18} color={content.paper} />
          </View>
          <View style={styles.reelText}>
            <Text variant="ui">{formatRange(snippet.startMs, snippet.endMs)}</Text>
            <Text variant="meta" color={content.ink2} numberOfLines={2}>
              {titleOf(snippet.content)}
            </Text>
          </View>
        </View>
      ) : null}
      {snippet.kind === 'scroll_passage' ? (
        <Text variant="bodyS" numberOfLines={5} style={styles.quote}>
          {snippet.quote === undefined ? '' : `“${snippet.quote}”`}
        </Text>
      ) : null}
      {snippet.kind === 'scroll_block' ? (
        <View style={styles.block}>
          <Text variant="ui" numberOfLines={3}>
            {snippet.label ?? titleOf(snippet.content)}
          </Text>
          {snippet.settings.included ? (
            <View style={styles.chip}>
              <Text variant="monoXs">
                {snippet.settings.description === undefined || snippet.settings.description === ''
                  ? 'Set as shared'
                  : snippet.settings.description}
              </Text>
            </View>
          ) : (
            <Text variant="meta" color={content.ink2}>
              Settings not included
            </Text>
          )}
          {snippet.settings.included && snippet.settings.personalIncluded ? (
            <Text variant="meta" color={content.ink2}>
              Includes the sender’s own value
            </Text>
          ) : null}
        </View>
      ) : null}
      {corrected ? (
        <Text variant="meta" color={status.corrected.foreground}>
          This was updated after it was shared. Opening it says whether the moment still holds.
        </Text>
      ) : null}
      <Text variant="uiS" color={content.accent}>
        {action}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 280,
    maxWidth: '100%',
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  corrected: { borderColor: status.corrected.edge, backgroundColor: status.corrected.background },
  unavailable: { borderStyle: 'dashed', borderColor: content.muted },
  top: { flexDirection: 'row', gap: spacing[2], alignItems: 'center', flexWrap: 'wrap' },
  reel: { flexDirection: 'row', gap: spacing[3], alignItems: 'center' },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.thumb,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelText: { flex: 1, gap: spacing[0.5] },
  quote: { fontStyle: 'italic' },
  block: { gap: spacing[2], alignItems: 'flex-start' },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: 999,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
  },
});
