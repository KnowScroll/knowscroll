import { StyleSheet, View } from 'react-native';
import type {
  AiContributionKind,
  InhabitantId,
  RoomKit,
  RoomMessageAsk,
  RoomSpeechTrigger,
} from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { ResidentMark } from './identity/room-emblem';
import { askedLine } from './ask-words';

/** What an AI contribution is, in words: "A counterexample", never a score. */
export const KIND_WORDS = {
  explanation: 'Explanation',
  assumption: 'An assumption to check',
  perspective: 'Another perspective',
  counterexample: 'A counterexample',
  find: 'A find',
} as const satisfies Record<AiContributionKind, string>;

/**
 * Why a resident spoke without being asked, in one line. Built from the trigger the server names, never from
 * anything the model wrote, so it can only say what the room's rules did.
 */
export const WHY_WORDS = {
  unanswered_question: 'Answering a question nobody had answered yet',
  overstated_claim: 'Asking about something said very strongly',
  answer_overstated: 'Replying to something said very strongly above',
  feed_find: 'Found something in the library that this room has not seen',
  scout_find: 'Found in the library, in the topics its sender chose',
} as const satisfies Record<RoomSpeechTrigger, string>;

/**
 * The head of a resident's message: its name, the AI label that never comes off, what kind of contribution it is and
 * why it spoke: because a member asked ("Asked by Lena · The other side") or, when it spoke on its own, the reason the
 * room's rules named. The name goes first, so a reader sees who is speaking and, beside it, that it is an AI.
 */
export function ResidentHeader({
  name,
  label,
  suggestion,
  trigger,
  ask,
  ownPersonId,
  kit,
  inhabitant,
  signature,
}: {
  readonly name: string;
  readonly label: string;
  readonly suggestion: AiContributionKind | undefined;
  readonly trigger: RoomSpeechTrigger | undefined;
  readonly ask?: RoomMessageAsk | undefined;
  readonly ownPersonId?: string | undefined;
  /** The room's kit and which resident this is: the mark it wears in this room (D-170). Absent, no mark is drawn. */
  readonly kit?: RoomKit | undefined;
  readonly inhabitant?: InhabitantId | undefined;
  /** "Sent by Asha": who a scout's note is signed by (D-259). A resident has none. */
  readonly signature?: string | undefined;
}) {
  return (
    <View style={styles.head} testID="resident-header">
      <View style={styles.line}>
        {kit === undefined || inhabitant === undefined ? null : (
          <ResidentMark kit={kit} resident={inhabitant} testID="resident-mark" />
        )}
        <Text variant="ui">{name}</Text>
        <AiLabel label={label} />
        {suggestion === undefined ? null : (
          <Text variant="metaS" color={content.ink2}>
            {KIND_WORDS[suggestion]}
          </Text>
        )}
      </View>
      {signature === undefined ? null : (
        <Text variant="metaS" testID="scout-signature">
          {signature}
        </Text>
      )}
      {trigger === undefined ? null : (
        <Text variant="metaS" color={content.ink2} testID="resident-why">
          {WHY_WORDS[trigger]}
        </Text>
      )}
      {ask === undefined ? null : (
        <Text variant="metaS" color={content.ink2} testID="resident-asked">
          {askedLine(ask, ownPersonId)}
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
