import { StyleSheet, View } from 'react-native';
import { spacing, universe } from '@knowscroll/design-tokens';
import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { Text, useDisplay } from '@knowscroll/ui';
import { FlatPlanet } from './flat-planet';
import { MapFrame } from './map-frame';
import { MapHeader } from './map-header';
import { RegionRows } from './region-rows';
import { useFlatPlanet } from './use-flat-planet';

export interface PlanetMapScreenProps {
  /** Keeps the planet's built world between screens (the Universe session; any object that lives as long as it should). */
  readonly session: object;
  readonly planet: SceneDescriptor;
  /** The planet's system, for the small line under the title. */
  readonly systemLabel?: string | undefined;
  /** The planet's FORMED regions, and nothing else: what the universe's index holds. The map is the only list of them. */
  readonly regions: readonly SceneDescriptor[];
  /** The scene looks by object id, which say the planet's type and each region's site. */
  readonly looks: ReadonlyMap<string, SceneLook>;
  /** The region left through Open, or none. */
  readonly hereId?: string | null | undefined;
  /** Closes the map: back to the camera it was opened from. */
  readonly onBack: () => void;
  /** A region was chosen, on the drawing or in the list: open its own map. */
  readonly onChooseRegion: (regionId: string) => void;
}

/**
 * Map 1: the whole planet as a flat map. The ground's own world once round, formed regions in colour and named, and
 * land not reached yet as one grey with no name, count or press (D-109), with the list of formed regions under it: a
 * tap on a region (its land or its row) opens that region's own map. The screen reads and writes nothing; it takes the
 * planet and its regions and says what was chosen. It is meant to sit over the stage while a map is open.
 *
 * The drawing is hidden from assistive technology and is not a tab stop; the rows are the accessible set, so every
 * formed region is reachable even when two names cannot both fit on the drawing.
 */
export function PlanetMapScreen({
  session,
  planet,
  systemLabel,
  regions,
  looks,
  hereId,
  onBack,
  onChooseRegion,
}: PlanetMapScreenProps) {
  const { reducedMotion } = useDisplay();
  const state = useFlatPlanet(session, planet, regions, looks);
  return (
    <MapFrame
      label={`Map of ${planet.label}`}
      header={
        <MapHeader
          backTo={planet.label}
          onBack={onBack}
          kicker={systemLabel === undefined ? 'A planet' : `A planet in ${systemLabel}`}
          title={`Map of ${planet.label}`}
          hypothetical={planet.truthStatus === 'hypothetical'}
        />
      }
      drawing={(size) =>
        state.flat === null ? (
          <View style={[styles.waiting, size]} testID="map-waiting">
            <Text variant="label" color={universe.label2} align="center">
              {state.status === 'refused'
                ? 'The map could not be drawn here. The regions are listed below.'
                : 'Drawing the map…'}
            </Text>
          </View>
        ) : (
          <FlatPlanet
            world={state.flat.world}
            chart={state.flat.chart}
            palette={state.palette}
            names={state.flat.names}
            size={size}
            hereId={hereId}
            reducedMotion={reducedMotion}
            onChoose={onChooseRegion}
          />
        )
      }
      side={
        <RegionRows regions={state.plan.regions} palette={state.palette} hereId={hereId} onChoose={onChooseRegion} />
      }
    />
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: 'center', justifyContent: 'center', padding: spacing[4] },
});
