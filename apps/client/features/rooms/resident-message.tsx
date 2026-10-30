import { StyleSheet, View } from 'react-native';
import type { AiContributionKind, RoomSpeechTrigger } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

/** What an AI contribution is, in words: "A counterexample", never a score. */
export const KIND_WORDS = {
  explanation: 'Explanation',
  assumption: 'An assumption to check',
  perspective: 'Another perspective',
  counterexample: 'A counterexample',
} as const satisfies Record<AiContributionKind, string>;

/**
 * Why a resident spoke without being asked, in one line. Built from the trigger the server names, never from
 * anything the model wrote, so it can only say what the room's rules did.
 */
export const WHY_WORDS = {
  unanswered_question: 'Answering a question nobody had answered yet',
  overstated_claim: 'Asking about something said very strongly',
  answer_overstated: 'Replying to something said very strongly above',
} as const satisfies Record<RoomSpeechTrigger, string>;

/**
 * The head of a resident's message: its name, the AI label that never comes off, what kind of contribution it is and,
 * when it spoke on its own, why. The name goes first, so a reader sees who is speaking and, beside it, that it is an AI.
 */
export function ResidentHeader({
  name,
  label,
  suggestion,
  trigger,
}: {
  readonly name: string;
  readonly label: string;
  readonly suggestion: AiContributionKind | undefined;
  readonly trigger: RoomSpeechTrigger | undefined;
}) {
  return (
    <View style={styles.head} testID="resident-header">
      <View style={styles.line}>
        <Text variant="ui">{name}</Text>
        <AiLabel label={label} />
        {suggestion === undefined ? null : (
          <Text variant="metaS" color={content.ink2}>
            {KIND_WORDS[suggestion]}
          </Text>
        )}
      </View>
      {trigger === undefined ? null : (
        <Text variant="metaS" color={content.ink2} testID="resident-why">
          {WHY_WORDS[trigger]}
        </Text>
      )}
    </View>
  );
}

/**
 * The one line a Quieter reader sees in place of a resident's unprompted message. The words are one tap away.
 */
export function FoldedResident({ name, onShow }: { readonly name: string; readonly onShow: () => void }) {
  return (
    <View style={styles.line} testID="resident-folded">
      <Text variant="metaS" color={content.ink2}>
        {name} added something.
      </Text>
      <Button label="Show" size="sm" variant="ghost" onPress={onShow} testID="resident-show" />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: spacing[1] },
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
});
