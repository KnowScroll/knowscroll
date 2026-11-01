import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  createReportFlow,
  formatClock,
  reportedPersonOf,
  type AccountScope,
  type FeedbackTarget,
  type ReportFlow,
  type ReportFlowState,
  type ReportKind,
} from '@knowscroll/client-core';
import { REPORT_NOTE_MAX } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { ABUSE_CHOICES, CONTENT_ERROR_CHOICES, receiptLine, whatHappensNext } from './feedback-copy';
import { FeedbackMenuRow, NoteField, NotInterestedRow, ReasonChips } from './feedback-parts';
import { useFeedbackStore } from './use-feedback';

/** What the sheet needs from the screen that opened it. */
export interface FeedbackContentProps {
  readonly scope: AccountScope;
  readonly target: FeedbackTarget;
  /** The form to open on: the menu of a Reel or Scroll, or straight on the abuse form. */
  readonly start: 'menu' | ReportKind;
  /** Closes the sheet. Nothing the flow holds outlives it. */
  readonly onClose: () => void;
  /**
   * "Not interested" for a Reel or Scroll, offered only where the screen can move on to the next subject
   * (the encounter). Resolves true once it is saved.
   */
  readonly onNotInterested?: () => Promise<boolean>;
}

function useFlow(flow: ReportFlow): ReportFlowState {
  return useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
}

function Heading({ children }: { readonly children: string }) {
  return (
    <Text variant="displayL" heading={3}>
      {children}
    </Text>
  );
}

/** The Reel or Scroll the form is about, with where in it a content error points (P03 card 3). */
function AboutCard({
  target,
  flow,
  state,
}: {
  readonly target: Extract<FeedbackTarget, { kind: 'asset' }>;
  readonly flow: ReportFlow;
  readonly state: ReportFlowState;
}) {
  const anchor = target.anchor;
  const moment =
    anchor === undefined
      ? undefined
      : anchor.kind === 'reel'
        ? `At ${formatClock(anchor.positionMs)}`
        : 'At the part you were reading';
  return (
    <View style={styles.about}>
      <View style={styles.aboutText}>
        {target.quickAnswerId === undefined ? null : (
          <Text variant="metaS" color={content.ink2}>
            The Quick answer you asked for, about
          </Text>
        )}
        <Text variant="uiS" numberOfLines={3}>
          {target.title}
        </Text>
        {moment === undefined || target.quickAnswerId !== undefined ? null : (
          <View style={styles.moment}>
            <Text variant="metaS" color={content.ink2}>
              {state.anchored ? moment : 'The whole thing'}
            </Text>
            <Button
              label={state.anchored ? 'Leave out the moment' : 'Point to the moment'}
              size="sm"
              variant="ghost"
              onPress={flow.toggleAnchor}
            />
          </View>
        )}
      </View>
    </View>
  );
}

function Menu({
  target,
  flow,
  onClose,
  onNotInterested,
}: {
  readonly target: Extract<FeedbackTarget, { kind: 'asset' }>;
  readonly flow: ReportFlow;
  readonly onClose: () => void;
  readonly onNotInterested: (() => Promise<boolean>) | undefined;
}) {
  return (
    <View style={styles.stack}>
      <Text variant="metaS" color={content.ink2}>
        {target.format === 'reel' ? 'Reel' : 'Scroll'}
      </Text>
      <Text variant="ui" numberOfLines={3}>
        {target.title}
      </Text>
      <View>
        {onNotInterested === undefined ? null : <NotInterestedRow run={onNotInterested} />}
        <FeedbackMenuRow
          icon="alert"
          label="Report a content error"
          detail="Something here seems wrong"
          onPress={flow.chooseContentError}
          testID="feedback-content-error"
        />
        <FeedbackMenuRow icon="shield" label="Report abuse" onPress={flow.chooseAbuse} testID="feedback-abuse" />
      </View>
      <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

function Form({
  target,
  flow,
  state,
  onBack,
}: {
  readonly target: FeedbackTarget;
  readonly flow: ReportFlow;
  readonly state: ReportFlowState;
  readonly onBack: (() => void) | undefined;
}) {
  const abuse = state.kind === 'abuse';
  const person = reportedPersonOf(target);
  return (
    <View style={styles.stack}>
      <Heading>{abuse ? 'Report abuse' : 'Report an error'}</Heading>
      {target.kind === 'asset' && !abuse ? <AboutCard target={target} flow={flow} state={state} /> : null}
      {abuse && person !== undefined ? (
        <Text variant="bodyS" color={content.ink2}>
          About {person.displayName}
          {target.kind === 'person' ? '' : '’s message'}. They won’t be told.
        </Text>
      ) : abuse ? (
        <Text variant="bodyS" color={content.ink2}>
          Nobody it is about will be told.
        </Text>
      ) : null}
      {abuse ? (
        <View style={styles.group}>
          <Text variant="uiS">What’s the problem?</Text>
          <ReasonChips
            label="What’s the problem?"
            choices={ABUSE_CHOICES}
            value={state.abuseCategory}
            onChoose={flow.setAbuseCategory}
          />
        </View>
      ) : (
        <View style={styles.group}>
          <Text variant="uiS">What seems wrong?</Text>
          <ReasonChips
            label="What seems wrong?"
            choices={CONTENT_ERROR_CHOICES}
            value={state.contentCategory}
            onChoose={flow.setContentCategory}
          />
        </View>
      )}
      <NoteField
        label="Add a note (optional)"
        value={state.note}
        onChange={flow.setNote}
        maxLength={REPORT_NOTE_MAX}
        testID="feedback-note"
      />
      {state.step === 'failed' ? <FailureBanner state={state} flow={flow} /> : null}
      <Button
        label="Send report"
        variant="primary"
        fullWidth
        disabled={!state.canSend}
        onPress={() => void flow.send()}
        testID="feedback-send"
      />
      {onBack === undefined ? null : <Button label="Back" variant="ghost" fullWidth onPress={onBack} />}
    </View>
  );
}

function FailureBanner({ state, flow }: { readonly state: ReportFlowState; readonly flow: ReportFlow }) {
  if (state.failure === 'too_many')
    return <Banner kind="error" lead="Too many reports today." message="Try again tomorrow." />;
  if (state.failure === 'unavailable')
    return <Banner kind="error" lead="Can’t report this." message="It isn’t available any more." />;
  return (
    <Banner
      kind="error"
      lead="Couldn’t send."
      message="Nothing was lost. Try again."
      action={{ label: 'Retry', onPress: () => void flow.send() }}
    />
  );
}

function Sending() {
  return (
    <View style={styles.stack}>
      <Button label="Send report" variant="primary" fullWidth busy busyLabel="Sending…" />
    </View>
  );
}

function Received({
  target,
  flow,
  state,
  onClose,
}: {
  readonly target: FeedbackTarget;
  readonly flow: ReportFlow;
  readonly state: ReportFlowState;
  readonly onClose: () => void;
}) {
  const person = reportedPersonOf(target);
  return (
    <View style={styles.stack} accessibilityLiveRegion="polite">
      <View style={styles.received}>
        <Icon name="check" size={26} />
        <Heading>Report received</Heading>
      </View>
      <Text variant="bodyS">{whatHappensNext(state.kind, target)}</Text>
      <View style={styles.receipt}>
        <Text variant="monoXs" color={content.ink2}>
          Receipt
        </Text>
        <Text variant="bodyS">{receiptLine(state, target, new Date())}</Text>
      </View>
      {person === undefined || state.block === 'unavailable' ? null : state.block === 'blocked' ? (
        <Text variant="bodyS">You blocked {person.displayName}. They aren’t told.</Text>
      ) : (
        <>
          {state.block === 'failed' ? (
            <Banner kind="error" lead="Couldn’t block." message="You can block from their profile too." />
          ) : null}
          <Button
            label={`Also block @${person.handle}`}
            variant="danger"
            icon="close"
            fullWidth
            busy={state.block === 'blocking'}
            busyLabel="Blocking…"
            onPress={() => void flow.block()}
            testID="feedback-block"
          />
        </>
      )}
      <Button label="Done" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

function Queued({ onClose }: { readonly onClose: () => void }) {
  return (
    <View style={styles.stack}>
      <Banner
        kind="offline"
        lead="Will send when online."
        message="Your report is saved on this device and goes as soon as you’re connected."
      />
      <Button label="Done" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

/**
 * P03, ready to sit in a sheet: the menu of a Reel or Scroll, the content error form, the abuse form,
 * sending, the receipt, and the report kept for when the person is online. The container owns the sheet
 * and its header. What the person typed is held only while the sheet is open.
 */
export function FeedbackContent({ scope, target, start, onClose, onNotInterested }: FeedbackContentProps) {
  const store = useFeedbackStore(scope);
  const [flow] = useState(() => createReportFlow({ target, start, newId: newCommandId, store }));
  const state = useFlow(flow);
  switch (state.step) {
    case 'menu':
      return target.kind === 'asset' ? (
        <Menu target={target} flow={flow} onClose={onClose} onNotInterested={onNotInterested} />
      ) : null;
    case 'sending':
      return <Sending />;
    case 'received':
      return <Received target={target} flow={flow} state={state} onClose={onClose} />;
    case 'queued':
      return <Queued onClose={onClose} />;
    case 'content_error':
    case 'abuse':
    case 'failed':
      return (
        <Form target={target} flow={flow} state={state} onBack={start === 'menu' ? () => flow.back() : undefined} />
      );
  }
}

const styles = StyleSheet.create({
  stack: { gap: spacing[3] },
  group: { gap: spacing[2] },
  about: {
    flexDirection: 'row',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
  },
  aboutText: { flex: 1, gap: spacing[1] },
  moment: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  received: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  receipt: { gap: spacing[1], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.paper2 },
});
