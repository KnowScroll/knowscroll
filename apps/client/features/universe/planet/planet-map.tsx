import { useCallback, useEffect, useMemo, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Svg, { G, Path, Text as SvgText } from 'react-native-svg';
import { fontFamily } from '@knowscroll/design-tokens';
import type { Chart, ChartedCell, MapWorld } from '@knowscroll/scene-core';
import { Text } from '@knowscroll/ui';
import { LandmarkMark, type LandmarkMarker } from '../collection/landmark-mark';
import { BodyTarget, SceneLayer } from '../scene-parts';
import type { UniverseFrame } from '../universe-camera';
import type { Size } from '../universe-layout';
import { boxOfFormed, boxOfLoops, mapView, toScreen, type MapView } from './map-camera';
import { MapClouds, MapLand } from './map-ground';
import type { PlanetPalette } from './planet-palette';
import { loopsToPath } from './svg-paths';
import { useJustDragged } from './use-just-dragged';

/** The design's marker orange: "you were here". */
const HERE_ORANGE = '#ff684c';
const INK = '#15302a';
const CREAM = '#fffdf2';
/** Names closer than this to the top or the bottom of the screen sit under the header or the chips and are not drawn. */
const LABEL_TOP = 96;
const LABEL_BOTTOM = 110;

export interface PlanetMapProps {
  readonly world: MapWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** The names of the formed regions, by id, as they are written on the map. */
  readonly names: ReadonlyMap<string, string>;
  /** What each region is called to assistive technology, and in the "you were here" pill: "Deployment · you were here". */
  readonly accessibleNames: ReadonlyMap<string, string>;
  readonly size: Size;
  readonly frame: UniverseFrame;
  /** The region whose card is open: the camera drops over it and the rest dims. */
  readonly selectedId: string | undefined;
  /** The region left through its card's Open, marked until it is chosen again. */
  readonly hereId: string | undefined;
  readonly reducedMotion: boolean;
  readonly onChoose: (objectId: string) => void;
  /**
   * The map is arriving from the globe ("Enter a world"): the names come in on this opacity and the clouds only
   * on `clouds`, as the design leaves both out of the picture that moves.
   */
  readonly arrival?: { readonly names: Animated.Value; readonly clouds: Animated.Value };
  /** Regions that are hypothetical, so a screen reader hears it (their drawing is the same). */
  readonly hypothetical?: ReadonlySet<string>;
  /** The landmarks standing on this planet, painted on the land (D-089). */
  readonly markers?: readonly LandmarkMarker[];
}

/** The chosen region keeps its colour under a white glow and everything else dims. */
function Spotlight({ cell, scale }: { cell: ChartedCell; scale: number }) {
  const outline = loopsToPath(cell.loops);
  return (
    <>
      <Path d={`M-400 -400H800V1300H-400Z${outline}`} fill="#03121e" opacity={0.42} fillRule="evenodd" />
      <Path d={outline} fill="none" stroke="#ffffff" strokeWidth={9 / scale} opacity={0.18} strokeLinejoin="round" />
      <Path d={outline} fill="none" stroke="#ffffff" strokeWidth={5 / scale} opacity={0.35} strokeLinejoin="round" />
      <Path d={outline} fill="none" stroke="#ffffff" strokeWidth={3 / scale} strokeLinejoin="round" />
    </>
  );
}

/** A region's name in screen space: ink on a cream edge, so it never scales with the camera. */
function ScreenName({ x, y, text, opacity = 1 }: { x: number; y: number; text: string; opacity?: number }) {
  const common = {
    x,
    y: y + 5,
    fontFamily: fontFamily.display,
    fontWeight: '800' as const,
    fontSize: 15,
    textAnchor: 'middle' as const,
  };
  return (
    <G opacity={opacity}>
      <SvgText {...common} fill="none" stroke={CREAM} strokeWidth={5} strokeLinejoin="round">
        {text}
      </SvgText>
      <SvgText {...common} fill={INK}>
        {text}
      </SvgText>
    </G>
  );
}

const pillWidth = (text: string) => Math.ceil(text.length * 7.6 + 44);

/** The orange dot of "you were here", with a ripple unless motion is reduced. */
function HereMarker({ x, y, reducedMotion }: { x: number; y: number; reducedMotion: boolean }) {
  const [ripple] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) {
      ripple.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ripple, {
        toValue: 1,
        duration: 2600,
        easing: (t) => 1 - (1 - t) * (1 - t),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, ripple]);
  return (
    <View pointerEvents="none" style={[styles.marker, { left: x - 13, top: y - 13 }]}>
      <Animated.View
        style={[
          styles.ripple,
          {
            opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
            transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.4] }) }],
          },
        ]}
      />
      <View style={styles.markerDot}>
        <View style={styles.markerCore} />
      </View>
    </View>
  );
}

/** A cream pill beside a region's name: "Deployment · you were here". */
function HerePill({ x, y, text, width }: { x: number; y: number; text: string; width: number }) {
  const clamped = Math.min(width - pillWidth(text) / 2 - 14, Math.max(pillWidth(text) / 2 + 14, x));
  return (
    <View
      pointerEvents="none"
      style={[styles.herePill, { left: clamped - pillWidth(text) / 2, top: y - 15, width: pillWidth(text) }]}
    >
      <View style={styles.hereDot} />
      <Text variant="uiS" color={INK} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** Screen position of each charted region's name, and the camera that frames the map. */
function layOut(
  chart: Chart,
  size: Size,
  frame: UniverseFrame,
  selectedId: string | undefined,
): { readonly view: MapView; readonly spots: ReadonlyMap<string, { x: number; y: number }> } {
  const chosen = selectedId ? chart.charted.find((cell) => cell.objectId === selectedId) : undefined;
  const box = chosen ? boxOfLoops(chosen.loops) : undefined;
  const view = mapView(size, frame, box, boxOfFormed(chart.charted));
  const spots = new Map(chart.charted.map((cell) => [cell.objectId, toScreen(view, cell.label.x, cell.label.y)]));
  return { view, spots };
}

/**
 * U04: the landed map. The planet's regions are irregular cells in colour, each named in screen
 * space; land not reached yet is flat grey under cloud, with no name, no count and no way to choose
 * it (D-078). Choosing a region drops the camera over it and dims the rest. The drawing is hidden
 * from assistive technology: every formed region has a 48 px target with its name, in the same
 * order as the plain list, and the grey has nothing to announce.
 */
export function PlanetMap(props: PlanetMapProps) {
  const { world, chart, palette, names, accessibleNames, size, frame, selectedId, hereId, reducedMotion } = props;
  // A pan that starts on a region and ends over it is not a choice of that region.
  const justDragged = useJustDragged(frame.x, frame.y, frame.scale);
  const choose = useCallback(
    (objectId: string) => {
      if (!justDragged()) props.onChoose(objectId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `props.onChoose` is the one callback of this render.
    [justDragged, props.onChoose],
  );
  const { view, spots } = useMemo(() => layOut(chart, size, frame, selectedId), [chart, size, frame, selectedId]);
  const chosen = selectedId ? chart.charted.find((cell) => cell.objectId === selectedId) : undefined;
  const marked = hereId && !selectedId ? chart.charted.find((cell) => cell.objectId === hereId) : undefined;
  const scale = size.height / 844;
  const safe = selectedId
    ? { top: 112 * scale, bottom: 520 * scale }
    : { top: LABEL_TOP, bottom: size.height - LABEL_BOTTOM };
  const drawn = (cell: ChartedCell): boolean => {
    const at = spots.get(cell.objectId);
    return at !== undefined && at.x > 30 && at.x < size.width - 30 && at.y > safe.top && at.y < safe.bottom;
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View aria-hidden style={StyleSheet.absoluteFill}>
        <Svg width={size.width} height={size.height}>
          <G transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <MapLand world={world} chart={chart} palette={palette} onChoose={choose} />
            {props.markers?.map((marker) => (
              <LandmarkMark key={marker.key} at={marker.at} tier={marker.tier} scale={1.3} />
            ))}
            {chosen ? <Spotlight cell={chosen} scale={view.scale} /> : null}
            {props.arrival ? null : <MapClouds world={world} chart={chart} palette={palette} />}
          </G>
        </Svg>
        {props.arrival ? (
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: props.arrival.clouds }]} pointerEvents="none">
            <Svg width={size.width} height={size.height}>
              <G transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                <MapClouds world={world} chart={chart} palette={palette} />
              </G>
            </Svg>
          </Animated.View>
        ) : null}
        <Animated.View
          style={[StyleSheet.absoluteFill, props.arrival ? { opacity: props.arrival.names } : null]}
          pointerEvents="none"
        >
          <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill} pointerEvents="none">
            {chart.charted.map((cell) => {
              const at = spots.get(cell.objectId);
              if (!at || cell.objectId === selectedId || cell.objectId === marked?.objectId || !drawn(cell))
                return null;
              return (
                <ScreenName
                  key={cell.objectId}
                  x={at.x}
                  y={at.y}
                  text={names.get(cell.objectId) ?? ''}
                  opacity={selectedId ? 0.8 : 1}
                />
              );
            })}
          </Svg>
        </Animated.View>
        {chosen ? (
          <SelectedName at={spots.get(chosen.objectId)} text={names.get(chosen.objectId) ?? ''} width={size.width} />
        ) : null}
        {marked ? (
          <>
            <HereMarker
              x={spots.get(marked.objectId)?.x ?? 0}
              y={(spots.get(marked.objectId)?.y ?? 0) - 22}
              reducedMotion={reducedMotion}
            />
            <HerePill
              x={spots.get(marked.objectId)?.x ?? 0}
              y={(spots.get(marked.objectId)?.y ?? 0) + 14}
              text={accessibleNames.get(marked.objectId) ?? ''}
              width={size.width}
            />
          </>
        ) : null}
      </View>
      <SceneLayer>
        {chart.charted.map((cell) => {
          const at = spots.get(cell.objectId);
          if (!at) return null;
          return (
            <BodyTarget
              key={cell.objectId}
              testID={`universe-focus-${cell.objectId}`}
              x={at.x}
              y={at.y}
              label={accessibleNames.get(cell.objectId) ?? ''}
              kind="region"
              hypothetical={props.hypothetical?.has(cell.objectId) ?? false}
              selected={cell.objectId === selectedId}
              plain
              onPress={() => choose(cell.objectId)}
            />
          );
        })}
      </SceneLayer>
    </View>
  );
}

/** The chosen region's name in the yellow selected pill (the design's U04 card view). */
function SelectedName({ at, text, width }: { at: { x: number; y: number } | undefined; text: string; width: number }) {
  if (!at) return null;
  const pill = Math.ceil(text.length * 8.4 + 26);
  const left = Math.min(width - pill - 14, Math.max(14, at.x - pill / 2));
  return (
    <View pointerEvents="none" style={[styles.selectedPill, { left, top: at.y - 15, width: pill }]}>
      <Text variant="uiS" color="#111111" numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  ripple: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  markerDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: HERE_ORANGE,
    borderWidth: 2.5,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerCore: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#ffffff' },
  herePill: {
    position: 'absolute',
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: INK,
    backgroundColor: CREAM,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  hereDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: HERE_ORANGE },
  selectedPill: {
    position: 'absolute',
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: INK,
    backgroundColor: '#FFE44D',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
});
