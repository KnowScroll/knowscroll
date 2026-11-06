import { Pressable, StyleSheet, View } from 'react-native';
import { content, spacing, radius } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import type { MentionOption } from './mention-input';

/** A local draft menu. Availability comes from the room's current read, never from typing or a model. */
export function MentionPicker({
  options,
  active,
  id,
  onPick,
}: {
  readonly options: readonly MentionOption[];
  readonly active: number;
  readonly id: string;
  readonly onPick: (option: MentionOption) => void;
}) {
  return (
    <View nativeID={id} role="menu" accessibilityLabel="AI residents to mention" style={styles.menu}>
      {options.length === 0 ? (
        <Text variant="meta">No matching AI residents in this room.</Text>
      ) : (
        options.map((option, index) => (
          <Pressable
            key={option.id}
            nativeID={`${id}-${option.id}`}
            role="menuitem"
            accessibilityLabel={`Mention ${option.name}, ${option.label}${option.status === undefined ? '' : `, ${option.status}`}`}
            accessibilityState={{ disabled: option.disabled === true }}
            disabled={option.disabled}
            onPointerDown={(event) => event.preventDefault()}
            onPress={() => onPick(option)}
            style={[styles.option, index === active ? styles.active : null, option.disabled ? styles.disabled : null]}
          >
            <View style={styles.who}>
              <Text variant="ui">{`@${option.name}`}</Text>
              <Text variant="metaS">{option.label}</Text>
            </View>
            {option.status === undefined ? null : <Text variant="metaS">{option.status}</Text>}
          </Pressable>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    backgroundColor: content.paper,
    borderWidth: 2,
    borderColor: content.ink,
    borderRadius: radius.card,
    padding: spacing[2],
    gap: spacing[1],
  },
  option: {
    minHeight: 48,
    padding: spacing[2],
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: radius.md,
    gap: spacing[1],
  },
  active: { borderColor: content.ink },
  disabled: { opacity: 0.55 },
  who: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' },
});
