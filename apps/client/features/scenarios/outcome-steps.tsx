import { StyleSheet, View } from 'react-native';
import type { ScenarioBlock } from '@knowscroll/client-core';
import type { ScenarioCard } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Spinner, Tag, Text } from '@knowscroll/ui';
import { sheetStyles } from './sheet-styles';

const blockMessage: Record<ScenarioBlock, string> = {
  budget:
    'No more branches can be made right now. A thread can make five a day, and KnowScroll has a limit each day too. Try again tomorrow.',
  unsupported: 'This can’t be explored yet: nothing it rests on can be looked up.',
  invalid: 'That wording isn’t accepted. Keep it to a plain sentence, without web addresses.',
  stale:
    'This idea changed, was already used, or took too long (an idea is kept for two hours). Nothing was made. Close this and start again from the thread.',
  unavailable: 'The thread, or the Scroll it is about, isn’t available any more. Nothing was made.',
  offline: 'Couldn’t reach KnowScroll. Nothing was lost; try again.',
  failed: 'Something went wrong on our side. Nothing was made. Try again.',
};

/** The sixth branch of a thread's day: said as it is, with when it comes back (the UTC day starts at midnight UTC). */
const THREAD_FULL_MESSAGE =
  'This thread has made its five branches for today. It can make more tomorrow (the day changes at midnight UTC).';

/** Suggestions are spent for the day (or the provider's own limit): what is true, and when it comes back. */
const SUGGESTIONS_USED_UP = 'Today’s What-ifs are used up. They come back tomorrow (the day changes at midnight UTC).';

/** The directions are being thought of: wait, or write one's own meanwhile. */
export function ThinkingStep({ onOwn }: { readonly onOwn: () => void }) {
  return (
    <View style={sheetStyles.step}>
      <View style={styles.thinking} role="status" accessibilityLabel="Thinking of directions">
        <Spinner size={18} color={content.ink} />
        <Text variant="bodyS">Thinking of directions…</Text>
      </View>
      <Text variant="meta" color={content.ink2}>
        You can wait, or write your own version now.
      </Text>
      <Button label="Write my own version" variant="ghost" fullWidth onPress={onOwn} />
    </View>
  );
}

/** No directions came: say so plainly and offer the member's own version. */
export function NoSuggestionsStep({
  reason,
  onOwn,
  onClose,
}: {
  readonly reason: 'could_not_suggest' | 'budget_unavailable' | undefined;
  readonly onOwn: () => void;
  readonly onClose: () => void;
}) {
  return (
    <View style={sheetStyles.step}>
      <Banner
        kind="info"
        lead="No suggestions."
        message={reason === 'budget_unavailable' ? SUGGESTIONS_USED_UP : 'We couldn’t think of directions this time.'}
      />
      <Button label="Write my own version" variant="primary" fullWidth onPress={onOwn} />
      <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

/** The branch exists (or already did): it is in the thread now and changes when it is ready. */
export function ChosenStep({
  card,
  reused,
  onClose,
}: {
  readonly card: ScenarioCard;
  readonly reused: boolean;
  readonly onClose: () => void;
}) {
  return (
    <View style={sheetStyles.step} role="status">
      <Tag variant="hypothetical" label={card.hypothetical ? 'Hypothetical' : 'Another perspective'} />
      <Text variant="ui">{reused ? 'This branch was already started.' : 'Branch started.'}</Text>
      <Text variant="bodyS" color={content.ink2}>
        {card.status === 'ready'
          ? 'It’s ready in the thread.'
          : 'It shows up in the thread now, and changes when it’s ready. You can keep chatting.'}
      </Text>
      <Button label="Back to the thread" variant="primary" fullWidth onPress={onClose} />
    </View>
  );
}

/** Something stopped it: what, in words, and a way to try again when only the network did. */
export function BlockedStep({
  block,
  threadFull = false,
  onRetry,
  onClose,
}: {
  readonly block: ScenarioBlock;
  /** This thread has made its five branches for the day: the refusal says so, instead of the wider limit. */
  readonly threadFull?: boolean;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  return (
    <View style={sheetStyles.step}>
      <Banner
        kind={block === 'offline' ? 'offline' : 'error'}
        lead={block === 'offline' ? 'Offline.' : block === 'failed' ? 'Didn’t go through.' : 'Can’t do that.'}
        message={block === 'budget' && threadFull ? THREAD_FULL_MESSAGE : blockMessage[block]}
      />
      {block === 'offline' || block === 'failed' ? (
        <Button label="Try again" variant="primary" fullWidth icon="retry" onPress={onRetry} />
      ) : null}
      <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
});
