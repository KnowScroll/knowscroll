import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { IconButton } from '../../actions/icon-button';
import { dataSet } from '../../display/data-set';
import { useDisplay } from '../../display/display';
import { useFocusRing } from '../../display/focus-ring';
import { scrollPageSurface } from '../../display/scroll-page-surface';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import { FigureDrawing, useKitFigure, type FigureState } from '../stage/kit-figure';
import { isWide } from './essay-layout';
import { EssayOpening } from './essay-opening';

export interface EssayCoverProps {
  readonly kicker: string;
  readonly title: string;
  readonly dek: string;
  /** Reading time in minutes as the document states it; shown as max(1, round(minutes)) "MIN". */
  readonly minutes: number;
  /** The first figure of a v2 Scroll (kind 'state'); absent for a text-only cover. */
  readonly figure?: FigureState | undefined;
  /** 'continue' when the person has read part of it before (the button says "Continue"), else 'read' ("Read"). */
  readonly way: 'read' | 'continue';
  /** Which cover of the hand this is, 1-based, and how many the hand has: "1 OF 3". */
  readonly position: { readonly index: number; readonly count: number };
  /** What the next move shows: the next cover of the hand, or more covers after the last. */
  readonly next: { readonly kicker: string; readonly title: string } | 'more';
  readonly onOpen: () => void;
  readonly onNext: () => void;
  /** Absent on the first cover of a hand. */
  readonly onPrevious?: (() => void) | undefined;
  readonly reducedMotion: boolean;
  /** Height the cover may use (the viewport below any app chrome); the figure shrinks or drops to fit. */
  readonly height: number;
  readonly testID?: string | undefined;
}

/** The figure's drawing: never shorter than this on a phone when there is room, and dropped below `FIGURE_LEAST`. */
const FIGURE_PHONE = { least: 190, most: 300 } as const;
const FIGURE_WIDE = { least: 190, most: 360 } as const;
/** The least room worth a figure: under it the plate shows too little of a picture to be a picture. */
const FIGURE_LEAST = 140;
const GAP = spacing[4];
const PAD = spacing[4];
const BUTTON = 44;

interface Measured {
  /** The upper block (position row, opening, figure, way in) at its own height, and the figure's plate within it. */
  readonly main: number;
  readonly plate: number;
  /** The strip that names what the next move shows. */
  readonly strip: number;
}

/**
 * A Scroll as a cover (folio README, "The cover"): what it is about, at the type the essay opens with, one picture of it,
 * and two ways on: open it, or go to the next cover. It draws no part of the essay's reading. Its picture cannot be
 * operated (no "Text" chip, no control), so tapping the opening or the picture opens the Scroll, as the Read button
 * does; that area is not a second control for a keyboard or a screen reader.
 *
 * The cover is the Scroll's page, so Light and Dark match the essay it opens into. It takes the `height` it is given:
 * the picture is the part that gives way (shorter, then dropped), and what is left still scrolls inside the cover
 * rather than clip a line of text at large text sizes.
 */
export function EssayCover({
  kicker,
  title,
  dek,
  minutes,
  figure,
  way,
  position,
  next,
  onOpen,
  onNext,
  onPrevious,
  reducedMotion,
  height,
  testID = 'essay-cover',
}: EssayCoverProps) {
  const page = usePagePalette();
  const { breakpoint } = useDisplay();
  const wide = isWide(breakpoint);
  const measure = wide ? (breakpoint === 'desktop' ? layout.measureDesktop : layout.measureTablet) : undefined;
  const [measured, setMeasured] = useState<Partial<Measured>>({});
  const bounds = wide ? FIGURE_WIDE : FIGURE_PHONE;
  const frame = 2 * borderWidth.regular;

  // What is left for the picture once everything else is measured at its own size (large text included). Before the first
  // measure the picture has its least height, and the measure then settles it.
  let drawing: number | undefined = bounds.least;
  if (figure === undefined) {
    drawing = undefined;
  } else if (measured.main !== undefined && measured.strip !== undefined) {
    const others = measured.main - (measured.plate === undefined || measured.plate === 0 ? 0 : measured.plate + GAP);
    const room = height - (others + measured.strip + 2 * PAD + GAP) - GAP;
    drawing = room < FIGURE_LEAST ? undefined : Math.floor(Math.min(bounds.most, room - frame));
  }

  const column = measure === undefined ? styles.column : [styles.column, { maxWidth: measure }];
  const minutesShown = Math.max(1, Math.round(minutes));
  const measuring = (key: keyof Measured) => (event: LayoutChangeEvent) => {
    const value = Math.round(event.nativeEvent.layout.height);
    setMeasured((now) => (now[key] === value ? now : { ...now, [key]: value }));
  };

  return (
    <View style={[styles.cover, { height, backgroundColor: page.ground }]} testID={testID} {...scrollPageSurface()}>
      <ScrollView contentContainerStyle={[styles.content, { minHeight: height }]}>
        <View style={column}>
          <View style={styles.main} onLayout={measuring('main')} testID="essay-cover-body">
            <View style={styles.topRow}>
              <Text variant="label" color={page.ink2}>{`${position.index} OF ${position.count}`}</Text>
              <View style={styles.moves}>
                {onPrevious === undefined ? null : (
                  <IconButton
                    icon="arrowUp"
                    label="Previous cover"
                    size={BUTTON}
                    onPress={onPrevious}
                    testID="essay-cover-previous"
                  />
                )}
                <IconButton
                  icon="arrowDown"
                  label="Next cover"
                  size={BUTTON}
                  onPress={onNext}
                  testID="essay-cover-down"
                />
              </View>
            </View>
            {/* A tap anywhere on the opening or the picture opens the Scroll; the Read button is the one control for it. */}
            <Pressable accessible={false} focusable={false} tabIndex={-1} onPress={onOpen} style={styles.touch}>
              <EssayOpening kicker={kicker} title={title} dek={dek} style={styles.opening} />
              {figure === undefined || drawing === undefined ? null : (
                <CoverFigure
                  figure={figure}
                  drawing={drawing}
                  reducedMotion={reducedMotion}
                  onPlate={measuring('plate')}
                />
              )}
            </Pressable>
            <View style={styles.wayIn}>
              <Button
                label={way === 'continue' ? 'Continue' : 'Read'}
                accessibilityLabel={`${way === 'continue' ? 'Continue' : 'Read'} ${title}`}
                variant="primary"
                icon="arrowDown"
                iconPosition="trailing"
                onPress={onOpen}
                testID="essay-cover-read"
              />
              <Text variant="label" color={page.ink2}>{`${minutesShown} MIN`}</Text>
            </View>
          </View>
          <NextStrip next={next} onPress={onNext} onLayout={measuring('strip')} />
        </View>
      </ScrollView>
    </View>
  );
}

/** The first picture of the Scroll on its plate, drawn as the essay draws a figure but with nothing to operate. */
function CoverFigure({
  figure,
  drawing,
  reducedMotion,
  onPlate,
}: {
  readonly figure: FigureState;
  readonly drawing: number;
  readonly reducedMotion: boolean;
  readonly onPlate: (event: LayoutChangeEvent) => void;
}) {
  const page = usePagePalette();
  const drawn = useKitFigure(figure, reducedMotion);
  return (
    <View
      style={[styles.plate, { backgroundColor: page.raised, borderColor: page.ink }]}
      onLayout={onPlate}
      testID="essay-cover-figure"
      {...dataSet({ ksFigure: figure.key, ksFigureTransition: drawn.transition })}
    >
      <View style={{ height: drawing }}>
        <FigureDrawing drawn={drawn} />
      </View>
    </View>
  );
}

/** The strip at the foot: it names what going on shows ("NEXT · KICKER" over the next title), or that more covers come. */
function NextStrip({
  next,
  onPress,
  onLayout,
}: {
  readonly next: EssayCoverProps['next'];
  readonly onPress: () => void;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      onPress={onPress}
      onLayout={onLayout}
      style={[styles.strip, { backgroundColor: page.raised, borderColor: page.ink }, focus.style]}
      testID="essay-cover-next"
    >
      <View style={styles.stripWords}>
        {next === 'more' ? (
          <Text variant="label" color={page.ink}>
            MORE COVERS
          </Text>
        ) : (
          <>
            <Text variant="label" color={page.link}>{`NEXT · ${next.kicker}`}</Text>
            <Text variant="uiS" color={page.ink}>
              {next.title}
            </Text>
          </>
        )}
      </View>
      <Icon name="chevronDown" size={22} color={page.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { width: '100%', overflow: 'hidden' },
  content: { paddingHorizontal: layout.gutter, paddingVertical: PAD, alignItems: 'center', flexGrow: 1 },
  // Fills the cover's height, so the strip rests at its foot when the rest is short.
  column: { width: '100%', flexGrow: 1, justifyContent: 'space-between', gap: GAP },
  main: { gap: GAP },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  moves: { flexDirection: 'row', gap: spacing[2] },
  touch: { gap: GAP },
  opening: { paddingTop: spacing[2] },
  plate: { width: '100%', borderWidth: borderWidth.regular, borderRadius: radius.lg, overflow: 'hidden' },
  wayIn: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3] },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    minHeight: BUTTON,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderWidth: borderWidth.regular,
    borderRadius: radius.lg,
    cursor: 'pointer' as const,
  },
  stripWords: { flex: 1, minWidth: 0, gap: spacing['0.5'] },
});
