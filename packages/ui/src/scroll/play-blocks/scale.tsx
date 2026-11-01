import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Polygon, Text as SvgText } from 'react-native-svg';
import { borderWidth, content, fontFamily, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';
import { tickLabel } from '../blocks/chart/scales';
import { describeScale, type ScaleBlock } from '../model';
import { openingZoom, scaleView, zoomStops } from './scale-geometry';

const WIDTH = 320;
const HEIGHT = 150;
const AXIS_Y = 92;
const LEFT = 24;
const RIGHT = WIDTH - 24;
const INK = content.ink;
const MUTED = content.muted;
const BLUE = content.accent;

/** Where a point sits along the axis, in the picture's units. */
const xOf = (fraction: number): number => LEFT + (RIGHT - LEFT) * fraction;

function ZoomChip({
  label,
  on,
  onPress,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Zoom out to ${label}`}
      aria-pressed={on}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : null, focus.style]}
    >
      <Text variant="uiS" color={on ? content.paper : content.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A scale (D-207): the points on one line, linear or logarithmic, "you are here" marked, and chips to
 * zoom out to each point in turn. Every value is a figure of the cited passages; the axis, the ticks and
 * the views are worked out from them here. The text version lists the points from smallest to largest.
 */
export function ScaleBody({ scale, asText }: { readonly scale: ScaleBlock; readonly asText: boolean }) {
  const stops = zoomStops(scale);
  const [zoom, setZoom] = useState(() => openingZoom(scale));
  if (asText)
    return (
      <Text variant="body" testID="scale-text">
        {describeScale(scale)}
      </Text>
    );
  const view = scaleView(scale, stops[zoom]?.shown ?? scale.points.length);
  const here = scale.here === undefined ? undefined : scale.points[scale.here];
  return (
    <View style={styles.body}>
      <View
        style={styles.picture}
        role="img"
        aria-label={describeScale(scale)}
        accessibilityLabel={describeScale(scale)}
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} aria-hidden>
          <Line x1={LEFT} y1={AXIS_Y} x2={RIGHT} y2={AXIS_Y} stroke={INK} strokeWidth={2.5} />
          {view.axis.ticks.map((tick) => {
            const x = xOf(view.axis.at(tick));
            return (
              <G key={tick}>
                <Line x1={x} y1={AXIS_Y - 4} x2={x} y2={AXIS_Y + 4} stroke={INK} strokeWidth={1.5} />
                <SvgText
                  x={x}
                  y={AXIS_Y + 18}
                  fontSize={10}
                  fontFamily={fontFamily.mono}
                  fill={MUTED}
                  textAnchor="middle"
                >
                  {tickLabel(tick)}
                </SvgText>
              </G>
            );
          })}
          <SvgText x={RIGHT} y={AXIS_Y + 34} fontSize={10} fontFamily={fontFamily.mono} fill={MUTED} textAnchor="end">
            {`${scale.unit}${scale.axis === 'log' ? ' (each tick ×10)' : ''}`}
          </SvgText>
          {view.points.map((point, index) => {
            const x = xOf(view.axis.at(point.value));
            const isHere = point === here;
            const row = index % 2;
            const labelY = AXIS_Y - 34 - row * 16;
            const anchor = x < 60 ? 'start' : x > WIDTH - 60 ? 'end' : 'middle';
            return (
              <G key={point.label}>
                <Line x1={x} y1={AXIS_Y} x2={x} y2={labelY + 4} stroke={isHere ? BLUE : INK} strokeWidth={1.2} />
                {isHere ? (
                  <Polygon
                    points={`${String(x - 6)},${String(AXIS_Y - 24)} ${String(x + 6)},${String(AXIS_Y - 24)} ${String(x)},${String(AXIS_Y - 13)}`}
                    fill={BLUE}
                    stroke={INK}
                    strokeWidth={1.5}
                  />
                ) : null}
                <Circle
                  cx={x}
                  cy={AXIS_Y}
                  r={isHere ? 8 : 6}
                  fill={isHere ? BLUE : content.paper}
                  stroke={INK}
                  strokeWidth={2.5}
                />
                <SvgText
                  x={x}
                  y={labelY}
                  fontSize={11}
                  fontFamily={fontFamily.mono}
                  fill={isHere ? BLUE : INK}
                  textAnchor={anchor}
                >
                  {point.label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
      {here === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {`You are here: ${here.label}.`}
        </Text>
      )}
      <View style={styles.zoom} role="group" aria-label="Zoom out">
        <Text variant="label" color={content.ink2}>
          Zoom out
        </Text>
        {stops.map((stop, index) => (
          <ZoomChip key={stop.label} label={stop.label} on={zoom === index} onPress={() => setZoom(index)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  picture: { alignSelf: 'stretch', aspectRatio: WIDTH / HEIGHT },
  zoom: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  chip: {
    minHeight: 40,
    paddingHorizontal: spacing[3],
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  chipOn: { backgroundColor: content.ink },
});
