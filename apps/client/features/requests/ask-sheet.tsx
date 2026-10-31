import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import {
  borderWidth,
  content,
  dimension,
  layout,
  opacity,
  radius,
  space,
  spacing,
  target,
} from '@knowscroll/design-tokens';
import {
  Button,
  Icon,
  IconButton,
  PendingStripe,
  RequestStatusChip,
  Text,
  useFocusRing,
  useTypeStyle,
} from '@knowscroll/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { useStagePlay } from '../scroll/use-stage-play';
import { AskPuzzle } from './ask-puzzle';
import { COUNTER_FROM, PAUSED_COPY, aboutTitle, usuallyPhrase } from './ask-copy';
import { unavailableCopy } from './request-copy';
import type { RequestSession } from './request-session';

const noSubscription = () => () => undefined;
const noPolicy = () => undefined;

/** One suggested question: the whole row is the button, and its number is the key that picks it (D1: 1 to 3). */
function Suggestion({
  number,
  text,
  disabled,
  onPress,
}: {
  readonly number: number;
  readonly text: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Ask: ${text}`}
      aria-keyshortcuts={String(number)}
      disabled={disabled}
      aria-disabled={disabled}
      onPress={onPress}
      style={[styles.suggestion, disabled ? styles.disabled : null, focus.style]}
    >
      <Icon name="arrowRight" size={18} color={content.accent} />
      <Text variant="ui" style={styles.suggestionText}>
        {text}
      </Text>
    </Pressable>
  );
}

/**
 * Ask from here (D1): the sheet a person opens from a Scroll they are reading. It starts from what they just read (the
 * questions the Scroll itself suggests), leaves format and scope to be inferred (one editable line says what will be
 * made), says plainly what happens next, and makes the wait honest: a status card they can leave, a real typical time
 * only when it was measured, and a puzzle from the Scroll's own calls. Nothing here is a model call: the sheet only
 * sends the question; code and a worker decide what becomes of it (D-218).
 */
export function AskSheet({
  session,
  scroll,
  onClose,
}: {
  readonly session: RequestSession;
  readonly scroll: OpenedStageScroll;
  readonly onClose: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const insets = useSafeAreaInsets();
  const type = useTypeStyle('body');
  const [focused, setFocused] = useState(false);
  const { state: account } = useAccountScopeIfPresent();
  const recording = account.status === 'signed_in' ? account.scope.recording : undefined;
  const policy = useSyncExternalStore(
    recording?.subscribe ?? noSubscription,
    recording?.getState ?? noPolicy,
    recording?.getState ?? noPolicy,
  );
  const paused = policy?.policy !== undefined && !policy.policy.on;
  const play = useStagePlay(scroll);
  const editing = state.phase === 'draft';
  const status = state.status;
  const suggestions = scroll.document.askSuggestions;
  const anchorStopId = state.anchor?.stopId ?? scroll.document.stops[0]?.id ?? '';
  const ask = (question: string) => {
    session.edit({ about: true, text: question });
    session.submit();
  };

  // The keys of D1: 1 to 3 pick a suggested question. The reader's own keys are off while a sheet is over it.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !editing || paused) return;
    const onKey = (event: KeyboardEvent) => {
      const number = Number(event.key);
      const target = event.target as HTMLElement | null;
      // A single-character key acts only while focus is in this sheet (WCAG 2.1.4). The question box takes focus when the
      // sheet opens, so a digit picks a suggestion while it is empty and is typed once there is text.
      const typing = target?.tagName === 'INPUT' || (target instanceof HTMLTextAreaElement && target.value.length > 0);
      if (event.metaKey || event.ctrlKey || event.altKey || typing || target?.closest('[role="dialog"]') == null)
        return;
      const question = Number.isInteger(number) ? suggestions[number - 1] : undefined;
      if (question === undefined) return;
      event.preventDefault();
      ask(question);
    };
    // The capture phase: the question box stops key events from bubbling, so a listener below it would never hear a digit.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  const typed = state.text.length;
  const waiting = state.phase === 'accepted' && status?.status === 'preparing';
  const couldBePreparedAgain =
    state.phase === 'accepted' && status?.status === 'unavailable' && status.reason === 'could_not_prepare';
  const scopeLine = state.about ? `about “${aboutTitle(scroll.document.title)}”` : 'about something new';
  return (
    <KeyboardAvoidingView
      style={styles.host}
      pointerEvents="box-none"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.viewport}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.sheet, { paddingBottom: spacing[7] + insets.bottom }]}
      >
        <View
          style={styles.grab}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        />
        <View style={styles.heading}>
          <Text variant="displayL" heading={2}>
            Ask
          </Text>
          <IconButton icon="close" label="Close ask" onPress={onClose} />
        </View>

        {editing || state.phase === 'sending' || state.phase === 'send_unknown' || state.phase === 'refused' ? (
          <>
            {suggestions.length === 0 || !state.about ? null : (
              <>
                <Text variant="label" color={content.ink2}>
                  FROM WHAT YOU JUST READ
                </Text>
                <View style={styles.suggestions}>
                  {suggestions.map((question, index) => (
                    <Suggestion
                      key={question}
                      number={index + 1}
                      text={question}
                      disabled={!editing || paused}
                      onPress={() => ask(question)}
                    />
                  ))}
                </View>
                <Text variant="label" color={content.ink2}>
                  OR ASK ANYTHING
                </Text>
              </>
            )}
            <TextInput
              value={state.text}
              onChangeText={(text) => session.edit({ text })}
              editable={editing && !paused}
              multiline
              submitBehavior="submit"
              onSubmitEditing={() => session.submit()}
              maxLength={280}
              allowFontScaling={false}
              accessibilityLabel="Ask a question"
              aria-describedby="ask-scope-line"
              placeholder={state.about ? 'Ask about this' : 'An idea you’d like to explore'}
              placeholderTextColor={content.muted}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={[
                styles.input,
                {
                  fontFamily: type.fontFamily,
                  fontSize: type.fontSize,
                  fontWeight: type.fontWeight,
                  borderColor: focused ? space.focus : content.ink,
                },
              ]}
            />
            {typed >= COUNTER_FROM ? (
              <View role="status">
                <Text variant="meta">{`${String(typed)}/280`}</Text>
              </View>
            ) : null}
            <View style={styles.scopeRow}>
              <Text variant="uiS" nativeID="ask-scope-line" style={styles.scopeText}>
                {`A short Scroll · ${scopeLine}`}
              </Text>
              <Button
                label="Change"
                size="sm"
                variant="ghost"
                disabled={!editing}
                accessibilityLabel={state.about ? 'Change: ask about something new' : 'Change: ask about this Scroll'}
                onPress={() => session.edit({ about: !state.about })}
              />
            </View>
            {paused ? (
              <View role="alert" testID="ask-paused">
                <Text variant="bodyS">{PAUSED_COPY}</Text>
              </View>
            ) : null}
            {state.error === 'paused' && !paused ? (
              <View role="alert">
                <Text variant="bodyS">{PAUSED_COPY}</Text>
              </View>
            ) : null}
            {state.error === 'source' ? (
              <View role="alert">
                <Text variant="bodyS">
                  The Scroll changed while you were typing. Close this sheet and ask again from where you are.
                </Text>
              </View>
            ) : null}
            {state.error === 'read' && editing ? (
              <View role="alert">
                <Text variant="bodyS">
                  We couldn&apos;t check your recording setting just now. Try again in a moment.
                </Text>
              </View>
            ) : null}
            {editing ? (
              <Button
                label="Send"
                variant="primary"
                icon="send"
                iconPosition="trailing"
                fullWidth
                disabled={paused || state.text.trim().length < 3}
                onPress={() => session.submit()}
              />
            ) : null}
            {state.phase === 'sending' ? <Button label="Sending" busy fullWidth /> : null}
            {state.phase === 'send_unknown' ? (
              <>
                <Text variant="bodyS">Sending wasn&apos;t confirmed. Your question is kept for retry.</Text>
                <Button label="Retry sending" onPress={() => session.retrySend()} />
              </>
            ) : null}
            {state.phase === 'refused' ? (
              <View role="alert">
                <Text variant="bodyS">
                  {state.error === 'too_many_open'
                    ? 'You have several requests still preparing. Let one finish, or cancel one in Your requests, then ask again.'
                    : state.error === 'paused'
                      ? PAUSED_COPY
                      : "This question couldn't be accepted. Your Scroll or access may have changed. Ask again when you're ready."}
                </Text>
                <Button label="Ask something else" onPress={() => session.startAgain()} />
              </View>
            ) : null}
            {editing ? (
              <Text variant="meta" style={styles.note}>
                We&apos;ll make it and let you know here when it&apos;s ready.
              </Text>
            ) : null}
          </>
        ) : null}

        {state.receipt && !status ? (
          <View role="status">
            <Text variant="bodyS">Question sent. Checking where it stands.</Text>
          </View>
        ) : null}

        {waiting ? (
          <>
            <View style={styles.making} role="status" testID="ask-making">
              <PendingStripe />
              <Text variant="title" heading={3}>
                Making it now
              </Text>
              <Text variant="body">
                {`“${state.text.trim()}” — a short Scroll. We'll let you know here when it's ready${
                  usuallyPhrase(status.typicalSeconds) === undefined
                    ? '.'
                    : `, ${usuallyPhrase(status.typicalSeconds)!}.`
                }`}
              </Text>
              <View style={styles.row}>
                <Button label="Keep reading" onPress={onClose} />
                <Button label="Cancel" variant="ghost" onPress={() => session.cancel()} />
              </View>
            </View>
            {play === undefined ? null : <AskPuzzle scroll={scroll} anchorStopId={anchorStopId} play={play} />}
            <Text variant="meta" style={styles.note}>
              When it&apos;s ready you&apos;ll see a notice here, and it stays in Your requests.
            </Text>
          </>
        ) : null}

        {status?.status === 'ready' ? (
          <View style={styles.making} role="status" testID="ask-ready">
            <RequestStatusChip status="ready" />
            <Text variant="title" heading={3}>
              {status.content.metadata.title}
            </Text>
            <Text variant="bodyS">
              Your answer is ready. It is a short Scroll made for this question, for you alone.
            </Text>
            <Button
              label="Open your Scroll"
              variant="primary"
              disabled={state.reading || state.phase !== 'accepted'}
              onPress={() => {
                void session.openReady();
              }}
            />
          </View>
        ) : null}

        {status?.status === 'unavailable' ? (
          <View role="status" style={styles.closed} testID="ask-closed">
            <RequestStatusChip status={couldBePreparedAgain ? 'failed' : 'unavailable'} />
            {couldBePreparedAgain ? (
              <Text variant="displayL" heading={3}>
                We couldn&apos;t prepare this one
              </Text>
            ) : null}
            <Text variant="body">{unavailableCopy[status.reason]}</Text>
          </View>
        ) : null}
        {couldBePreparedAgain && state.error === 'too_many_open' ? (
          <View role="alert">
            <Text variant="bodyS">
              You have several requests still preparing. Let one finish, or cancel one in Your requests, then try again.
            </Text>
          </View>
        ) : null}
        {couldBePreparedAgain ? (
          state.error === 'not_retryable' ? (
            <View role="alert">
              <Text variant="bodyS">This one can&apos;t be tried again. Asking another way may work.</Text>
            </View>
          ) : (
            <Button label="Try again" variant="primary" onPress={() => session.tryAgain()} />
          )
        ) : null}
        {state.phase === 'retrying' ? <Button label="Trying again" busy /> : null}
        {state.phase === 'retry_unknown' ? (
          <>
            <Text variant="bodyS">Trying again wasn&apos;t confirmed. Your question is kept for retry.</Text>
            <Button label="Retry trying again" onPress={() => session.retryTryAgain()} />
          </>
        ) : null}
        {state.phase === 'cancelling' ? <Button label="Cancelling" busy /> : null}
        {state.phase === 'cancel_unknown' ? (
          <>
            <Text variant="bodyS">Cancelling wasn&apos;t confirmed.</Text>
            <Button label="Retry cancelling" onPress={() => session.retryCancel()} />
          </>
        ) : null}
        {state.error === 'read' && !editing ? (
          <Text variant="bodyS">
            Where your question stands couldn&apos;t be refreshed. What is shown may be out of date.
          </Text>
        ) : null}
        {state.phase === 'accepted' && status && status.status !== 'preparing' ? (
          <Button
            label={couldBePreparedAgain ? 'Ask differently' : 'Ask something else'}
            onPress={() => (couldBePreparedAgain ? session.editAgain() : session.startAgain())}
          />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, justifyContent: 'flex-end' },
  viewport: {
    flexGrow: 0,
    maxHeight: '94%',
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    backgroundColor: content.paper,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  grab: {
    alignSelf: 'center',
    width: dimension.grabHandle.width,
    height: dimension.grabHandle.height,
    borderRadius: dimension.grabHandle.radius,
    backgroundColor: content.ink,
    opacity: opacity.grabHandle,
  },
  sheet: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingTop: spacing[3],
    paddingHorizontal: layout.gutter,
    gap: spacing[3],
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  suggestions: { gap: spacing[2] },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  suggestionText: { flex: 1 },
  disabled: { opacity: opacity.disabled },
  input: {
    minHeight: target.comfortable * 1.6,
    textAlignVertical: 'top',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    backgroundColor: content.paper,
    color: content.ink,
  },
  scopeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  scopeText: { flex: 1 },
  note: { textAlign: 'center' },
  making: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  closed: { gap: spacing[2], alignItems: 'flex-start' },
});
