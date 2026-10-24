import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';

export type InviteLinkStatus = 'none' | 'active' | 'revoked' | 'expired';

export interface InviteLinkCardProps {
  readonly status: InviteLinkStatus;
  /** The secret link was just made and can still be copied, once. */
  readonly copyable: boolean;
  /** Making or ending a link needs a claimed profile and a current read. */
  readonly canCreate: boolean;
  readonly disabled: boolean;
  readonly onCreate: () => void;
  readonly onCopy: () => void;
  readonly onRevoke: () => void;
}

/**
 * F01's "Share your invite link" card. The secret is shown nowhere: the only way out is Copy, once,
 * right after the link is made. A link that was lost is turned off and made again, never read back.
 */
export function InviteLinkCard(props: InviteLinkCardProps) {
  const { status, copyable, canCreate, disabled } = props;
  if (status === 'revoked' || status === 'expired')
    return (
      <View style={[styles.card, styles.ended]}>
        <View style={styles.endedTitle}>
          <Icon name="close" size={18} />
          <Text variant="ui">
            {status === 'revoked' ? 'This invite link was turned off' : 'This invite link expired'}
          </Text>
        </View>
        <Text variant="bodyS">
          People who open it now see “This link no longer works.” Requests already accepted are unchanged.
        </Text>
        <View style={styles.actions}>
          <Button label="Make a new link" disabled={disabled || !canCreate} onPress={props.onCreate} />
        </View>
      </View>
    );
  return (
    <View style={styles.card}>
      <Text variant="ui">Share your invite link</Text>
      <Text variant="bodyS" color={content.ink2}>
        Anyone with this link can ask to be your friend. You still accept each request.
      </Text>
      {status === 'active' && !copyable ? (
        <Text variant="meta" color={content.ink2}>
          The link can’t be shown again. If it was lost, turn it off and make a new one.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {status === 'none' ? (
          <Button label="Create invite link" disabled={disabled || !canCreate} onPress={props.onCreate} />
        ) : null}
        {status === 'active' && copyable ? (
          <Button label="Copy link" icon="link" disabled={disabled} onPress={props.onCopy} />
        ) : null}
        {status === 'active' ? (
          <Button label="Turn link off" variant="ghost" disabled={disabled} onPress={props.onRevoke} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.light,
    borderColor: content.rule,
    backgroundColor: content.paper2,
  },
  ended: { borderColor: content.muted },
  endedTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
});
