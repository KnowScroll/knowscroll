import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { IconButton } from '../../actions/icon-button';
import { Text } from '../../text/text';
import { dataSet } from './data-set';

/**
 * What a card says, in the words a person sees. The words come from the app's session; the card draws them and says
 * nothing about how they were made.
 */
export type QuickAnswerView = (
  | { readonly phase: 'working' }
  | { readonly phase: 'answered'; readonly question: string; readonly answer: string; readonly covered: boolean }
  | {
      readonly phase: 'unavailable';
      /** One plain sentence: why there is no answer. */
      readonly message: string;
    }
) & {
  /**
   * Whether "Make it a full Scroll" is a way on: not where the screen has no Ask, not while recording is paused (a full
   * Scroll is made from what was read) and not while the answer is still being made.
   */
  readonly canMakeScroll: boolean;
};

export interface QuickAnswerCardProps {
  readonly view: QuickAnswerView;
  /** "Quick answer · not a checked Scroll": the server's own words, drawn every time the card is. */
  readonly label: string;
  /** The most characters a follow-up may have. */
  readonly followUpMax: number;
  /** "Make it a full Scroll": the checked version, through Ask from here. */
  readonly onMakeScroll: () => void;
  /** Opens the content-error report about this answer. */
  readonly onReport: () => void;
  /** Sends the person's own follow-up about the same words. */
  readonly onFollowUp: (question: string) => void;
  /** Closes the card; its words are erased. */
  readonly onClose: () => void;
}

/**
 * The Quick answer under the words a person selected (V3 D2): a short answer made when they asked, that no one checked.
 * It says so every time ("Quick answer · not a checked Scroll"), offers the checked version ("Make it a full Scroll"), can
 * be reported, and closes. It is never part of the Scroll: it sits under a stop, its text cannot be selected for another
 * answer (`data-ks-no-ask`), and nothing here is evidence.
 */
export function QuickAnswerCard({
  view,
  label,
  followUpMax,
  onMakeScroll,
  onReport,
  onFollowUp,
  onClose,
}: QuickAnswerCardProps) {
  const [following, setFollowing] = useState(false);
  const [draft, setDraft] = useState('');
  const canSend = draft.trim().length >= 3;
  const send = () => {
    if (!canSend) return;
    onFollowUp(draft.trim());
    setFollowing(false);
    setDraft('');
  };
  return (
    <View
      role="region"
      aria-label={label}
      style={styles.card}
      testID="quick-answer-card"
      {...dataSet({ ksNoAsk: 'true' })}
    >
      <View style={styles.head}>
        <Text variant="monoXs" color={status.hypothetical.foreground} testID="quick-answer-label">
          {label.toUpperCase()}
        </Text>
        <IconButton
          icon="close"
          label="Close"
          variant="plain"
          size={44}
          onPress={onClose}
          testID="quick-answer-close"
        />
      </View>
      <View accessibilityLiveRegion="polite" role="status" style={styles.body}>
        {view.phase === 'working' ? (
          <Text variant="body" color={content.ink2} testID="quick-answer-working">
            Answering from what you have read…
          </Text>
        ) : view.phase === 'answered' ? (
          <>
            <Text variant="ui" testID="quick-answer-question">
              {view.question}
            </Text>
            <Text variant="bodyS" testID="quick-answer-answer">
              {view.answer}
            </Text>
          </>
        ) : (
          <Text variant="bodyS" testID="quick-answer-unavailable">
            {view.message}
          </Text>
        )}
      </View>
      {following ? (
        <View style={styles.follow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={send}
            maxLength={followUpMax}
            placeholder="Ask about the same words"
            placeholderTextColor={content.ink2}
            accessibilityLabel="Your follow-up question"
            returnKeyType="send"
            autoFocus
            style={styles.input}
            testID="quick-answer-follow-input"
          />
          <Button label="Ask" size="sm" onPress={send} disabled={!canSend} testID="quick-answer-follow-send" />
        </View>
      ) : null}
      <View style={styles.actions}>
        {view.phase === 'working' || !view.canMakeScroll ? null : (
          <Button
            label="Make it a full Scroll"
            size="sm"
            variant="primary"
            onPress={onMakeScroll}
            testID="quick-answer-make-scroll"
          />
        )}
        {view.phase === 'answered' ? (
          <Button
            label="Ask a follow-up"
            size="sm"
            onPress={() => setFollowing((now) => !now)}
            expanded={following}
            testID="quick-answer-follow-up"
          />
        ) : null}
        {view.phase === 'answered' ? (
          <Button label="Report" size="sm" variant="ghost" onPress={onReport} testID="quick-answer-report" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  body: { gap: spacing[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  follow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  input: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    color: content.ink,
  },
});
