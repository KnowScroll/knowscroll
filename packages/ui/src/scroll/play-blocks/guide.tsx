import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';
import type { Guide } from '../model';

/** What the reader calls each guide character. The recipe chooses the character; the writer never draws one. */
const NAMES: Readonly<Record<Guide['character'], string>> = { ray: 'Ray' };

const INK = content.ink;

/**
 * Ray, the sunbeam: a yellow slanted band with a face, drawn by the kit and never by the writer (D-207).
 * The pose is the face: a smile, wide-eyed wonder, or a smile with an arm out to point.
 */
export function Ray({ pose }: { readonly pose: Guide['pose'] }) {
  return (
    <Svg width={64} height={84} viewBox="0 0 64 84" aria-hidden>
      <G rotation={-14} origin="28, 42">
        <Rect x={10} y={6} width={36} height={70} rx={8} fill={content.continue} stroke={INK} strokeWidth={2.5} />
        {pose === 'wonder' ? (
          <G>
            <Circle cx={21} cy={32} r={3.6} fill={INK} />
            <Circle cx={35} cy={32} r={3.6} fill={INK} />
            <Line x1={17} y1={24} x2={25} y2={22} stroke={INK} strokeWidth={2} strokeLinecap="round" />
            <Line x1={31} y1={22} x2={39} y2={24} stroke={INK} strokeWidth={2} strokeLinecap="round" />
            <Circle cx={28} cy={48} r={4.2} fill="none" stroke={INK} strokeWidth={2.2} />
          </G>
        ) : (
          <G>
            <Circle cx={21} cy={33} r={2.8} fill={INK} />
            <Circle cx={35} cy={33} r={2.8} fill={INK} />
            <Path d="M19 44 Q28 54 37 44" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
          </G>
        )}
      </G>
      {pose === 'point' ? (
        <G>
          <Line x1={42} y1={50} x2={58} y2={42} stroke={INK} strokeWidth={3} strokeLinecap="round" />
          <Circle cx={59} cy={41} r={3} fill={content.continue} stroke={INK} strokeWidth={2} />
        </G>
      ) : null}
    </Svg>
  );
}

/**
 * A line from the Scroll's guide (D-207): the character beside a bubble. The guide speaks rarely and
 * only to make the mechanism literal; the words are cited like any other claim. The text version is the
 * line with the speaker's name, no drawing.
 */
export function GuideView({ guide, asText }: { readonly guide: Guide; readonly asText: boolean }) {
  const name = NAMES[guide.character];
  if (asText)
    return (
      <Text variant="body" testID="guide-text">
        {`${name}: ${guide.line}`}
      </Text>
    );
  return (
    <View style={styles.row} testID="guide" accessibilityLabel={`${name} says: ${guide.line}`} role="group">
      <View style={styles.character} aria-hidden>
        <Ray pose={guide.pose} />
      </View>
      <View style={styles.bubble}>
        <Text variant="label" color={content.ink2}>
          {name}
        </Text>
        <Text variant="body">{guide.line}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], alignSelf: 'stretch' },
  character: { width: 64, height: 84 },
  bubble: {
    flex: 1,
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
});
