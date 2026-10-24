import { StyleSheet, View } from 'react-native';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { borderWidth, content } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

const colours = [
  { background: content.continue, foreground: content.onContinue },
  { background: content.fresh, foreground: content.ink },
] as const;

/** The first letter of a name, as a person reads it (a whole code point, not half a character). */
export function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * A person's avatar: a circle with their initial, two cream-friendly fills chosen from the
 * person's public ID so a name keeps its colour. Decoration only: the name is always written
 * beside it, so it is hidden from screen readers.
 */
export function PersonAvatar({ person, size = 44 }: { readonly person: PublicPersonRef; readonly size?: number }) {
  const parity = Number.parseInt(person.personId.slice(-1), 16) % 2;
  const look = colours[parity] ?? colours[0];
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: look.background }]}
    >
      <Text variant="ui" color={look.foreground}>
        {initialOf(person.displayName)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
});
