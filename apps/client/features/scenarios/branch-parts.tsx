import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ScenarioCard } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton } from '@knowscroll/ui';

/**
 * What a branch the Planner flagged says of its premise. It is the premise's own text, not a second status
 * label: the only status labels are Hypothetical and Corrected (D-006 a).
 */
export const SPECULATIVE_NOTICE = 'Speculative scenario · not established science';

/**
 * What a ready branch offers beside Explore this: ask What if from it, and (its starter) remove it. A card that
 * already has Branch again on it leaves the first out (`withContinue` false).
 */
export function BranchMenu({
  card,
  starterIsYou,
  withContinue = true,
  onRemove,
  onContinue,
}: {
  readonly card: ScenarioCard;
  readonly starterIsYou: boolean;
  readonly withContinue?: boolean;
  readonly onRemove: (card: ScenarioCard) => void;
  readonly onContinue: (card: ScenarioCard) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (action: (card: ScenarioCard) => void) => () => {
    setOpen(false);
    action(card);
  };
  return (
    <>
      <IconButton icon="more" label="More about this branch" variant="plain" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title={card.title} onClose={() => setOpen(false)}>
        <View style={styles.menu}>
          {card.status === 'ready' && withContinue ? (
            <Button label="What if…" icon="hypothetical" fullWidth variant="ghost" onPress={choose(onContinue)} />
          ) : null}
          {starterIsYou ? <Button label="Remove" fullWidth variant="ghost" onPress={choose(onRemove)} /> : null}
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  menu: { gap: spacing[3], paddingBottom: spacing[2] },
});
