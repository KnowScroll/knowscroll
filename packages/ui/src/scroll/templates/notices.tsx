import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import type { ScrollDocument } from '@knowscroll/scroll-model';
import { Banner } from '../../status/banner';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-10-14" → "14 Oct": English, no locale lookup, so the same everywhere. */
export function correctionDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ''}`.trim();
}

/** The persistent "Corrected 14 Oct" notes of a revision, under the title; they cannot be hidden. */
export function CorrectionNotices({ corrections }: { readonly corrections: ScrollDocument['corrections'] }) {
  if (corrections.length === 0) return null;
  return (
    <View style={styles.stack}>
      {corrections.map((correction) => (
        <Banner
          key={`${correction.on}:${correction.summary}`}
          kind="corrected"
          lead={`Corrected ${correctionDate(correction.on)}.`}
          message={correction.summary}
        />
      ))}
    </View>
  );
}

function Bullets({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text variant="label" color={status.hypothetical.foreground}>
        {title}
      </Text>
      {items.map((item) => (
        <Text key={item} variant="bodyS" style={styles.item}>
          {item}
        </Text>
      ))}
    </View>
  );
}

/**
 * How the Scroll relates to what is established (D-006 a), shown above the first section and
 * never hideable. Only "Hypothetical" is a status label; a perspective names its lens.
 */
export function FramingNotice({ framing }: { readonly framing: ScrollDocument['framing'] }) {
  if (framing.kind === 'factual') return null;
  if (framing.kind === 'perspective') {
    return (
      <View style={styles.perspective}>
        <Tag label="Perspective" />
        <Text variant="bodyS" color={content.ink2}>
          {`Seen through ${framing.lens}`}
        </Text>
      </View>
    );
  }
  return (
    <View role="group" accessibilityLabel="Hypothetical" style={styles.hypothetical}>
      <Tag label="Hypothetical" variant="hypothetical" />
      <Bullets title="What changes" items={framing.assumptions} />
      <Bullets title="What stays the same" items={framing.kept} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[2] },
  group: { gap: spacing['1.5'] },
  item: { paddingLeft: spacing[2] },
  perspective: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' },
  hypothetical: {
    gap: spacing[3],
    padding: spacing['3.5'],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
});
