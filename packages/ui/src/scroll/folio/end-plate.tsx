import { useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import type { NextPartPeek } from '../reader/reader-commands';
import { FigureView } from './figure-view';
import type { EndPlate } from './reading-model';

export interface EndPlateProps {
  readonly end: EndPlate;
  readonly figureHeight: number;
  readonly reducedMotion: boolean;
  readonly textVersion: boolean;
  readonly nextPart?: NextPartPeek | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onNextIdea?: (() => void) | undefined;
  /** How far a finger has pulled up past the end, 0 to 1, where a pull can move on (`use-end-pull`). */
  readonly pull?: Animated.Value | undefined;
  /** What the screen adds before the ways on (a thread's "I've finished this part"). */
  readonly endSlot?: ReactNode;
}

/**
 * The end of the essay (folio README 5.2): the takeaway, the picture of the whole journey where the kit draws one, the
 * small print one tap away, then the ways on, each a button the person presses: Part 2 when one was admitted, Next idea,
 * and Close. Nothing moves on by itself.
 */
export function EndPlateView({
  end,
  figureHeight,
  reducedMotion,
  textVersion,
  nextPart,
  onClose,
  onNextIdea,
  pull,
  endSlot,
}: EndPlateProps) {
  const page = usePagePalette();
  const [smallPrintOpen, setSmallPrintOpen] = useState(false);
  return (
    <View style={[styles.plate, { borderTopColor: page.ink }]} testID="end-plate">
      <Text variant="label" color={page.link} heading={2}>
        The short version
      </Text>
      {end.takeaway.map((line) => (
        <Text key={line} variant="title" color={page.ink}>
          {line}
        </Text>
      ))}
      {end.figure === undefined ? null : (
        <FigureView
          figure={end.figure}
          height={figureHeight}
          reducedMotion={reducedMotion}
          textVersion={textVersion}
          testID="end-figure"
        />
      )}
      {end.smallPrint === undefined ? null : (
        <View style={styles.smallPrint}>
          <Button
            label="Small print"
            variant="ghost"
            size="sm"
            expanded={smallPrintOpen}
            onPress={() => setSmallPrintOpen((open) => !open)}
          />
          {smallPrintOpen ? (
            <View style={styles.smallPrintText} testID="end-small-print">
              <Text variant="label" color={page.ink2} heading={3}>
                {end.smallPrint.title}
              </Text>
              <Text variant="bodyS" color={page.ink}>
                {end.smallPrint.text}
              </Text>
            </View>
          ) : null}
        </View>
      )}
      {endSlot}
      <View style={[styles.ways, { borderTopColor: page.ink }]}>
        {nextPart === undefined ? null : (
          <Button label={`${nextPart.label} · ${nextPart.title}`} variant="continue" onPress={nextPart.onPress} />
        )}
        {/* Close and the next idea share a row, the next idea taking the room: the prototype's end plate. */}
        <View style={styles.row}>
          {onClose === undefined ? null : <Button label="Close" variant="default" onPress={onClose} />}
          {onNextIdea === undefined ? null : (
            <View style={styles.grow}>
              <Button
                label="Next idea"
                variant="primary"
                icon="arrowRight"
                iconPosition="trailing"
                onPress={onNextIdea}
              />
            </View>
          )}
        </View>
      </View>
      {onNextIdea === undefined || pull === undefined ? null : <PullMeter pull={pull} />}
    </View>
  );
}

/**
 * Under the ways on, where a pull past the end begins: "Keep pulling · next topic" and a meter that fills as the finger
 * pulls, full where a release moves on. It is for the eye alone; Next idea and the N key are the controls that do the
 * same. It fills under reduced motion too: it is feedback and travels nowhere.
 */
function PullMeter({ pull }: { readonly pull: Animated.Value }) {
  const page = usePagePalette();
  const filled = pull.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' });
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" style={styles.pull} testID="pull-handle">
      <View style={[styles.grip, { backgroundColor: page.rule }]} />
      <View style={styles.pullRow}>
        <Icon name="arrowUp" size={14} color={page.ink} />
        <Text variant="monoXs" color={page.ink2} style={styles.pullWords}>
          KEEP PULLING · NEXT TOPIC
        </Text>
        <View style={[styles.meter, { borderColor: page.ink, backgroundColor: page.ground }]} testID="pull-meter">
          <Animated.View style={[styles.meterFill, { width: filled }]} testID="pull-meter-fill" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { gap: spacing[4], paddingTop: spacing[6], borderTopWidth: borderWidth.regular },
  smallPrint: { gap: spacing[2], alignItems: 'flex-start' },
  smallPrintText: { gap: spacing[1] },
  ways: { gap: spacing[3], paddingTop: spacing[5], borderTopWidth: borderWidth.regular },
  row: { flexDirection: 'row', gap: spacing[3], alignItems: 'stretch' },
  grow: { flex: 1, minWidth: 0 },
  pull: { gap: spacing[2], alignItems: 'center', paddingTop: spacing[2] },
  grip: { width: 40, height: 4, borderRadius: 2 },
  pullRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], alignSelf: 'stretch' },
  pullWords: { flexShrink: 1 },
  meter: {
    flex: 1,
    minWidth: 48,
    height: 8,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    overflow: 'hidden',
  },
  meterFill: { height: '100%', backgroundColor: content.continue },
});
