import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, radius, spacing } from '@knowscroll/design-tokens';
import { dataSet } from '../../display/data-set';
import { useFocusRing } from '../../display/focus-ring';
import { toggleSemantics } from '../../display/semantics';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { FigureDrawing, useKitFigure, type FigureState } from '../stage/kit-figure';
import { TiltControl } from '../stage/tilt-control';
import { AXIAL_TILT_DEGREES } from '../model';
import type { FigureControl } from './reading-model';

export interface FigureViewProps {
  readonly figure: FigureState;
  readonly height: number;
  readonly reducedMotion: boolean;
  /** The reader's text version: every figure as its words. A figure's own chip can override it. */
  readonly textVersion: boolean;
  readonly control?: FigureControl | undefined;
  readonly testID?: string;
}

/**
 * One figure in the essay: a plate with the kit's picture, a "Text" chip that swaps the picture for its words, and the
 * control under it when it has one. Moving from one figure to the next glides or fades (`useKitFigure`), so a held
 * figure changes in place.
 */
export function FigureView({ figure, height, reducedMotion, textVersion, control, testID }: FigureViewProps) {
  const page = usePagePalette();
  const [ownText, setOwnText] = useState<boolean | undefined>(undefined);
  const [tilt, setTilt] = useState<number | undefined>(undefined);
  const drawn = useKitFigure(figure, reducedMotion, control?.kind === 'tilt' ? tilt : undefined);
  const asText = ownText ?? textVersion;
  return (
    <View style={styles.figure} testID={testID}>
      <View
        style={[styles.plate, { height, backgroundColor: page.raised, borderColor: page.ink }]}
        {...dataSet({ ksFigure: figure.key, ksFigureTransition: drawn.transition })}
      >
        <FigureDrawing drawn={drawn} textVersion={asText} />
        <TextChip on={asText} onPress={() => setOwnText(!asText)} />
      </View>
      {control?.kind === 'tilt' && figure.kind === 'state' ? (
        <TiltControl value={tilt ?? AXIAL_TILT_DEGREES} onChange={setTilt} onDragging={() => undefined} />
      ) : null}
    </View>
  );
}

function TextChip({ on, onPress }: { readonly on: boolean; readonly onPress: () => void }) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...toggleSemantics(on)}
      accessibilityLabel="Text version of this picture"
      onPress={onPress}
      style={[styles.chip, { borderColor: page.ink, backgroundColor: on ? page.ink : page.ground }, focus.style]}
    >
      <Text variant="monoXs" color={on ? page.ground : page.ink}>
        Text
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  figure: { gap: spacing[2] },
  plate: { width: '100%', borderWidth: borderWidth.regular, borderRadius: radius.lg, overflow: 'hidden' },
  chip: {
    position: 'absolute',
    right: spacing[2],
    bottom: spacing[2],
    minHeight: 32,
    minWidth: 44,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: borderWidth.regular,
  },
});
