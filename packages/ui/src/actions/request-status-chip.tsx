import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, content, radius, spacing, status, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { PendingStripe } from '../feedback/pending-stripe';
import { Spinner } from '../feedback/spinner';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';

/**
 * Supply status attached to the thing requested: no percentages, no ETAs. `failed` is a request
 * that could not be prepared and can be asked again; `unavailable` is one that cannot be made (E07:
 * "can't be made"), which offers nothing to retry.
 */
export type RequestStatus = 'requested' | 'preparing' | 'ready' | 'failed' | 'unavailable' | 'cancelled';

const looks: Record<
  RequestStatus,
  { word: string; icon: IconName | 'spinner'; background: string; border: string; foreground: string; dashed: boolean }
> = {
  requested: {
    word: 'Requested',
    icon: 'clock',
    background: content.paper,
    border: content.ink,
    foreground: content.ink,
    dashed: false,
  },
  preparing: {
    word: 'Preparing',
    icon: 'spinner',
    background: content.paper,
    border: content.ink,
    foreground: content.ink,
    dashed: false,
  },
  ready: {
    word: 'Ready',
    icon: 'check',
    background: content.fresh,
    border: content.ink,
    foreground: content.ink,
    dashed: false,
  },
  failed: {
    word: "Couldn't prepare",
    icon: 'retry',
    background: content.paper,
    border: status.danger.edge,
    foreground: status.danger.foreground,
    dashed: false,
  },
  unavailable: {
    word: "Can't be made",
    icon: 'alert',
    background: content.paper,
    border: content.ink,
    foreground: content.ink,
    dashed: false,
  },
  cancelled: {
    word: 'Cancelled',
    icon: 'close',
    background: content.paper,
    border: content.ink,
    foreground: content.ink2,
    dashed: true,
  },
};

export interface RequestStatusChipProps {
  readonly status: RequestStatus;
  /**
   * What follows the status word: the subject while waiting ("Scroll of this Reel", "we'll let
   * you know") and the action when there is one ("Open Scroll", "Retry").
   */
  readonly detail?: string;
  /** Ready opens the result and failed retries; the chip is a button only when this is given. */
  readonly onPress?: () => void;
  readonly testID?: string;
}

export function RequestStatusChip({ status: state, detail, onPress, testID }: RequestStatusChipProps) {
  const look = looks[state];
  const focus = useFocusRing('onLight');
  const text = detail === undefined ? look.word : `${look.word} · ${detail}`;
  const actionable = onPress !== undefined && (state === 'ready' || state === 'failed');
  const body = (
    <>
      {state === 'preparing' ? <PendingStripe compact /> : null}
      {look.icon === 'spinner' ? (
        <Spinner size={18} color={look.foreground} />
      ) : (
        <Icon name={look.icon} size={18} color={look.foreground} />
      )}
      <Text variant="uiS" color={look.foreground}>
        {text}
      </Text>
    </>
  );
  const chip: ViewStyle = {
    backgroundColor: look.background,
    borderColor: look.border,
    borderStyle: look.dashed ? 'dashed' : 'solid',
  };
  if (!actionable) {
    return (
      <View
        testID={testID}
        role={state === 'preparing' || state === 'requested' ? 'status' : undefined}
        accessible
        accessibilityLabel={text}
        style={[styles.chip, chip]}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      {...focus.props}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={onPress}
      style={[styles.chip, chip, styles.pressable, focus.style]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[2],
    minHeight: target.minimum,
    paddingLeft: spacing['2.5'],
    paddingRight: spacing['3.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    overflow: 'hidden',
  },
  pressable: { cursor: 'pointer' as const },
});
