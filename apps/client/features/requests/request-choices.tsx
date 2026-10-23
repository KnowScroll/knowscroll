import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, focusRing, radius, spacing, target } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/** E04 exclusive options, with the same token dimensions as the shared pill buttons. */
export function RequestChoices<T extends string>({
  label,
  options,
  value,
  disabled,
  onSelect,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly disabled: boolean;
  readonly onSelect: (value: T) => void;
}) {
  const nodes = useRef<Partial<Record<T, { focus?: () => void } | null>>>({});
  const [focused, setFocused] = useState<T>();
  return (
    <View role="radiogroup" accessibilityLabel={label} style={styles.group}>
      {options.map((option, index) => (
        <Pressable
          key={option.value}
          ref={(node) => {
            nodes.current[option.value] = node;
          }}
          role="radio"
          aria-checked={value === option.value}
          accessibilityState={{ checked: value === option.value, disabled }}
          accessibilityLabel={option.label}
          disabled={disabled}
          aria-disabled={disabled}
          onFocus={() => setFocused(option.value)}
          onBlur={() => setFocused(undefined)}
          onPress={() => onSelect(option.value)}
          {...(Platform.OS === 'web'
            ? {
                tabIndex: value === option.value ? (0 as const) : (-1 as const),
                onKeyDown: (event: { nativeEvent: unknown; preventDefault: () => void }) => {
                  const key = (event.nativeEvent as { key?: string }).key;
                  if (
                    disabled ||
                    !key ||
                    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)
                  )
                    return;
                  event.preventDefault();
                  const previous = key === 'ArrowLeft' || key === 'ArrowUp';
                  const next =
                    options[
                      key === 'Home'
                        ? 0
                        : key === 'End'
                          ? options.length - 1
                          : (index + (previous ? -1 : 1) + options.length) % options.length
                    ];
                  if (next) {
                    onSelect(next.value);
                    nodes.current[next.value]?.focus?.();
                  }
                },
              }
            : {})}
          style={[
            styles.option,
            { backgroundColor: value === option.value ? content.ink : content.paper },
            focused === option.value ? styles.focus : undefined,
          ]}
        >
          <Text variant="ui" color={value === option.value ? content.paper : content.ink}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  option: {
    minHeight: target.comfortable,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[2],
    justifyContent: 'center',
    maxWidth: '100%',
  },
  focus: {
    outlineColor: focusRing.onLight.color,
    outlineWidth: focusRing.onLight.width,
    outlineOffset: focusRing.onLight.offset,
    outlineStyle: 'solid',
  },
});
