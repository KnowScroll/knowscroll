import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { ScenarioCard } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Icon, Text, useTypeStyle } from '@knowscroll/ui';
import { SPECULATIVE_NOTICE } from './branch-card';
import { kindWord } from '@knowscroll/client-core';

/** What a branch is, for the line under the thread's title (X03): "What if · a black hole were a portal". */
export function branchSubtitle(card: Pick<ScenarioCard, 'kind' | 'title'>): string {
  return `${kindWord(card)} · ${card.title}`;
}

/**
 * The navigator of a branch (X03): the way back first, naming where it goes, then the branch's own items.
 * A branch is one Scroll, so it has one item and no "next" to prepare: nothing here is invented.
 */
export function BranchNavigator({
  returnLabel,
  returnSpoken,
  onReturn,
}: {
  readonly returnLabel: string;
  readonly returnSpoken: string;
  readonly onReturn: () => void;
}) {
  return (
    <View style={styles.navigator} role="navigation" accessibilityLabel="This branch">
      <Button
        label={returnLabel}
        accessibilityLabel={returnSpoken}
        variant="continue"
        size="sm"
        icon="arrowLeft"
        onPress={onReturn}
        testID="branch-return"
      />
      <View style={styles.current} accessible accessibilityLabel="Item 1, current">
        <Text variant="uiS" color={content.onAccent}>
          1 · current
        </Text>
      </View>
    </View>
  );
}

/**
 * Over every item of a speculative branch (X03): said in words, as text of the premise, never as a second
 * status label beside Hypothetical (D-006 a).
 */
export function SpeculativeBanner() {
  return (
    <View style={styles.banner} role="note">
      <Icon name="hypothetical" size={14} color={status.hypothetical.foreground} />
      <Text variant="uiS" color={status.hypothetical.foreground}>
        {SPECULATIVE_NOTICE}
      </Text>
    </View>
  );
}

/**
 * "Try another assumption" (X03): a new what-if from here. The member's words go to the same sheet every
 * what-if goes through, which asks for directions; nothing is made by typing here.
 */
export function TryAnotherPrompt({
  onContinue,
  onDismiss,
}: {
  readonly onContinue: (words: string) => void;
  readonly onDismiss: () => void;
}) {
  const [words, setWords] = useState('');
  const type = useTypeStyle('bodyS');
  const text = words.trim();
  return (
    <View style={styles.prompt}>
      <Text variant="monoXs" color={content.ink2}>
        TRY ANOTHER ASSUMPTION
      </Text>
      <TextInput
        accessibilityLabel="Try another assumption"
        placeholder="What if…"
        placeholderTextColor={content.ink2}
        value={words}
        onChangeText={(next) => setWords(next.replaceAll(/[\r\n]+/gu, ' ').slice(0, 500))}
        maxLength={500}
        allowFontScaling={false}
        style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
      />
      <View style={styles.actions}>
        <Button label="Continue" variant="primary" size="sm" disabled={text === ''} onPress={() => onContinue(text)} />
        <Button label="Not now" variant="ghost" size="sm" onPress={onDismiss} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  navigator: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' },
  current: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing['1.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.accent,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
  prompt: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
    marginHorizontal: layout.gutter,
  },
  input: {
    minHeight: 44,
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
    backgroundColor: content.paper,
    color: content.ink,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  actions: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
});
