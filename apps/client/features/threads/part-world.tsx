import { StyleSheet, View } from 'react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { PlanetDisc } from '../universe/dial/dial-art';
import type { PlanetType } from '../universe/space/planet-genome';

const TYPES: readonly PlanetType[] = ['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas'];

/** A small stable number from an ID, so the same Scroll paints the same world on every device. */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return hash >>> 0;
}

/** The look of the world a part is painted as: a biome and a hue shift, both from the Scroll's own ID. */
export interface PartWorldLook {
  readonly type: PlanetType;
  readonly hueShift: number;
}

/**
 * The painted world of a part (T3 "painted worlds"). It is a picture of the Scroll, not of anyone's universe: it comes
 * from the Scroll's ID alone, so every member of a thread sees the same world on the same part, and nothing a person
 * read or formed changes it. The Universe's own planets keep their own server-assigned looks.
 */
export function partWorldLook(assetId: string): PartWorldLook {
  const hash = hashOf(assetId);
  return { type: TYPES[hash % TYPES.length]!, hueShift: (hash >>> 8) % 40 };
}

/** A part has art unless its Scroll is gone: then the part keeps its number (the caller draws it). */
export const hasPartWorld = (episode: ThreadEpisode): boolean => episode.state !== 'unavailable';

/** The painted world of one part, `size` px across. Decorative: the part's name and who is on it are said elsewhere. */
export function PartWorldDisc({ assetId, size }: { readonly assetId: string; readonly size: number }) {
  const look = partWorldLook(assetId);
  return (
    <View aria-hidden style={[styles.box, { width: size, height: size }]} testID="painted-world">
      <PlanetDisc planet={{ ...look, rings: false }} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({ box: { alignItems: 'center', justifyContent: 'center' } });
