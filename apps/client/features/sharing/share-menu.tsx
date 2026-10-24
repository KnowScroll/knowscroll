import { Platform, Pressable, Share, StyleSheet, View } from 'react-native';
import type { LinkStatus, ShareSession } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, target as targetSize } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing, type IconName } from '@knowscroll/ui';

function canShareElsewhere(): boolean {
  return Platform.OS !== 'web' || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');
}

interface OptionRowProps {
  readonly icon: IconName;
  readonly label: string;
  readonly description: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  /** The one way H01 draws forward: the thread, on a pale yellow ground. */
  readonly highlighted?: boolean;
}

function OptionRow({ icon, label, description, onPress, busy, highlighted }: OptionRowProps) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      aria-busy={busy}
      disabled={busy === true}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        highlighted === true ? styles.highlighted : null,
        pressed ? styles.pressed : null,
        focus.style,
      ]}
    >
      <View style={[styles.optionIcon, highlighted === true ? styles.highlightedIcon : null]}>
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

/** H01 names the row for both things it does; where this device has no system share sheet it only copies. */
function copyLinkLabel(link: LinkStatus): string {
  const copy = link.status === 'ready' ? 'Copy link again' : 'Copy link';
  return canShareElsewhere() ? `${copy} / Share elsewhere` : copy;
}

type ReadyLink = Extract<LinkStatus, { status: 'ready' }>;

/** The link just made: where it went, a way to copy it by hand, and the way to stop it. */
function LinkBox({ link, title, onStop }: { link: ReadyLink; title: string; onStop: () => void }) {
  const share = () =>
    void Share.share(Platform.OS === 'ios' ? { url: link.url } : { message: `${title} ${link.url}`, title });
  return (
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
        {canShareElsewhere() ? <Button label="Share elsewhere" size="sm" onPress={share} /> : null}
        <Button label="Stop sharing this link" size="sm" variant="ghost" onPress={onStop} />
      </View>
    </View>
  );
}

/** What is going on with the link that is not "ready": stopping, stopped, or a failure. */
function LinkNotice({ link }: { link: LinkStatus }) {
  if (link.status === 'stopping')
    return (
      <Text variant="meta" color={content.ink2}>
        Stopping the link…
      </Text>
    );
  if (link.status === 'stopped')
    return (
      <Banner
        kind="info"
        lead="Link stopped."
        message="It no longer opens for anyone. Copies already pasted can’t be recalled."
      />
    );
  if (link.status === 'failed')
    return <Banner kind="error" lead="Couldn’t make a link." message="Check your connection and try again." />;
  return null;
}

export interface ShareMenuProps {
  readonly session: ShareSession;
  readonly link: LinkStatus;
  readonly title: string;
  readonly onSendToConversation: () => void;
  readonly onExploreWithFriends: (() => void) | undefined;
  readonly onClose: () => void;
}

/** H01's first view: send to a conversation, explore with friends (when offered), copy a link. */
export function ShareMenu({
  session,
  link,
  title,
  onSendToConversation,
  onExploreWithFriends,
  onClose,
}: ShareMenuProps) {
  return (
    <View style={styles.section}>
      <OptionRow
        icon="send"
        label="Send to a conversation"
        description="Drop it into a chat you already have"
        onPress={onSendToConversation}
      />
      {onExploreWithFriends === undefined ? null : (
        <OptionRow
          icon="menu"
          label="Explore with friends"
          description="Start a thread: this one, what comes next, and the chat together"
          highlighted
          onPress={onExploreWithFriends}
        />
      )}
      <OptionRow
        icon="link"
        label={copyLinkLabel(link)}
        description="Other apps get a public link. It shows only the title and summary."
        busy={link.status === 'creating'}
        onPress={() => void session.copyLink()}
      />
      {link.status === 'ready' ? <LinkBox link={link} title={title} onStop={() => void session.stopLink()} /> : null}
      <LinkNotice link={link} />
      <Button label="Cancel" fullWidth onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
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
  highlighted: { backgroundColor: content.highlight },
  highlightedIcon: { backgroundColor: content.continue },
  pressed: { backgroundColor: content.highlight },
  linkBox: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderRadius: radius.md,
    backgroundColor: content.freshTint,
  },
  linkActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
