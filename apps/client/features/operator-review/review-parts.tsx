import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { ReviewShow } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Banner, Button, Text, useTypeStyle } from '@knowscroll/ui';
import { findingChips, findingsOf, type FindingTone } from './review-copy';
import type { SourcedPart, SourcesIndex } from './review-sources';

/** The longest reason the gate keeps (`MAX_REJECT_REASON_CHARS`). */
export const REJECT_REASON_MAX = 500;

/** A small label whose words carry the meaning; the border only repeats it. */
export function ReviewChip({
  text,
  tone = 'ok',
  testID,
}: {
  readonly text: string;
  readonly tone?: FindingTone;
  readonly testID?: string;
}) {
  const edge = tone === 'attention' ? status.danger.edge : tone === 'note' ? content.muted : content.ink;
  return (
    <View testID={testID} style={[styles.chip, { borderColor: edge }]}>
      <Text variant="metaS" color={tone === 'attention' ? status.danger.foreground : content.ink}>
        {text}
      </Text>
    </View>
  );
}

const toneMark: Record<FindingTone, string> = { ok: 'OK', note: 'NOTE', attention: 'READ' };

/**
 * What the checks and the revision's facts say, at the top of the page in plain words: the answer check, the support check,
 * coverage and topic, then, below, the sentences the support check could not clear. Folded to a line of chips while reading.
 */
export function FindingsPanel({
  review,
  expanded,
  onToggle,
}: {
  readonly review: ReviewShow;
  readonly expanded: boolean;
  /** Absent where the panel is always open (the side panel of a desktop). */
  readonly onToggle?: (() => void) | undefined;
}) {
  const findings = findingsOf(review);
  const attention = review.supportCheck?.attention ?? [];
  return (
    <View style={styles.panel} testID="review-findings">
      <View style={styles.panelHead}>
        <Text variant="label" color={content.ink2} heading={2}>
          What the checks say
        </Text>
        {onToggle === undefined ? null : (
          <Button
            label={expanded ? 'Fold' : 'Unfold'}
            accessibilityLabel={expanded ? 'Fold the checks' : 'Unfold the checks'}
            size="sm"
            variant="ghost"
            toggled={expanded}
            onPress={onToggle}
            testID="review-findings-toggle"
          />
        )}
      </View>
      {expanded ? (
        <>
          {findings.map((finding) => (
            <View key={finding.id} style={styles.finding} testID={`review-finding-${finding.id}`}>
              <ReviewChip text={toneMark[finding.tone]} tone={finding.tone} />
              <Text variant="notice" style={styles.findingText}>
                {finding.text}
              </Text>
            </View>
          ))}
          {attention.length === 0 ? null : (
            <View style={styles.sentences} testID="review-sentences">
              <Text variant="metaS" color={content.ink2}>
                Sentences to read first
              </Text>
              {attention.map((sentence) => (
                <View key={sentence.n} style={styles.sentence}>
                  <Text variant="notice">
                    {sentence.text}
                    {sentence.problem === null ? '' : ` — ${sentence.problem}`}
                  </Text>
                  <Text variant="meta" color={content.ink2}>
                    {`${sentence.outcome === 'unsupported' ? 'Unsupported' : 'Unclear'} · ${sentence.field} · ${sentence.partId}`}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <Text variant="meta" color={content.ink2}>
            The checks are a model’s opinion. They inform the read and decide nothing: releasing is your call.
          </Text>
        </>
      ) : (
        <View style={styles.chips}>
          {findingChips(review).map((chip) => (
            <ReviewChip key={chip.text} text={chip.text} tone={chip.tone} />
          ))}
        </View>
      )}
    </View>
  );
}

/** The passages one part cites, each word for word with the title of its page. */
function PassageBlock({ part }: { readonly part: SourcedPart }) {
  return (
    <View style={styles.cited} testID={`review-sources-${part.partId}`}>
      <Text variant="monoXs" color={content.ink2}>
        {`Sources · ${part.label}`}
      </Text>
      {part.passages.map((passage, index) => (
        <View key={`${part.partId}-${String(index)}`} style={styles.passage}>
          <Text variant="bodyS">{`“${passage.quote}”`}</Text>
          <Text variant="meta" color={content.ink2}>
            {`— ${passage.source}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The sources that go under one beat of the essay (its own, and its asides'). */
export function SourcesUnder({ parts }: { readonly parts: readonly SourcedPart[] }) {
  if (parts.length === 0) return null;
  return (
    <View style={styles.sources}>
      {parts.map((part) => (
        <PassageBlock key={part.partId} part={part} />
      ))}
    </View>
  );
}

/** The sources of the parts no beat carries (a picture, the end summary), at the end of the essay. */
export function SourcesAtEnd({ sources }: { readonly sources: SourcesIndex }) {
  if (sources.rest.length === 0) return null;
  return (
    <View style={styles.sources} testID="review-sources-rest">
      {sources.rest.map((part) => (
        <PassageBlock key={part.partId} part={part} />
      ))}
    </View>
  );
}

/** What the screen is doing about a decision. */
export type DecisionState =
  | { readonly step: 'choose' }
  | { readonly step: 'confirm-release' }
  | { readonly step: 'reject'; readonly reason: string }
  | { readonly step: 'sending'; readonly action: 'release' | 'reject' }
  | { readonly step: 'refused'; readonly words: string }
  | { readonly step: 'gone' }
  | { readonly step: 'failed' };

/**
 * Release and Reject at the end of the essay. Each asks for a confirmation in the page, never in a browser dialog; Reject asks for
 * the reason the gate keeps. A refusal and a failure are said in words, and the buttons stay, so nothing is sent twice by a press
 * that seemed to do nothing.
 */
export function DecisionPanel({
  title,
  revision,
  coverage,
  documentVersion,
  state,
  onState,
  onRelease,
  onReject,
  onBackToList,
}: {
  readonly title: string;
  readonly revision: number;
  readonly coverage: ReviewShow['coverage'];
  readonly documentVersion: 'v2' | 'v3';
  readonly state: DecisionState;
  readonly onState: (next: DecisionState) => void;
  readonly onRelease: () => void;
  readonly onReject: (reason: string) => void;
  readonly onBackToList: () => void;
}) {
  const sending = state.step === 'sending';
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  const reason = state.step === 'reject' ? state.reason : '';
  return (
    <View style={styles.decision} testID="review-decision">
      <Text variant="heading" heading={2}>
        Decide
      </Text>
      <Text variant="bodyS" color={content.ink2}>
        {`Release serves revision ${String(revision)} of “${title}” to readers from now on. Reject keeps it out for good and frees the recipe’s next take.`}
      </Text>
      {documentVersion === 'v3' && coverage === 'unmapped' ? (
        <Banner
          kind="info"
          lead="Coverage is not mapped."
          message="The gate will refuse a release until it is. Run content readmit-coverage with the CLI first."
        />
      ) : null}
      {state.step === 'refused' ? (
        <Banner kind="error" lead="Not decided." message={state.words} testID="review-refused" />
      ) : null}
      {state.step === 'gone' ? (
        <Banner
          kind="info"
          lead="Already decided."
          message="This revision is not held any more, so there is nothing to decide."
          action={{ label: 'Back to the list', onPress: onBackToList }}
          testID="review-gone"
        />
      ) : null}
      {state.step === 'failed' ? (
        <Banner
          kind="error"
          lead="Could not send that."
          message="Nothing was changed that you can see here. Try again."
          testID="review-failed"
        />
      ) : null}
      {state.step === 'confirm-release' ? (
        <View
          style={styles.confirm}
          role="group"
          accessibilityLabel="Confirm the release"
          testID="review-confirm-release"
        >
          <Text variant="bodyS">Release it? Readers will see this revision from now on.</Text>
          <View style={styles.row}>
            <Button label="Release now" variant="primary" onPress={onRelease} testID="review-release-confirm" />
            <Button label="Not yet" variant="default" onPress={() => onState({ step: 'choose' })} />
          </View>
        </View>
      ) : null}
      {state.step === 'reject' ? (
        <View
          style={styles.confirm}
          role="group"
          accessibilityLabel="Reject with a reason"
          testID="review-confirm-reject"
        >
          <Text variant="uiS">Why is it being rejected?</Text>
          <TextInput
            testID="review-reject-reason"
            accessibilityLabel="Reason for rejecting"
            value={reason}
            onChangeText={(next) => onState({ step: 'reject', reason: next })}
            maxLength={REJECT_REASON_MAX}
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
          <Text variant="meta" color={content.ink2}>
            {`The reason is kept with the decision. Up to ${String(REJECT_REASON_MAX)} characters.`}
          </Text>
          <View style={styles.row}>
            <Button
              label="Reject now"
              variant="danger"
              disabled={reason.trim() === ''}
              onPress={() => onReject(reason)}
              testID="review-reject-confirm"
            />
            <Button label="Not yet" variant="default" onPress={() => onState({ step: 'choose' })} />
          </View>
        </View>
      ) : null}
      {state.step === 'confirm-release' || state.step === 'reject' ? null : (
        <View style={styles.row}>
          <Button
            label="Release"
            variant="primary"
            busy={state.step === 'sending' && state.action === 'release'}
            busyLabel="Releasing"
            disabled={sending || state.step === 'gone'}
            onPress={() => onState({ step: 'confirm-release' })}
            testID="review-release"
          />
          <Button
            label="Reject"
            variant="default"
            busy={state.step === 'sending' && state.action === 'reject'}
            busyLabel="Rejecting"
            disabled={sending || state.step === 'gone'}
            onPress={() => onState({ step: 'reject', reason: '' })}
            testID="review-reject"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: borderWidth.hairline,
    borderRadius: radius.tag,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    alignSelf: 'flex-start',
  },
  panel: {
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper2,
  },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing[2] },
  finding: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  findingText: { flexShrink: 1, flexGrow: 1, flexBasis: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  sentences: { gap: spacing[2] },
  sentence: {
    gap: spacing[1],
    paddingLeft: spacing[3],
    borderLeftWidth: borderWidth.regular,
    borderLeftColor: status.danger.edge,
  },
  sources: { gap: spacing[2], marginTop: spacing[2] },
  cited: {
    gap: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderLeftWidth: borderWidth.current,
    borderLeftColor: content.muted,
    backgroundColor: content.paper2,
  },
  passage: { gap: spacing[1] },
  decision: { gap: spacing[3], paddingVertical: spacing[6] },
  confirm: { gap: spacing[3] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  input: {
    minHeight: 96,
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    backgroundColor: content.paper2,
    color: content.ink,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    textAlignVertical: 'top',
  },
});
