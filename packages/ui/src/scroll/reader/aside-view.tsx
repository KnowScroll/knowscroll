import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { Aside } from '@knowscroll/scroll-model';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';

/** What an aside is called to the reader: the limits aside is "Small print". */
function asideLabel(kind: Aside['kind']): string {
  return kind === 'limits' ? 'Small print' : kind === 'tangent' ? 'Tangent' : 'Definition';
}

/**
 * A side box next to the stop it belongs to, collapsed unless the document opens it. Reading on never
 * needs it; "Small print" is where the limits of the idea live.
 */
export function AsideView({
  aside,
  expanded,
  onToggle,
}: {
  readonly aside: Aside;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.aside} testID={`aside-${aside.id}`}>
      <Pressable
        {...focus.props}
        accessibilityRole="button"
        accessibilityLabel={`${asideLabel(aside.kind)}: ${aside.title}`}
        aria-expanded={expanded}
        onPress={onToggle}
        style={[styles.asideHeader, focus.style]}
      >
        <View style={styles.asideTitle}>
          <Text variant="label" color={content.ink2}>
            {asideLabel(aside.kind)}
          </Text>
          <Text variant="ui">{aside.title}</Text>
        </View>
        <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={18} />
      </Pressable>
      {expanded ? <Text variant="bodyS">{aside.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  aside: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  asideHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], minHeight: 44 },
  asideTitle: { flex: 1, gap: 2 },
});
