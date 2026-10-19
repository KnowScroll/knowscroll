import { StyleSheet, View } from 'react-native';
import { borderWidth, content, overlay, radius, spacing, status } from '@knowscroll/design-tokens';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';

/**
 * A non-interactive label. The only status labels are Hypothetical and Corrected (D-006 a: no
 * "Speculative"); `neutral` (topic, format, Related), `part` (continuation, yellow) and `onDark`
 * (over media or the map) are plain labels. Labels never carry scores, counts or "seen".
 */
export type TagVariant = 'neutral' | 'part' | 'onDark' | 'hypothetical' | 'corrected';

const looks: Record<
  TagVariant,
  { background: string; border: string; foreground: string; dashed: boolean; icon?: IconName }
> = {
  neutral: { background: content.paper, border: content.ink, foreground: content.ink, dashed: false },
  part: { background: content.continue, border: content.ink, foreground: content.onContinue, dashed: false },
  onDark: { background: 'transparent', border: overlay.onDarkEdge, foreground: content.paper, dashed: false },
  hypothetical: {
    background: status.hypothetical.background,
    border: status.hypothetical.edge,
    foreground: status.hypothetical.foreground,
    dashed: true,
    icon: 'hypothetical',
  },
  corrected: {
    background: status.corrected.background,
    border: status.corrected.edge,
    foreground: status.corrected.foreground,
    dashed: false,
  },
};

export interface TagProps {
  /** Sentence case ("Hypothetical", "Corrected · 14 Oct"); rendered in caps at normal text sizes. */
  readonly label: string;
  readonly variant?: TagVariant;
  readonly testID?: string;
}

export function Tag({ label, variant = 'neutral', testID }: TagProps) {
  const look = looks[variant];
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label.replace(/\s·\s/g, ', ')}
      style={[
        styles.tag,
        { backgroundColor: look.background, borderColor: look.border, borderStyle: look.dashed ? 'dashed' : 'solid' },
      ]}
    >
      {look.icon === undefined ? null : <Icon name={look.icon} size={12} color={look.foreground} />}
      <Text variant="label" color={look.foreground}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing['1.5'],
    minHeight: 26,
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
  },
});
