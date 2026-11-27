import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, radius, spacing, universe } from '@knowscroll/design-tokens';
import { printedSurface, useDisplay } from '@knowscroll/ui';
import { columnsFor, DESKTOP_GUTTER, FRAME, GUTTER, layoutOf, type MapLayout, type Size } from './map-layout';

/**
 * The frame both map screens stand in: the sky-dark Universe ground, a header, the drawing in a card, and a side that
 * is the list of regions or the region's contents. A phone or a tablet is one scrolling column at most
 * {@link PHONE_COLUMN} wide; from 1024 px the drawing stands left, fitted to the height, and the side stands right in
 * a column of its own. It is a dialog that covers the stage (the stage under it is hidden by whoever mounts this), and
 * it looks the same in Light and Dark: the Universe is pinned to its authored palette (#666).
 *
 * It measures itself, because beside the shell's rail it is narrower than the window.
 */
export function MapFrame({
  label,
  header,
  drawing,
  side,
  aspect,
}: {
  /** What a screen reader calls the dialog. */
  readonly label: string;
  readonly header: ReactNode;
  /** The drawing, given the size it has. */
  readonly drawing: (size: Size) => ReactNode;
  readonly side: ReactNode;
  /** The drawing's width over its height; the band's own 4:3 by default. */
  readonly aspect?: number;
}) {
  const { breakpoint } = useDisplay();
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState<Size | null>(null);
  // The desktop's header may be one line or two: the drawing takes what it leaves, measured, not guessed.
  const [headerHeight, setHeaderHeight] = useState<number | undefined>(undefined);
  const columns = columnsFor(breakpoint);
  const layout: MapLayout = layoutOf(measured ?? window, columns, aspect, headerHeight);
  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setMeasured({ width, height });
  };
  const card = (
    <View style={[styles.drawing, { width: layout.drawing.width + FRAME, height: layout.drawing.height + FRAME }]}>
      {drawing(layout.drawing)}
    </View>
  );
  return (
    <View
      testID="map-screen"
      role="dialog"
      aria-modal
      accessibilityViewIsModal
      accessibilityLabel={label}
      onLayout={onLayout}
      style={styles.root}
      {...printedSurface()}
    >
      {layout.columns === 1 ? (
        <ScrollView contentContainerStyle={styles.phone}>
          <View style={[styles.column, { width: layout.drawing.width + FRAME }]}>
            {header}
            {card}
            {side}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.desktop}>
          <View style={styles.left}>
            <View onLayout={(event) => setHeaderHeight(Math.ceil(event.nativeEvent.layout.height))}>{header}</View>
            {card}
          </View>
          <ScrollView
            style={[styles.side, { width: layout.listWidth ?? undefined }]}
            contentContainerStyle={styles.right}
          >
            {side}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: universe.sky },
  phone: { alignItems: 'center', paddingHorizontal: GUTTER, paddingTop: spacing[4], paddingBottom: spacing[8] },
  column: { gap: spacing[4] },
  desktop: { flex: 1, flexDirection: 'row', gap: DESKTOP_GUTTER, padding: DESKTOP_GUTTER },
  left: { flex: 1, gap: spacing[4] },
  /** A scroll view grows by default and would take the drawing's room: this column is as wide as it is asked. */
  side: { flexGrow: 0, flexShrink: 0 },
  right: { paddingBottom: spacing[8] },
  drawing: {
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: universe.paper,
    overflow: 'hidden',
    backgroundColor: universe.sky,
  },
});
