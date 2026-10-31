import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { ScenarioCard } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Icon, Text, useTypeStyle } from '@knowscroll/ui';
import { SPECULATIVE_NOTICE } from './branch-parts';
import { kindedTitle } from '@knowscroll/client-core';

/** What a branch is, for the line under the thread's title (X03): "What if · a black hole were a portal". */
export const branchSubtitle = (card: Pick<ScenarioCard, 'kind' | 'title'>): string => kindedTitle(card);

/**
 * The navigator of a branch (X03): the way back first, naming where it goes, then the branch's own item. A branch
 * is one Scroll, so it has one item and no "next" to prepare: nothing here is invented. Until the Scroll exists
 * the item says it is being prepared, and a branch with no item (removed, failed) shows only the way back.
 */
export function BranchNavigator({
  returnLabel,
  returnSpoken,
  item,
  onReturn,
}: {
  readonly returnLabel: string;
  readonly returnSpoken: string;
  readonly item: 'current' | 'preparing' | undefined;
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
      {item === undefined ? null : (
        <View
          style={[styles.current, item === 'preparing' ? styles.preparingItem : null]}
          accessible
          accessibilityLabel={item === 'current' ? 'Item 1, current' : 'Item 1, preparing'}
        >
          <Text variant="uiS" color={item === 'current' ? content.onAccent : content.ink2}>
            {item === 'current' ? '1 · current' : '1 · preparing'}
          </Text>
        </View>
      )}
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
  /** A dashed muted edge says "not here yet", as every preparing thing does. */
  preparingItem: { borderStyle: 'dashed', borderColor: content.muted, backgroundColor: content.paper2 },
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
