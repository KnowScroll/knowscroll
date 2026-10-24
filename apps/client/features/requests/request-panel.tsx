import { useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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
import { Button, IconButton, RequestStatusChip, Text, useTypeStyle } from '@knowscroll/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RequestChoices } from './request-choices';
import { unavailableCopy } from './request-copy';
import { suggestions, type RequestSession } from './request-session';

/** E04/E06 bounded composer inside the encounter's single accessible overlay host. */
export function RequestPanel({ session, onClose }: { readonly session: RequestSession; readonly onClose: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const type = useTypeStyle('body');
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState(false);
  const editing = state.phase === 'draft';
  const status = state.status;
  // The work failed, not the idea: the same ask can go again (E07 "Couldn't prepare"). Other closed
  // reasons are permanent or capped (a Reel or variant ask, the daily cap), so pressing again only
  // makes another closed request.
  const couldBePreparedAgain =
    state.phase === 'accepted' && status?.status === 'unavailable' && status.reason === 'could_not_prepare';
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
            Ask for something
          </Text>
          <IconButton icon="close" label="Close request" onPress={onClose} />
        </View>
        {couldBePreparedAgain ? null : state.mode === 'topic' ? (
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
              {state.text.length}/500 · We&apos;ll match your words to what KnowScroll can explain.
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
            <RequestChoices
              label="Requested format"
              options={[
                { value: 'reel', label: 'Reel' },
                { value: 'scroll', label: 'Scroll' },
                { value: 'either', label: 'Either' },
              ]}
              value={state.format}
              disabled={!editing}
              onSelect={(format) => session.edit({ format })}
            />
            <Text variant="uiS">This is</Text>
            <RequestChoices
              label="Request context"
              options={[
                { value: 'new', label: 'Something new' },
                { value: 'about', label: 'About this encounter' },
              ]}
              value={state.about ? 'about' : 'new'}
              disabled={!editing || !state.source}
              onSelect={(value) => session.edit({ about: value === 'about' })}
            />
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
        {status?.status === 'preparing' ? (
          <>
            <RequestStatusChip status={status.phase} />
            <Text variant="bodyS">We&apos;ll show it when it&apos;s ready. Keep watching meanwhile.</Text>
          </>
        ) : null}
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
          <View role="status" style={styles.closed}>
            <RequestStatusChip status={couldBePreparedAgain ? 'failed' : 'unavailable'} />
            {couldBePreparedAgain ? (
              <Text variant="displayL" heading={3}>
                We couldn&apos;t prepare this one
              </Text>
            ) : null}
            <Text variant="body">{unavailableCopy[status.reason]}</Text>
          </View>
        ) : null}
        {couldBePreparedAgain ? (
          <>
            <Button label="Try again" variant="primary" onPress={() => session.tryAgain()} />
            {state.mode === 'topic' ? <Button label="Ask differently" onPress={() => session.editAgain()} /> : null}
          </>
        ) : null}
        {state.error === 'read' ? (
          <Text variant="bodyS">Availability couldn't be refreshed. The last shown state may be out of date.</Text>
        ) : null}
        {state.phase === 'refused' ? (
          <View role="alert">
            <Text variant="bodyS">
              {state.error === 'too_many_open'
                ? 'You have several requests still preparing. Let one finish, or cancel one in Your requests, then ask again.'
                : "This request couldn't be accepted. Your source or access may have changed. Choose again when you're ready."}
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
        {state.receipt && state.phase === 'accepted' && (status?.status === 'preparing' || state.error === 'read') ? (
          <Button
            label="Refresh availability"
            disabled={state.reading}
            variant="ghost"
            onPress={() => {
              void session.refresh();
            }}
          />
        ) : null}
        {(state.phase === 'accepted' && status && status.status !== 'preparing' && !couldBePreparedAgain) ||
        state.phase === 'refused' ? (
          <Button label="Ask something else" onPress={() => session.startAgain()} />
        ) : null}
        <Text variant="meta">Closing keeps your request. Open a ready explanation when you choose.</Text>
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
  closed: { gap: spacing[2], alignItems: 'flex-start' },
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
