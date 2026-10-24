import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import type { OperatorUnavailableReason } from './operator-copy';
import { operatorColor, operatorFont } from './operator-theme';
import { unavailableWords } from './operator-copy';

/** Mono text in the operator register. */
export function Mono({
  children,
  size = 12,
  color = operatorColor.strong,
  selectable = false,
  style,
}: {
  readonly children: ReactNode;
  readonly size?: number;
  readonly color?: string;
  readonly selectable?: boolean;
  readonly style?: TextStyle;
}) {
  return (
    <Text selectable={selectable} style={[{ fontFamily: operatorFont.mono, fontSize: size, color }, style]}>
      {children}
    </Text>
  );
}

export function Note({ children }: { readonly children: ReactNode }) {
  return <Text style={styles.note}>{children}</Text>;
}

/** One card of the screen: a numbered title, where its data comes from, and its panels. */
export function Card({
  title,
  source,
  children,
  testID,
}: {
  readonly title: string;
  readonly source: string;
  readonly children: ReactNode;
  readonly testID?: string;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <Text role="heading" aria-level={2} style={styles.cardTitle}>
        {title}
      </Text>
      <Mono size={11} color={operatorColor.quiet}>
        {source}
      </Mono>
      {children}
    </View>
  );
}

/** A small labelled box inside a card. */
export function Box({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View style={styles.box}>
      <Mono size={11} color={operatorColor.strong}>
        {label}
      </Mono>
      {children}
    </View>
  );
}

/** A piece that cannot be shown, in words, with a dashed edge. Never a number. */
export function Unavailable({ label, reason }: { readonly label: string; readonly reason: OperatorUnavailableReason }) {
  return (
    <View style={[styles.box, styles.dashed, styles.unavailable]} accessibilityLabel={`${label}: unavailable`}>
      <Mono size={11}>{label}</Mono>
      <Mono size={12} color={operatorColor.faint}>
        Unavailable · {unavailableWords[reason]}
      </Mono>
    </View>
  );
}

export function Chip({ children, attention = false }: { readonly children: ReactNode; readonly attention?: boolean }) {
  return (
    <View style={[styles.chip, attention ? { borderColor: operatorColor.attention } : null]}>
      <Mono size={11} color={attention ? operatorColor.attentionInk : operatorColor.ink}>
        {children}
      </Mono>
    </View>
  );
}

/** One line of a list: columns of mono text, wrapping on narrow screens. */
export function Line({ children, attention = false }: { readonly children: ReactNode; readonly attention?: boolean }) {
  return <View style={[styles.line, attention ? { borderLeftColor: operatorColor.attention } : null]}>{children}</View>;
}

export function TextButton({
  label,
  onPress,
  busy = false,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy, disabled: busy }}
      aria-busy={busy}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <Mono size={12} color={operatorColor.ink}>
        {busy ? `${label}…` : label}
      </Mono>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  note: { fontFamily: operatorFont.text, fontSize: 12.5, lineHeight: 18, color: operatorColor.strong },
  card: {
    backgroundColor: operatorColor.card,
    borderColor: operatorColor.cardEdge,
    borderWidth: 1,
    borderRadius: 8,
    padding: 18,
    gap: 12,
  },
  cardTitle: { fontFamily: operatorFont.mono, fontSize: 15, color: operatorColor.ink },
  box: {
    borderColor: operatorColor.boxEdge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: operatorColor.box,
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 6,
  },
  dashed: { borderStyle: 'dashed' },
  unavailable: { flexGrow: 1, minWidth: 150 },
  chip: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderColor: operatorColor.chipEdge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: operatorColor.card,
  },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 2,
    paddingVertical: 6,
    paddingLeft: 8,
    borderLeftWidth: 3,
    borderLeftColor: operatorColor.boxEdge,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderColor: operatorColor.chipEdge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: operatorColor.card,
  },
  pressed: { backgroundColor: operatorColor.box },
});
