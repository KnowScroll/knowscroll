import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { Spinner } from '../feedback/spinner';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';

/**
 * Inline state messaging (Components.html "Banner"). `error` is not drawn in the export; it is
 * composed from the danger tokens for failed loads and commands.
 */
export type BannerKind = 'offline' | 'reconnecting' | 'corrected' | 'accessEnded' | 'recordingPaused' | 'error';

interface BannerLook {
  readonly background: string;
  readonly border: string;
  readonly foreground: string;
  readonly icon: IconName | 'spinner';
  /** Live regions announce changes without moving focus. */
  readonly live: 'status' | 'alert' | null;
}

const looks: Record<BannerKind, BannerLook> = {
  offline: { background: content.paper, border: content.ink, foreground: content.ink, icon: 'offline', live: 'status' },
  reconnecting: {
    background: content.paper2,
    border: content.ink,
    foreground: content.ink,
    icon: 'spinner',
    live: 'status',
  },
  corrected: {
    background: status.corrected.background,
    border: status.corrected.edge,
    foreground: content.ink,
    icon: 'corrected',
    live: null,
  },
  accessEnded: { background: content.paper, border: content.ink, foreground: content.ink, icon: 'lock', live: null },
  recordingPaused: {
    background: content.ink,
    border: content.ink,
    foreground: content.paper,
    icon: 'pause',
    live: null,
  },
  error: {
    background: content.paper,
    border: status.danger.edge,
    foreground: content.ink,
    icon: 'alert',
    live: 'alert',
  },
};

export interface BannerProps {
  readonly kind: BannerKind;
  /** The bold lead word or phrase ("Offline.", "Corrected 14 Oct."). */
  readonly lead: string;
  readonly message: string;
  /** An inline action ("What changed", "Resume", "Retry"); rendered only when its handler exists. */
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly testID?: string;
}

export function Banner({ kind, lead, message, action, testID }: BannerProps) {
  const look = looks[kind];
  const focus = useFocusRing(kind === 'recordingPaused' ? 'onDark' : 'onLight');
  const liveProps =
    look.live === null
      ? {}
      : {
          role: look.live,
          accessibilityLiveRegion: look.live === 'alert' ? ('assertive' as const) : ('polite' as const),
        };
  return (
    <View
      testID={testID}
      {...liveProps}
      style={[styles.banner, { backgroundColor: look.background, borderColor: look.border }]}
    >
      <View>
        {look.icon === 'spinner' ? (
          <Spinner size={20} color={look.foreground} />
        ) : (
          <Icon name={look.icon} size={20} color={look.foreground} />
        )}
      </View>
      <View style={styles.copy} accessible accessibilityLabel={`${lead} ${message}`}>
        <Text variant="notice" color={look.foreground}>
          <Text variant="notice" color={look.foreground} style={styles.lead}>
            {lead}
          </Text>{' '}
          {message}
        </Text>
      </View>
      {action === undefined ? null : (
        <Pressable
          {...focus.props}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={[styles.action, focus.style]}
        >
          <Text
            variant="notice"
            color={kind === 'recordingPaused' ? content.paper : content.accentDeep}
            style={styles.actionLabel}
          >
            {action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2.5'],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing['3.5'],
    borderRadius: radius.banner,
    borderWidth: borderWidth.regular,
  },
  copy: { flex: 1 },
  lead: { fontWeight: '700' },
  action: {
    minHeight: target.minimum,
    justifyContent: 'center',
    paddingHorizontal: spacing[1],
    cursor: 'pointer' as const,
  },
  actionLabel: { fontWeight: '700', textDecorationLine: 'underline' },
});
