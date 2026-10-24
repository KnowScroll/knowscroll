import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status, target } from '@knowscroll/design-tokens';
import { Icon, PendingStripe, spaceActivates, Text, useFocusRing } from '@knowscroll/ui';

/** A small caps label above a group of rows ("Sessions", "Settings": P01's `.sec`). */
export function SettingsLabel({ children }: { readonly children: string }) {
  return (
    <View style={styles.label}>
      <Text variant="label" color={content.ink2} heading={2}>
        {children}
      </Text>
    </View>
  );
}

interface RowProps {
  readonly title: string;
  /** The second line: what the row does, in words a person already knows. */
  readonly description?: string;
  readonly trailing?: ReactNode;
}

function RowBody({ title, description, trailing }: RowProps) {
  return (
    <>
      <View style={styles.who}>
        <Text variant="bodyS" style={styles.title}>
          {title}
        </Text>
        {description === undefined ? null : (
          <Text variant="meta" color={content.ink2}>
            {description}
          </Text>
        )}
      </View>
      {trailing}
    </>
  );
}

/**
 * A settings row (P01 and P02 `.lrow`): a name, what it does, and a chevron when it opens another
 * page. At least 58 px tall with a hairline under it; the whole row is the target.
 */
export function SettingsRow({ href, ...rest }: RowProps & { readonly href: Href }) {
  const focus = useFocusRing('onLight');
  return (
    <Link href={href} asChild>
      <Pressable {...focus.props} accessibilityLabel={rest.title} style={{ ...styles.row, ...focus.style }}>
        <RowBody {...rest} trailing={rest.trailing ?? <Icon name="forward" size={20} />} />
      </Pressable>
    </Link>
  );
}

/** A settings row that opens something on this screen (a sheet) instead of another page. */
export function SettingsActionRow({ onPress, ...rest }: RowProps & { readonly onPress: () => void }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={rest.title}
      onPress={onPress}
      style={{ ...styles.row, ...focus.style }}
    >
      <RowBody {...rest} trailing={rest.trailing ?? <Icon name="forward" size={20} />} />
    </Pressable>
  );
}

/** A row that only informs and may carry its own control (a session, with its Sign out). */
export function StaticRow(props: RowProps) {
  return (
    <View style={styles.row}>
      <RowBody {...props} />
    </View>
  );
}

export type ReceiptTone = 'preparing' | 'done' | 'failed';

const receiptGround = {
  preparing: { backgroundColor: content.paper2, borderColor: content.muted, borderStyle: 'dashed' },
  done: { backgroundColor: content.freshTint, borderColor: content.freshInk, borderStyle: 'solid' },
  failed: { backgroundColor: status.corrected.background, borderColor: status.danger.edge, borderStyle: 'solid' },
} as const;

/**
 * A receipt strip (P02 `.rcpt`): a tinted band that says a state in glyph, word and colour, never
 * colour alone. Striped and dashed while the work is under way, green when done, danger-tinted when
 * it failed. `children` is the sentence; `action` is the one button the state offers (Download,
 * Retry), drawn beside it.
 */
export function ReceiptCard({
  tone,
  state,
  when,
  action,
  children,
}: {
  readonly tone: ReceiptTone;
  readonly state: string;
  readonly when?: string;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <View style={[styles.receipt, receiptGround[tone]]}>
      {tone === 'preparing' ? <PendingStripe /> : null}
      <View style={styles.receiptHead}>
        <Icon
          name={tone === 'failed' ? 'retry' : tone === 'done' ? 'check' : 'clock'}
          size={20}
          color={tone === 'failed' ? status.danger.foreground : content.ink}
        />
        <Text variant="bodyS" style={styles.title} accessibilityLabel={state}>
          {state}
        </Text>
        {when === undefined ? null : (
          <Text variant="label" color={content.ink2} style={styles.when}>
            {when}
          </Text>
        )}
      </View>
      {children === undefined && action === undefined ? null : (
        <View style={styles.receiptBody}>
          <View style={styles.receiptText}>{children}</View>
          {action}
        </View>
      )}
    </View>
  );
}

/**
 * The dashed box a destructive step sits in (P02 "Clear exploration", D05 "Delete account"): the
 * acknowledgement and the one button, set apart from the consequences above them.
 */
export function ConfirmBox({ children }: { readonly children: ReactNode }) {
  return <View style={styles.confirmBox}>{children}</View>;
}

/** The acknowledgement before a destructive step: a checkbox, with the sentence as its name. */
export function Acknowledge({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      aria-checked={checked}
      {...spaceActivates(() => onChange(!checked))}
      onPress={() => onChange(!checked)}
      style={[styles.acknowledge, focus.style]}
    >
      <View style={[styles.box, checked ? styles.boxChecked : null]}>
        {checked ? <Icon name="check" size={16} color={content.paper} /> : null}
      </View>
      <Text variant="bodyS" style={styles.title}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: spacing[4], paddingBottom: spacing[1] },
  row: {
    minHeight: 58,
    paddingVertical: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: content.rule,
  },
  who: { flex: 1, minWidth: 0, gap: 2 },
  title: { flexShrink: 1 },
  receipt: {
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderWidth: borderWidth.regular,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  receiptHead: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  receiptBody: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3] },
  receiptText: { flexGrow: 1, flexShrink: 1, flexBasis: 160, gap: spacing[1] },
  when: { marginLeft: 'auto' },
  confirmBox: {
    gap: spacing[3],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: status.danger.edge,
    borderRadius: radius.lg,
  },
  acknowledge: {
    minHeight: target.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.paper,
  },
  boxChecked: { backgroundColor: content.ink },
});
