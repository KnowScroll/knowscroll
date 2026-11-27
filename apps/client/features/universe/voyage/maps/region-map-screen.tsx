import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, universe } from '@knowscroll/design-tokens';
import type { AvailableRegionPreview, RegionPreviewState } from '@knowscroll/client-core';
import type { ChartedCell, SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { Button, Icon, Text, useDisplay, useFocusRing } from '@knowscroll/ui';
import { FlatPlanet } from './flat-planet';
import { MapFrame } from './map-frame';
import { MapHeader } from './map-header';
import { cropOf, WHOLE_BAND, BAND_ASPECT, type Size } from './map-layout';
import type { PlanetPalette } from '../../planet/planet-palette';
import { useFlatPlanet, type FlatPlanetWorld } from './use-flat-planet';
import { useRegionEncounter, type RegionChoice, type RegionEncounterOptions } from './use-region-encounter';

export interface RegionMapScreenProps {
  /** Keeps the planet's built world between screens (the Universe session). */
  readonly session: object;
  readonly planet: SceneDescriptor;
  /** The planet's formed regions, for the planet's plan and for the others the map shows faded. */
  readonly regions: readonly SceneDescriptor[];
  readonly looks: ReadonlyMap<string, SceneLook>;
  /** The region whose map this is: one of `regions`. */
  readonly region: SceneDescriptor;
  /** The region left through Open, or none. */
  readonly hereId?: string | null | undefined;
  /** The session's read of the region's next encounter (`state.regionPreview`). Looking at it is not an encounter. */
  readonly preview: RegionPreviewState;
  /** Back goes to the map of the planet (true) or to the region's own ground (false): it names the chip. */
  readonly cameFromMap: boolean;
  readonly onBack: () => void;
  /** "Try again": the session reads the preview once more. */
  readonly onRefreshPreview: () => void;
  /**
   * Open: the session's `openRegion(displayed, onReturn, choice)`; true when it began the encounter, false when an
   * earlier one is in the way (the screen then offers to return to it).
   */
  readonly onOpen: (displayed: AvailableRegionPreview, onReturn: () => void, choice: RegionChoice) => boolean;
  /** On the web, the `data-testid` to focus when this screen goes without an encounter opened (the chip that opened the map). */
  readonly restoreFocusTo?: string | undefined;
  /** Whether the Universe is still live, so focus is not restored after it has ended (the session's `read.active`). */
  readonly isLive?: (() => boolean) | undefined;
  /** Goes to `/explore` (the encounter) or `/universe`; the app's router when left out. Only the developer gallery passes one. */
  readonly navigate?: RegionEncounterOptions['navigate'];
}

/**
 * Map 2: one region's own map. The same drawing as the planet's map, cropped to the region (seam-aware: a region by the
 * edge of the band is whole), with the region in colour and the other formed regions faded and unnamed, and land not
 * reached still the one grey. Under it, "Next from here": the one Scroll or Reel the server offers for the region, and
 * the same explanation in the other format when there is one, each with Open (option A of the maps note: the region has
 * no list of contents and no opened state to show, and nothing here counts or hints at what is closed).
 *
 * Looking at the map is not an encounter: the screen reads nothing itself, it shows the session's preview, and only
 * Open starts one.
 */
export function RegionMapScreen({
  session,
  planet,
  regions,
  looks,
  region,
  hereId,
  preview,
  cameFromMap,
  onBack,
  onRefreshPreview,
  onOpen,
  restoreFocusTo,
  isLive,
  navigate,
}: RegionMapScreenProps) {
  const { reducedMotion } = useDisplay();
  const state = useFlatPlanet(session, planet, regions, looks);
  const cell = state.flat?.chart.charted.find((candidate) => candidate.objectId === region.objectId);
  const encounter = useRegionEncounter(preview.preview, onOpen, { restoreFocusTo, isLive, navigate });
  return (
    <MapFrame
      label={`${region.label}, a region of ${planet.label}`}
      header={
        <MapHeader
          backTo={cameFromMap ? `Map of ${planet.label}` : planet.label}
          onBack={onBack}
          kicker={`A region of ${planet.label}`}
          title={region.label}
          hypothetical={region.truthStatus === 'hypothetical'}
        />
      }
      drawing={(size) =>
        state.flat === null ? (
          <View style={size} testID="map-waiting" />
        ) : (
          <Crop
            flat={state.flat}
            palette={state.palette}
            size={size}
            regionId={cell === undefined ? undefined : region.objectId}
            cell={cell}
            hereId={hereId}
            reducedMotion={reducedMotion}
          />
        )
      }
      side={
        <Contents
          preview={preview}
          accent={state.palette.accent}
          encounter={encounter}
          onRefresh={() => {
            encounter.clearBlocked();
            onRefreshPreview();
          }}
        />
      }
    />
  );
}

/** The cropped drawing: the box is worked out once for the region and the drawing's aspect. */
function Crop({
  flat,
  palette,
  size,
  regionId,
  cell,
  hereId,
  reducedMotion,
}: {
  flat: FlatPlanetWorld;
  palette: PlanetPalette;
  size: Size;
  regionId: string | undefined;
  cell: ChartedCell | undefined;
  hereId: string | null | undefined;
  reducedMotion: boolean;
}) {
  const aspect = size.height > 0 ? size.width / size.height : BAND_ASPECT;
  const box = useMemo(() => (cell === undefined ? WHOLE_BAND : cropOf(cell, aspect)), [cell, aspect]);
  return (
    <FlatPlanet
      world={flat.world}
      chart={flat.chart}
      palette={palette}
      names={flat.names}
      size={size}
      box={box}
      {...(regionId === undefined ? {} : { focusId: regionId })}
      hereId={hereId}
      reducedMotion={reducedMotion}
    />
  );
}

/** The card under (or beside) the drawing: cream paper, as the search card is. */
function Contents({
  preview,
  accent,
  encounter,
  onRefresh,
}: {
  preview: RegionPreviewState;
  accent: string;
  encounter: ReturnType<typeof useRegionEncounter>;
  onRefresh: () => void;
}) {
  const displayed = preview.preview;
  return (
    <View style={styles.card} testID="map-contents">
      <Text variant="label" color={content.ink2}>
        Next from here
      </Text>
      {displayed ? (
        <>
          <Text variant="label" color={content.ink2} testID="map-encounter-kind">
            {displayed.encounter.metadata.kind === 'reel' ? 'A Reel' : 'A Scroll'}
          </Text>
          <Text variant="title" heading={2}>
            {displayed.encounter.metadata.title}
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            {displayed.encounter.metadata.summary}
          </Text>
          <OpenRow accent={accent} onPress={() => encounter.open()} />
          {displayed.alternate ? (
            // The other format takes its own row, so Open keeps the whole width on the narrowest phone.
            <Button
              testID="map-alternate"
              label={displayed.alternate.metadata.kind === 'reel' ? 'Watch as a Reel' : 'Read as a Scroll'}
              variant="ghost"
              onPress={() => encounter.open('alternate')}
            />
          ) : null}
        </>
      ) : (
        <>
          <Text variant="bodyS" color={content.ink2} testID="map-preview-note">
            {preview.status === 'loading'
              ? 'Finding an encounter from this region…'
              : preview.reason === 'network'
                ? 'Opens when you’re back online. This place is kept.'
                : 'Encounters from this region aren’t available yet.'}
          </Text>
          {preview.status !== 'loading' ? (
            <Button testID="map-retry" label="Try again" variant="ink" onPress={onRefresh} />
          ) : null}
        </>
      )}
      {encounter.blocked ? (
        <View style={styles.blocked}>
          <Text variant="bodyS" color={content.ink2}>
            An earlier encounter needs attention. Return to it before choosing another.
          </Text>
          <Button label="Return to encounter" variant="ink" onPress={encounter.returnToEncounter} />
        </View>
      ) : null}
    </View>
  );
}

/** The wide "Open" row: the word on the left and the planet's own accent as a small square with an arrow. A button named "Open". */
function OpenRow({ accent, onPress }: { accent: string; onPress: () => void }) {
  const focus = useFocusRing('onDark');
  return (
    <Pressable
      testID="map-open"
      accessibilityRole="button"
      accessibilityLabel="Open"
      onPress={onPress}
      {...focus.props}
      style={[styles.openRow, focus.style]}
    >
      <Text variant="ui" color={universe.paper}>
        Open
      </Text>
      <View style={[styles.openTile, { backgroundColor: accent }]} aria-hidden>
        <Icon name="arrowRight" size={18} color="#04202a" strokeWidth={2.4} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: content.paper,
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    padding: spacing[4],
    gap: spacing[3],
  },
  blocked: { gap: spacing[2] },
  openRow: {
    minHeight: 56,
    borderRadius: radius.pill,
    backgroundColor: universe.ink,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing[5],
    paddingRight: spacing[2],
    cursor: 'pointer' as const,
  },
  openTile: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
