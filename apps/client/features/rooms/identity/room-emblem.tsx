import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { ROOM_SWATCHES, type RoomKit } from '@knowscroll/contracts';
import { FRAME_OUTLINES, GLYPH_SHAPES, innerOutline, pathOf } from './shapes';

/**
 * A room's emblem (D-170): the frame in the kit's ink, its face in the ground and the glyph in the accent, drawn from the
 * closed vocabulary's own outlines. It is a picture and carries no meaning of its own: whatever shows it names the room
 * beside it, so it is hidden from screen readers.
 */
export function RoomEmblem({
  kit,
  size,
  testID,
}: {
  readonly kit: Pick<RoomKit, 'emblem' | 'palette'>;
  readonly size: number;
  readonly testID?: string;
}) {
  const { ground, accent, ink } = kit.palette;
  const outline = FRAME_OUTLINES[kit.emblem.frame];
  return (
    <View style={{ width: size, height: size }} aria-hidden accessibilityElementsHidden testID={testID}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={pathOf([outline])} fill={ROOM_SWATCHES[ink]} />
        <Path d={pathOf([innerOutline(outline)])} fill={ROOM_SWATCHES[ground]} />
        {GLYPH_SHAPES[kit.emblem.glyph].map((shape, index) => (
          <Path
            // The shapes of a glyph are a fixed list, never reordered.
            key={index}
            d={pathOf(shape.contours)}
            fill={ROOM_SWATCHES[shape.role === 'mark' ? accent : ground]}
          />
        ))}
      </Svg>
    </View>
  );
}

/** A resident's colour in a room: the Explainer wears the room's accent and the Skeptic its ink, as their marks do (D-170). */
export const residentColourOf = (kit: Pick<RoomKit, 'palette'>, resident: 'explainer' | 'skeptic'): string =>
  ROOM_SWATCHES[resident === 'explainer' ? kit.palette.accent : kit.palette.ink];

/**
 * The mark a resident wears in a room (D-170, R3 C): its glyph on a tile with square corners, which is how an AI is
 * drawn everywhere (never a face, never a person). The Explainer's tile is the room's accent and the Skeptic's its ink;
 * the glyph is drawn in the ground, which both contrast with. The AI label beside it carries the meaning.
 */
export function ResidentMark({
  kit,
  resident,
  size = 28,
  testID,
}: {
  readonly kit: Pick<RoomKit, 'palette' | 'cast'>;
  readonly resident: 'explainer' | 'skeptic';
  readonly size?: number;
  readonly testID?: string;
}) {
  const { ground, accent, ink } = kit.palette;
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      testID={testID}
      style={[styles.tile, { width: size, height: size, backgroundColor: residentColourOf(kit, resident) }]}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {GLYPH_SHAPES[kit.cast[resident]].map((shape, index) => (
          <Path
            key={index}
            d={pathOf(shape.contours)}
            fill={ROOM_SWATCHES[shape.role === 'mark' ? ground : resident === 'explainer' ? accent : ink]}
          />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // An AI's corner is square (the room's messages draw it so too), softened a hair so the tile is not a hard box.
  tile: { borderRadius: 3, overflow: 'hidden' },
});
