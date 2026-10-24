import { StyleSheet, View } from 'react-native';
import type { FeedbackStore } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text } from '@knowscroll/ui';
import { useFeedbackState } from './use-feedback';

/**
 * What a person needs to know after "Not interested" (P03 card 2): a quiet acknowledgement with Undo for
 * a few seconds, and honest failure. No reason is asked. Announced politely; Undo stays focusable.
 */
export function NotInterestedNotice({
  store,
  onUndo,
  onRetry,
}: {
  readonly store: FeedbackStore;
  readonly onUndo: () => void;
  readonly onRetry: () => void;
}) {
  const { notInterested } = useFeedbackState(store);
  switch (notInterested.status) {
    case 'idle':
      return null;
    case 'saving':
      return <Banner kind="reconnecting" lead="Saving." message="One moment." />;
    case 'undoing':
      return <Banner kind="reconnecting" lead="Taking that back." message="One moment." />;
    case 'failed':
      return notInterested.step === 'mark' ? (
        <Banner
          kind="error"
          lead="Couldn’t save that."
          message="It hasn’t changed what you’re offered."
          action={{ label: 'Retry', onPress: onRetry }}
        />
      ) : (
        <Banner
          kind="error"
          lead="Couldn’t undo that."
          message="It is still saved."
          action={{ label: 'Retry', onPress: onRetry }}
        />
      );
    case 'acknowledged':
      return (
        <View role="status" accessibilityLiveRegion="polite" style={styles.ack} testID="not-interested-notice">
          <Icon name="check" size={20} color={content.paper} />
          <View style={styles.words}>
            <Text variant="uiS" color={content.paper}>
              Got it — fewer like this.
            </Text>
          </View>
          <Button label="Undo" size="sm" variant="space" onPress={onUndo} />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  ack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.ink,
  },
  words: { flex: 1 },
});
