import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, opacity, radius, spacing, target } from '@knowscroll/design-tokens';
import { Banner, Icon, Text, useTypeStyle, type IconName } from '@knowscroll/ui';
import { useNotInterested } from './use-feedback';

/** One row of P03's menu: an icon, the action and, beneath it, what it means. */
export function FeedbackMenuRow({
  icon,
  label,
  detail,
  busy = false,
  disabled = false,
  onPress,
  testID,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly detail?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const inert = busy || disabled;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={detail === undefined ? label : `${label}. ${detail}`}
      accessibilityState={{ disabled: inert, busy }}
      aria-disabled={inert}
      disabled={inert}
      onPress={onPress}
      style={[styles.row, inert ? styles.inert : null]}
    >
      <View style={styles.rowIcon} aria-hidden>
        <Icon name={icon} size={20} />
      </View>
      <View style={styles.rowText}>
        <Text variant="ui">{busy ? `${label}…` : label}</Text>
        {detail === undefined ? null : (
          <Text variant="metaS" color={content.ink2}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * "Not interested" as a row: one tap saves it and moves on, with no reason asked. While it saves the row
 * is busy; a failure stays here with its Retry, so nothing seems saved that is not.
 */
export function NotInterestedRow({
  run,
  disabled = false,
}: {
  readonly run: () => Promise<boolean>;
  readonly disabled?: boolean;
}) {
  const marking = useNotInterested(run);
  return (
    <>
      <FeedbackMenuRow
        icon="close"
        label="Not interested"
        detail="Fewer like this one"
        busy={marking.saving}
        disabled={disabled}
        onPress={marking.run}
        testID="feedback-not-interested"
      />
      {marking.failed ? (
        <Banner
          kind="error"
          lead="Couldn’t save that."
          message="Nothing changed. Try again."
          action={{ label: 'Retry', onPress: marking.run }}
        />
      ) : null}
    </>
  );
}

/**
 * A single choice among a few reasons, drawn as chips: the chosen one is filled and says so with its
 * pressed state, never by colour alone. Each chip is a real radio, so a screen reader hears the group.
 */
export function ReasonChips<T extends string>({
  label,
  choices,
  value,
  onChoose,
}: {
  readonly label: string;
  readonly choices: readonly { readonly value: T; readonly label: string }[];
  readonly value: T | undefined;
  readonly onChoose: (value: T) => void;
}) {
  return (
    <View role="radiogroup" accessibilityLabel={label} style={styles.chips}>
      {choices.map((choice) => {
        const chosen = choice.value === value;
        return (
          <Pressable
            key={choice.value}
            role="radio"
            aria-checked={chosen}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={choice.label}
            onPress={() => onChoose(choice.value)}
            style={[styles.chip, chosen ? styles.chipChosen : null]}
          >
            <Text variant="uiS" color={chosen ? content.paper : content.ink}>
              {choice.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The optional note: a few lines, limited to what the server takes, and never required. */
export function NoteField({
  label,
  value,
  onChange,
  maxLength,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly maxLength: number;
  readonly testID?: string;
}) {
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text variant="uiS">{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        multiline
        allowFontScaling={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            fontFamily: type.fontFamily,
            fontSize: type.fontSize,
            lineHeight: type.lineHeight,
            borderColor: focused ? content.accent : content.ink,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 56,
    paddingVertical: spacing[2],
    borderTopWidth: 1,
    borderTopColor: content.rule,
    cursor: 'pointer' as const,
  },
  inert: { opacity: opacity.disabled },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: spacing['0.5'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    minHeight: target.minimum,
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as const,
  },
  chipChosen: { backgroundColor: content.ink },
  field: { gap: spacing[1] },
  input: {
    minHeight: 84,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    color: content.ink,
    backgroundColor: content.paper,
    textAlignVertical: 'top',
  },
});
