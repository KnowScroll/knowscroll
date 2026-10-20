import { StyleSheet, View } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocument } from '@knowscroll/scroll-model';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';

/** "A Scroll · 6 min": the reading time is the document's own code-set value (`measures`). */
function readingLine(document: ScrollDocument): string {
  return `A Scroll · ${document.measures.readingMinutes} min`;
}

/**
 * The poster opening (E02-1): a framed title card with the cobalt offset shadow, the topic tag,
 * the title as the page's level-1 heading, the dek and the reading time.
 */
export function PosterHeader({ document }: { readonly document: ScrollDocument }) {
  return (
    <View style={styles.poster}>
      <Tag label={document.kicker} />
      <Text variant="displayXl" heading={1}>
        {document.title}
      </Text>
      <Text variant="body" color={content.ink2}>
        {document.dek}
      </Text>
      <Text variant="label" color={content.ink2}>
        {readingLine(document)}
      </Text>
    </View>
  );
}

/** The editorial opening (E09-2): kicker line, title and dek set as an essay, no card. */
export function EditorialHeader({ document }: { readonly document: ScrollDocument }) {
  return (
    <View style={styles.editorial}>
      <Text variant="label" color={content.ink2}>
        {document.kicker}
      </Text>
      <Text variant="displayL" heading={1}>
        {document.title}
      </Text>
      <Text variant="body" color={content.ink2}>
        {document.dek}
      </Text>
      <Text variant="label" color={content.ink2}>
        {readingLine(document)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  poster: {
    gap: spacing[3],
    padding: spacing[5],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.hero,
  },
  editorial: { gap: spacing['3.5'] },
});
