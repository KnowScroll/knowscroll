import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, radius, spacing } from '@knowscroll/design-tokens';
import type { PictureState } from '@knowscroll/scroll-model';
import { partIds } from '../model';
import { dataSet } from '../../display/data-set';
import { useDisplay } from '../../display/display';
import { useFocusRing } from '../../display/focus-ring';
import { toggleSemantics } from '../../display/semantics';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { PictureDrawing } from '../picture';
import { PictureControl } from './picture-control';
import type { Figure, FigureControl, PictureFigure } from './reading-model';

export interface FigureViewProps {
  readonly figure: Figure;
  readonly height: number;
  readonly reducedMotion: boolean;
  /** The reader's text version: every figure as its words. A figure's own chip can override it. */
  readonly textVersion: boolean;
  readonly control?: FigureControl | undefined;
  /**
   * The plate holds `height` inside its border, its chip strip included, so the drawing fits above the strip: a held figure,
   * whose height the hold's geometry is built on (`canPinHolds`, the reading line). Otherwise the plate is the drawing's
   * height plus the strip.
   */
  readonly fixedHeight?: boolean;
  /**
   * Given, the chip is the reader's text version rather than this figure's own (a held figure, whose words would not fit
   * its pinned plate): it shows that and turns it.
   */
  readonly onTextVersion?: (() => void) | undefined;
  /** The part of a picture a linked phrase was just pressed for: a picture that has it emphasises it. */
  readonly pulsing?: string | undefined;
  readonly testID?: string;
}

/**
 * One figure in the essay: a plate with its picture, a "Text" chip that swaps the picture for its words, and the
 * control under it when it has one. A document v3's picture is drawn by the general picture renderer, and moves from one
 * state to the next in place (a glide, or a fade), so a held figure changes where it is.
 */
export function FigureView(props: FigureViewProps) {
  return <PictureFigureView {...props} figure={props.figure} />;
}

/**
 * The state a picture figure shows: the one its beat gave it until the reader changes it with the control under it. A
 * change belongs to the state it was made from, so a figure that moves on (a hold) starts from the state it is given.
 */
function useShownState(figure: PictureFigure): readonly [PictureState, (state: PictureState) => void] {
  const [changed, setChanged] = useState<{ readonly key: string; readonly state: PictureState } | undefined>(undefined);
  const state = changed?.key === figure.key ? changed.state : figure.state;
  return [state, (next) => setChanged({ key: figure.key, state: next })];
}

/**
 * A document v3 picture on the plate, drawn by the general renderer, with its control under it when the beat has one.
 * The control changes the picture here and nowhere else; nothing it does is reported or stored (D-209).
 */
function PictureFigureView({
  figure,
  height,
  reducedMotion,
  textVersion,
  control,
  fixedHeight = false,
  onTextVersion,
  pulsing,
  testID,
}: FigureViewProps & { readonly figure: PictureFigure }) {
  const page = usePagePalette();
  // A picture's labels grow with the reader's text size, within the box it is drawn in.
  const { textScale } = useDisplay();
  const [ownText, setOwnText] = useState<boolean | undefined>(undefined);
  const [state, setState] = useShownState(figure);
  const asText = onTextVersion === undefined ? (ownText ?? textVersion) : textVersion;
  const drawingHeight = fixedHeight ? height - FIGURE_CHIP_ROOM : height;
  const pulsed = pulsing !== undefined && partIds(figure.picture).includes(pulsing) ? pulsing : undefined;
  return (
    <View style={styles.figure} testID={testID}>
      <View
        style={[styles.plate, { backgroundColor: page.raised, borderColor: page.ink }]}
        {...dataSet({ ksFigure: figure.key })}
      >
        <View style={asText ? { minHeight: drawingHeight } : { height: drawingHeight }}>
          <PictureDrawing
            picture={figure.picture}
            state={state}
            reducedMotion={reducedMotion}
            textVersion={asText}
            textScale={textScale}
            pulsing={pulsed}
          />
        </View>
        <View style={styles.chipRow}>
          <TextChip on={asText} onPress={onTextVersion ?? (() => setOwnText(!asText))} />
        </View>
      </View>
      {control === undefined ? null : (
        <PictureControl
          picture={figure.picture}
          control={control}
          base={figure.state}
          state={state}
          onState={setState}
        />
      )}
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

const CHIP_HEIGHT = 32;
/**
 * How much taller than its drawing a figure's plate is: the strip along its bottom that the chip sits in, so the chip
 * never covers a label (a picture draws to the edges of its frame, and the bottom right is where one may be put).
 */
const FIGURE_CHIP_ROOM = CHIP_HEIGHT + spacing[2];

const styles = StyleSheet.create({
  figure: { gap: spacing[2] },
  chipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[2],
  },
  plate: { width: '100%', borderWidth: borderWidth.regular, borderRadius: radius.lg, overflow: 'hidden' },
  chip: {
    minHeight: CHIP_HEIGHT,
    minWidth: 44,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: borderWidth.regular,
  },
});
