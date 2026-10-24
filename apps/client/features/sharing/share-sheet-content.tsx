import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import type { ShareTarget } from '@knowscroll/client-core';
import type { ConversationContentRef, DirectConversationRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, target as targetSize } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing, useTypeStyle, type IconName } from '@knowscroll/ui';
import type { AccountScope } from '@knowscroll/client-core';
import { PersonAvatar } from '../conversations/person-avatar';
import { useShareSession } from './use-share-session';

export interface ShareSheetContentProps {
  readonly scope: AccountScope;
  /** The exact revision being shared. */
  readonly target: ConversationContentRef;
  /** The title of what is shared, for the system share text. The container's header names the sheet. */
  readonly title: string;
  /** The origin links are built on: the app's own origin, where `/s/*` reaches the API. */
  readonly origin: string;
  /** Closes the sheet (Cancel). The caller restores what was playing; overlays never enter Back history. */
  readonly onClose: () => void;
  /** After "Sent": open the conversation. */
  readonly onOpenConversation: (conversation: DirectConversationRef) => void;
  /**
   * "Explore with friends" (a content thread with chosen friends). Offered only when the caller
   * passes it, so the option appears with the slice that makes it work and never before.
   */
  readonly onExploreWithFriends?: () => void;
}

function canShareElsewhere(): boolean {
  return Platform.OS !== 'web' || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');
}

function OptionRow({
  icon,
  label,
  description,
  onPress,
  disabled,
  busy,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly description: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      aria-busy={busy}
      disabled={disabled === true || busy === true}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        focus.style,
      ]}
    >
      <View style={styles.optionIcon}>
        <Icon name={icon} size={20} />
      </View>
      <View style={styles.optionText}>
        <Text variant="ui">{label}</Text>
        <Text variant="meta" color={content.ink2}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

function TargetRow({
  entry,
  selected,
  disabled,
  onSelect,
}: {
  readonly entry: ShareTarget;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="radio"
      aria-checked={selected}
      accessibilityLabel={entry.person.displayName}
      disabled={disabled}
      onPress={onSelect}
      style={[styles.target, focus.style]}
    >
      <PersonAvatar person={entry.person} size={40} />
      <View style={styles.optionText}>
        <Text variant="ui" numberOfLines={1}>
          {entry.person.displayName}
        </Text>
        <Text variant="meta" color={content.ink2} numberOfLines={1}>
          @{entry.person.handle}
        </Text>
      </View>
      <View style={[styles.radio, selected ? styles.radioOn : null]}>
        {selected ? <Icon name="check" size={14} color={content.onAccent} /> : null}
      </View>
    </Pressable>
  );
}

function NoteField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const type = useTypeStyle('bodyS');
  return (
    <View style={styles.field}>
      <Text variant="uiS">Add a note (optional)</Text>
      <TextInput
        accessibilityLabel="Add a note (optional)"
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        multiline
        maxLength={500}
        allowFontScaling={false}
        style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
      />
    </View>
  );
}

function Section({ children }: { readonly children: ReactNode }) {
  return <View style={styles.section}>{children}</View>;
}

/**
 * H01: the content of the share sheet, the same for a Reel and a Scroll. "Send to a conversation"
 * lists the people the person can write to; "Copy link" makes a public link that shows only the
 * title and summary and can be stopped. "Sent" is shown only after the server's receipt, and
 * copying a link or opening the system share sheet never claims anyone received anything.
 * Choosing, sending and copying are not encounters and create no evidence.
 *
 * The caller owns the container and its header (title "Share", the shared item's name): it pauses
 * playback while this is open, restores it on close, and keeps the sheet out of the Back history
 * (D-006 k).
 */
export function ShareSheetContent(props: ShareSheetContentProps) {
  const { scope, title, onClose, onOpenConversation, onExploreWithFriends } = props;
  const { session, state } = useShareSession(scope, props.target, props.origin);
  const [view, setView] = useState<'menu' | 'send'>('menu');
  const [query, setQuery] = useState('');
  const searchType = useTypeStyle('bodyS');
  useEffect(() => {
    if (view === 'send' && state.targets.status === 'loading' && state.targets.items.length === 0)
      void session.loadTargets();
  }, [view, session, state.targets.status, state.targets.items.length]);

  const chosen = state.targets.items.find((entry) => entry.person.personId === state.selected);
  const visible = state.targets.items.filter((entry) =>
    `${entry.person.displayName} ${entry.person.handle}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const sending = state.send.status === 'sending';
  const locked = sending || state.send.status === 'unconfirmed' || state.send.status === 'sent';
  const link = state.link;

  return (
    <View style={styles.sheet}>
      {view === 'menu' ? (
        <Section>
          <OptionRow
            icon="send"
            label="Send to a conversation"
            description="Drop it into a chat with a friend"
            onPress={() => setView('send')}
          />
          {onExploreWithFriends === undefined ? null : (
            <OptionRow
              icon="menu"
              label="Explore with friends"
              description="Start a thread: this one, what comes next, and the chat together"
              onPress={onExploreWithFriends}
            />
          )}
          <OptionRow
            icon="link"
            label={link.status === 'ready' ? 'Copy link again' : 'Copy link'}
            description="Anyone with the link sees the title and summary"
            busy={link.status === 'creating'}
            onPress={() => void session.copyLink()}
          />
          {link.status === 'ready' ? (
            <View style={styles.linkBox} accessibilityLiveRegion="polite">
              <Text variant="bodyS">{link.copied ? 'Link copied' : 'Copy this link'}</Text>
              <Text variant="meta" color={content.ink2}>
                {link.copied ? 'Paste it wherever you like.' : 'Your device didn’t let us copy it for you.'}
              </Text>
              {link.copied ? null : (
                <Text variant="meta" selectable testID="share-link-url">
                  {link.url}
                </Text>
              )}
              <View style={styles.linkActions}>
                {canShareElsewhere() ? (
                  <Button
                    label="Share elsewhere"
                    size="sm"
                    onPress={() => {
                      void Share.share(
                        Platform.OS === 'ios' ? { url: link.url } : { message: `${title} ${link.url}`, title },
                      );
                    }}
                  />
                ) : null}
                <Button
                  label="Stop sharing this link"
                  size="sm"
                  variant="ghost"
                  onPress={() => void session.stopLink()}
                />
              </View>
            </View>
          ) : null}
          {link.status === 'stopping' ? (
            <Text variant="meta" color={content.ink2}>
              Stopping the link…
            </Text>
          ) : null}
          {link.status === 'stopped' ? (
            <Banner
              kind="info"
              lead="Link stopped."
              message="It no longer opens for anyone. Copies already pasted can’t be recalled."
            />
          ) : null}
          {link.status === 'failed' ? (
            <Banner kind="error" lead="Couldn’t make a link." message="Check your connection and try again." />
          ) : null}
          <Button label="Cancel" fullWidth onPress={onClose} />
        </Section>
      ) : (
        <Section>
          <View style={styles.back}>
            <Button
              label="Back"
              size="sm"
              variant="ghost"
              icon="back"
              onPress={() => setView('menu')}
              disabled={locked}
            />
            <Text variant="title" heading={2}>
              Send to a conversation
            </Text>
          </View>
          {state.send.status === 'sent' ? (
            <View style={styles.receipt} accessibilityLiveRegion="polite">
              <Text variant="bodyS">Sent to {state.send.target.person.displayName}</Text>
              <Button
                label="Open chat"
                size="sm"
                onPress={() => {
                  if (state.send.status === 'sent') onOpenConversation(state.send.conversation);
                }}
              />
            </View>
          ) : (
            <>
              {state.targets.status === 'loading' && state.targets.items.length === 0 ? (
                <Text variant="meta" color={content.ink2}>
                  Loading your friends…
                </Text>
              ) : null}
              {state.targets.status === 'failed' ? (
                <Banner
                  kind="error"
                  lead="Couldn’t load your friends."
                  message="Check your connection and try again."
                ></Banner>
              ) : null}
              {state.targets.status === 'ready' && state.targets.items.length === 0 ? (
                <Text variant="bodyS">
                  You haven’t got any friends here yet. Invite a friend from Talk, then share this with them.
                </Text>
              ) : null}
              {state.targets.items.length > 5 ? (
                <TextInput
                  accessibilityLabel="Search friends"
                  placeholder="Search friends"
                  placeholderTextColor={content.ink2}
                  value={query}
                  onChangeText={setQuery}
                  allowFontScaling={false}
                  style={[
                    styles.input,
                    {
                      fontFamily: searchType.fontFamily,
                      fontSize: searchType.fontSize,
                      lineHeight: searchType.lineHeight,
                    },
                  ]}
                />
              ) : null}
              <View role="radiogroup" accessibilityLabel="Friends" style={styles.targets}>
                {visible.map((entry) => (
                  <TargetRow
                    key={entry.person.personId}
                    entry={entry}
                    selected={entry.person.personId === state.selected}
                    disabled={locked}
                    onSelect={() => session.select(entry.person.personId)}
                  />
                ))}
              </View>
              {chosen === undefined ? null : (
                <NoteField value={state.note} onChange={session.setNote} disabled={locked} />
              )}
              {state.send.status === 'unconfirmed' ? (
                <Banner
                  kind="error"
                  lead="Couldn’t confirm it was sent."
                  message="Retrying sends the same message, so it can’t arrive twice."
                />
              ) : null}
              {state.send.status === 'unavailable' ? (
                <Banner
                  kind="error"
                  lead="This can’t be sent right now."
                  message="Choose someone else or try again later."
                />
              ) : null}
              {state.send.status === 'failed' ? (
                <Banner kind="error" lead="Couldn’t send." message="Nothing was sent. Try again." />
              ) : null}
              <Button
                label={
                  state.send.status === 'unconfirmed'
                    ? 'Retry'
                    : chosen === undefined
                      ? 'Choose a friend'
                      : `Send to ${chosen.person.displayName}`
                }
                variant="primary"
                fullWidth
                busy={sending}
                busyLabel="Sending"
                disabled={chosen === undefined}
                onPress={() => void session.send()}
              />
            </>
          )}
          <Button
            label={state.send.status === 'sent' ? 'Done' : 'Cancel'}
            fullWidth
            variant="ghost"
            onPress={onClose}
          />
        </Section>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: spacing[3] },
  section: { gap: spacing[3] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: targetSize.comfortable,
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  optionIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
  },
  optionText: { flex: 1, gap: spacing[0.5] },
  pressed: { backgroundColor: content.highlight },
  disabled: { opacity: 0.45 },
  linkBox: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderRadius: radius.md,
    backgroundColor: content.freshTint,
  },
  linkActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  back: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  targets: { gap: spacing[1] },
  target: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: targetSize.comfortable,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: content.accent },
  field: { gap: spacing[1] },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
  receipt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.freshTint,
  },
});
