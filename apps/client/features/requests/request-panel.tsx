import { useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { borderWidth, content, layout, radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Button, IconButton, RequestStatusChip, Text, useTypeStyle } from '@knowscroll/ui';
import type { ContentRequestStatus } from '@knowscroll/contracts';
import { suggestions, type RequestSession } from './request-session';

const reasons: Record<Extract<ContentRequestStatus, { status: 'unavailable' }>['reason'], string> = {
  unsupported_request: "This request isn't supported yet. Try one of the suggested topics, or ask something else.",
  no_compatible_supply: "There isn't a compatible explanation available for this request.",
  not_permitted: "This explanation can't be prepared for you right now.",
  budget_unavailable: "This explanation can't be prepared right now. Your request is closed.",
  could_not_prepare: "We couldn't prepare this explanation. Your request is closed.",
  source_unavailable: 'The original encounter is no longer available for this request.',
};

/** E04/E06 bounded composer inside the encounter's single accessible overlay host. */
export function RequestPanel({ session, onClose }: { readonly session: RequestSession; readonly onClose: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const type = useTypeStyle('body');
  const [focused, setFocused] = useState(false);
  const editing = state.phase === 'draft';
  const status = state.status;
  return (
    <KeyboardAvoidingView style={styles.host} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheet}>
        <View style={styles.heading}>
          <Text variant="displayL" heading={2}>
            Ask for something
          </Text>
          <IconButton icon="close" label="Close request" onPress={onClose} />
        </View>
        {state.mode === 'topic' ? (
          <>
            <Text variant="ui" nativeID="request-text-label">
              What would you like now?
            </Text>
            <TextInput
              value={state.text}
              onChangeText={(text) => session.edit({ text })}
              editable={editing}
              multiline
              submitBehavior="submit"
              onSubmitEditing={() => session.submit()}
              autoFocus={editing}
              maxLength={500}
              allowFontScaling={false}
              accessibilityLabel="What would you like now?"
              aria-labelledby="request-text-label"
              aria-describedby="request-text-help"
              placeholder="An idea you'd like to explore"
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
            <Text variant="meta" nativeID="request-text-help">
              {state.text.length}/500 · Text requests aren't supported yet. Suggested topics can be checked for a match.
            </Text>
            <Text variant="uiS">Suggested topics</Text>
            <View style={styles.options}>
              {suggestions.map((topic) => (
                <Button
                  key={topic.id}
                  label={topic.label}
                  size="sm"
                  toggled={state.topicId === topic.id}
                  disabled={!editing}
                  onPress={() => session.edit({ topicId: state.topicId === topic.id ? undefined : topic.id })}
                />
              ))}
            </View>
            {state.topicId ? (
              <Text variant="meta">Your selected topic will be sent. The text above is not included.</Text>
            ) : null}
            <Text variant="uiS">As a</Text>
            <View style={styles.options} accessibilityLabel="Requested format">
              {(['reel', 'scroll', 'either'] as const).map((format) => (
                <Button
                  key={format}
                  label={format === 'reel' ? 'Reel' : format === 'scroll' ? 'Scroll' : 'Either'}
                  toggled={state.format === format}
                  disabled={!editing}
                  onPress={() => session.edit({ format })}
                />
              ))}
            </View>
            <Text variant="uiS">This is</Text>
            <View style={styles.options} accessibilityLabel="Request context">
              <Button
                label="Something new"
                toggled={!state.about}
                disabled={!editing}
                onPress={() => session.edit({ about: false })}
              />
              <Button
                label="About this encounter"
                toggled={state.about}
                disabled={!editing || !state.source}
                onPress={() => session.edit({ about: true })}
              />
            </View>
          </>
        ) : (
          <Text variant="body">
            Request the same explanation as a {state.mode === 'reel' ? 'Reel' : 'Scroll'}. Your current encounter keeps
            its place.
          </Text>
        )}
        {state.error === 'source' ? (
          <View role="alert">
            <Text variant="bodyS">
              The source changed while you were editing. Close this panel and choose the source again before sending.
            </Text>
          </View>
        ) : null}
        {editing ? (
          <Button
            label="Send request"
            variant="primary"
            disabled={state.error === 'source' || (state.mode === 'topic' && !state.topicId && !state.text.trim())}
            onPress={() => session.submit()}
          />
        ) : null}
        {state.phase === 'sending' ? <Button label="Sending request" busy /> : null}
        {state.phase === 'send_unknown' ? (
          <>
            <Text variant="bodyS">Sending wasn't confirmed. Your exact request is kept for retry.</Text>
            <Button label="Retry sending" onPress={() => session.retrySend()} />
          </>
        ) : null}
        {state.receipt && !status ? (
          <View role="status">
            <Text variant="bodyS">Request accepted. Checking current availability.</Text>
          </View>
        ) : null}
        {status?.status === 'preparing' ? <RequestStatusChip status={status.phase} /> : null}
        {status?.status === 'ready' ? (
          <>
            <Text variant="title">{status.content.metadata.title}</Text>
            <RequestStatusChip status="ready" />
            <Button
              label="Open explanation"
              variant="primary"
              disabled={state.reading || state.phase !== 'accepted'}
              onPress={() => {
                void session.openReady();
              }}
            />
          </>
        ) : null}
        {status?.status === 'unavailable' ? (
          <View role="status">
            <Text variant="body">{reasons[status.reason]}</Text>
          </View>
        ) : null}
        {state.error === 'read' ? (
          <Text variant="bodyS">Availability couldn't be refreshed. The last shown state may be out of date.</Text>
        ) : null}
        {state.phase === 'refused' ? (
          <View role="alert">
            <Text variant="bodyS">
              This request couldn't be accepted. Your source or access may have changed. Choose again when you're ready.
            </Text>
          </View>
        ) : null}
        {state.phase === 'accepted' && status?.status === 'preparing' ? (
          <Button label="Cancel request" variant="ghost" onPress={() => session.cancel()} />
        ) : null}
        {state.phase === 'cancelling' ? <Button label="Cancelling request" busy /> : null}
        {state.phase === 'cancel_unknown' ? (
          <>
            <Text variant="bodyS">Cancellation wasn't confirmed.</Text>
            <Button label="Retry cancellation" onPress={() => session.retryCancel()} />
          </>
        ) : null}
        {state.receipt && state.phase === 'accepted' && status?.status !== 'cancelled' ? (
          <Button
            label="Refresh availability"
            disabled={state.reading}
            variant="ghost"
            onPress={() => {
              void session.refresh();
            }}
          />
        ) : null}
        {(state.phase === 'accepted' && status && status.status !== 'preparing') || state.phase === 'refused' ? (
          <Button label="Ask something else" onPress={() => session.startAgain()} />
        ) : null}
        <Text variant="meta">Closing keeps your request. Open a ready explanation when you choose.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: content.paper },
  notice: { gap: spacing[2], paddingHorizontal: layout.gutter, paddingVertical: spacing[2], alignItems: 'flex-start' },
  sheet: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingTop: spacing[9],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[24],
    gap: spacing[3],
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  input: {
    minHeight: target.comfortable * 2,
    textAlignVertical: 'top',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.regular,
    backgroundColor: content.paper,
    color: content.ink,
  },
});

/** Last known, memory-only state attached to the exact encounter where it was requested. */
export function RequestNotice({
  session,
  exposureId,
  onPress,
}: {
  readonly session: RequestSession;
  readonly exposureId: string;
  readonly onPress: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  if (
    state.source?.exposureId !== exposureId ||
    state.phase === 'draft' ||
    state.phase === 'ended' ||
    state.status?.status === 'cancelled'
  )
    return null;
  return (
    <View style={styles.notice}>
      {state.status?.status === 'preparing' ? <RequestStatusChip status={state.status.phase} /> : null}
      {state.status?.status === 'ready' ? <RequestStatusChip status="ready" /> : null}
      <Text variant="meta">{state.status ? 'Request · last checked availability' : 'Your request'}</Text>
      <Button label="View request" size="sm" onPress={onPress} />
    </View>
  );
}
