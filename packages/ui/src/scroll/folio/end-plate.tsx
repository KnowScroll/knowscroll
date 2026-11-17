import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
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
        {onNextIdea === undefined ? null : <Button label="Next idea" variant="primary" onPress={onNextIdea} />}
        {onClose === undefined ? null : <Button label="Close" variant="default" onPress={onClose} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { gap: spacing[4], paddingTop: spacing[6], borderTopWidth: borderWidth.regular },
  smallPrint: { gap: spacing[2], alignItems: 'flex-start' },
  smallPrintText: { gap: spacing[1] },
  ways: { gap: spacing[3], paddingTop: spacing[5], borderTopWidth: borderWidth.regular },
});
